#!/usr/bin/env node
/**
 * carrydesk — funding-aware perps position manager for dreamDEX.
 *
 * Commands:
 *   doctor            check the indexer, the account, and the execution adapters
 *   scan              rank every perp market by realised funding carry
 *   status            current book: positions, carry attribution, exposure, margin buffer
 *   plan              what the tool would do next (no writes)
 *   run [--live]      execute one cycle; dry run unless --live
 *   report            summarise the ledger
 *
 * Reads come from the indexer. Writes go through the app's order ticket, because on Somnia Tokyo
 * testnet the local key is not an owner of the smart wallet and a locally signed Safe transaction
 * reverts GS026.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, pairOf } from './config.mjs';
import {
  fetchFundingCandles,
  fetchFundingPayments,
  fetchMarkets,
  fetchPositions,
  gql,
} from './indexer.mjs';
import { rankCandidates, summariseFunding, dailyCarry } from './funding.mjs';
import {
  drawdownTripped,
  exposureOf,
  notionalOf,
  reviewBook,
  shockBufferPct,
  unrealisedPnl,
} from './risk.mjs';
import { buildPlan } from './planner.mjs';
import {
  closePosition,
  openPosition,
  setProtection,
  spacing,
} from './executor.mjs';
import { readLedger, record, summariseLedger } from './ledger.mjs';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flag = (n, d = null) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] ?? true : d);
const has = (n) => argv.includes(`--${n}`);

const LIVE = has('live');
const JSON_OUT = has('json');

// ---------------------------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------------------------

const h = (s) => `\n${s}\n${'-'.repeat(Math.max(s.length, 24))}`;
const n2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const pad = (v, w) => String(v).padEnd(w);
const padL = (v, w) => String(v).padStart(w);

function table(rows, cols) {
  if (!rows.length) return '  (none)';
  const widths = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.get(r)).length)));
  const head = cols.map((c, i) => pad(c.h, widths[i])).join('  ');
  const body = rows.map((r) => cols.map((c, i) => pad(c.get(r), widths[i])).join('  ')).join('\n');
  return `  ${head}\n  ${body}`;
}

// ---------------------------------------------------------------------------------------------
// data helpers
// ---------------------------------------------------------------------------------------------

async function loadUniverse() {
  const [markets, candles] = await Promise.all([fetchMarkets(), fetchFundingCandles()]);
  const summaries = summariseFunding(candles);
  const ranked = rankCandidates(summaries, markets, { minCarryPct: CONFIG.minCarryPct });
  return { markets, candles, summaries, ranked };
}

/**
 * Account equity and free margin are not on the indexer — the app reads them from the venue's
 * account API. Rather than duplicate that call, this runs the account adapter, which reads the same
 * numbers the app renders through the signed-in browser session.
 *
 * `--equity` / `--free-margin` override it, so a plan can be produced offline.
 */
async function loadAccount() {
  const equityFlag = flag('equity');
  const freeFlag = flag('free-margin');
  if (equityFlag) {
    return {
      equity: Number(equityFlag),
      freeMargin: Number(freeFlag ?? equityFlag),
      source: 'flags',
      realisedPnl: 0,
    };
  }

  if (!CONFIG.account) {
    throw new Error(
      'no account: set DD_ACCOUNT to the smart wallet address, or pass --equity and --free-margin',
    );
  }

  try {
    const { stdout } = await run(
      process.execPath,
      [`${CONFIG.workspace}/read-account.mjs`, '--region', CONFIG.region],
      { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    const parsed = JSON.parse(line);
    if (!(parsed.equity > 0)) throw new Error(parsed.reason ?? 'account panel did not render');
    return {
      equity: Number(parsed.equity),
      // `Available to trade` is what the venue will actually let a new order consume.
      freeMargin: Number(parsed.available ?? 0),
      source: 'adapters/read-account.mjs',
      realisedPnl: 0,
    };
  } catch (err) {
    throw new Error(
      `could not read the account (${String(err.message).split('\n')[0]}). ` +
        'Pass --equity <n> --free-margin <n> to plan offline.',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

async function cmdDoctor() {
  const out = { indexer: 'unknown', markets: 0, positions: 0, adapters: {} };
  try {
    await gql('{ __typename }');
    out.indexer = 'ok';
  } catch (err) {
    out.indexer = `FAILED: ${String(err.message).slice(0, 120)}`;
  }
  try {
    out.markets = (await fetchMarkets()).length;
  } catch { /* reported above */ }
  try {
    out.positions = (await fetchPositions(CONFIG.account)).length;
  } catch (err) {
    out.positions = `n/a (${String(err.message).slice(0, 80)})`;
  }
  for (const name of ['perp-ui-order.mjs', 'perp-ui-close.mjs', 'perp-ui-tpsl.mjs']) {
    try {
      await execFilePromise('test', ['-f', `${CONFIG.workspace}/${name}`]);
      out.adapters[name] = 'present';
    } catch {
      out.adapters[name] = 'MISSING';
    }
  }

  if (JSON_OUT) return console.log(JSON.stringify(out, null, 2));
  console.log(h('doctor'));
  console.log(`  chain          : ${CONFIG.chainId} (${CONFIG.region})`);
  console.log(`  indexer        : ${out.indexer}`);
  console.log(`  perp markets   : ${out.markets}`);
  console.log(`  open positions : ${out.positions}`);
  console.log(`  account        : ${CONFIG.account || '(unset)'}`);
  for (const [k, v] of Object.entries(out.adapters)) console.log(`  adapter ${pad(k, 22)}: ${v}`);
}

const execFilePromise = promisify(execFile);

async function cmdScan() {
  const { ranked, summaries } = await loadUniverse();

  if (JSON_OUT) {
    return console.log(
      JSON.stringify(
        ranked.map((r) => ({
          base: r.market.base,
          pair: pairOf(r.market.base),
          side: r.side,
          mark: r.market.mark,
          annualPct: r.expectedAnnualPct,
          rate8h: r.rate8h,
          consistency: r.consistency,
          coveredHours: r.coveredHours,
          marketId: r.market.id,
        })),
        null,
        2,
      ),
    );
  }

  console.log(h(`scan — ${CONFIG.lookbackDays}d realised funding, floor ${CONFIG.minCarryPct}%/yr`));
  console.log(
    table(ranked, [
      { h: 'PAIR', get: (r) => pairOf(r.market.base) },
      { h: 'SIDE', get: (r) => r.side },
      { h: 'MARK', get: (r) => n2(r.market.mark, 4) },
      { h: 'CARRY/yr', get: (r) => `${n2(r.expectedAnnualPct, 2)}%` },
      { h: 'RATE/8h', get: (r) => `${n2(r.rate8h * 100, 4)}%` },
      { h: 'CONSIST', get: (r) => `${n2(r.consistency * 100, 0)}%` },
      { h: 'HOURS', get: (r) => n2(r.coveredHours, 0) },
    ]),
  );
  console.log(
    `\n  ${ranked.length} of ${summaries.length} markets cleared the floor. ` +
      'A positive rate means longs pay shorts, so the book shorts a positive-carry market.',
  );
  await record({ event: 'scan', candidates: ranked.length, top: ranked.slice(0, 5).map((r) => r.market.base) });
}

async function cmdStatus() {
  const account = await loadAccount();
  const [positions, markets, candles, payments] = await Promise.all([
    fetchPositions(CONFIG.account),
    fetchMarkets(),
    fetchFundingCandles(),
    fetchFundingPayments(CONFIG.account).catch(() => []),
  ]);
  const ranked = rankCandidates(summariseFunding(candles), markets, { minCarryPct: CONFIG.minCarryPct });
  const exposure = exposureOf(positions);
  const review = reviewBook(positions, ranked, CONFIG);
  const upnl = positions.reduce((s, p) => s + unrealisedPnl(p), 0);
  const funding = payments.reduce((s, p) => s + p.amount, 0);

  if (JSON_OUT) {
    return console.log(
      JSON.stringify(
        { account, exposure, positions, review, unrealisedPnl: upnl, fundingReceived: funding },
        null,
        2,
      ),
    );
  }

  console.log(h(`status — ${CONFIG.chainId} ${CONFIG.region}`));
  console.log(`  equity          : ${n2(account.equity)} ${markets[0]?.quote ?? 'USDso'}`);
  console.log(`  free margin     : ${n2(account.freeMargin)}`);
  console.log(`  gross exposure  : ${n2(exposure.gross)}  (${n2((exposure.gross / account.equity) * 100, 0)}% of equity)`);
  console.log(`  net exposure    : ${n2(exposure.net)}`);
  console.log(`  unrealised PnL  : ${n2(upnl)}`);
  console.log(`  funding received: ${n2(funding)} (${CONFIG.lookbackDays}d)`);
  console.log(`  shock buffer    : ${n2(shockBufferPct(positions, account.equity), 1)}%`);

  console.log(h('positions'));
  console.log(
    table(
      review.map((r) => ({ ...r.position, carryPct: r.carryPct, verdict: r.type })),
      [
        { h: 'PAIR', get: (p) => pairOf(p.base) },
        { h: 'SIDE', get: (p) => (p.qty >= 0 ? 'long' : 'short') },
        { h: 'QTY', get: (p) => n2(Math.abs(p.qty), 6) },
        { h: 'ENTRY', get: (p) => n2(p.entry, 4) },
        { h: 'MARK', get: (p) => n2(p.mark, 4) },
        { h: 'NOTIONAL', get: (p) => n2(notionalOf(p), 2) },
        { h: 'uPnL', get: (p) => n2(unrealisedPnl(p), 2) },
        { h: 'CARRY/yr', get: (p) => `${n2(p.carryPct, 2)}%` },
        { h: 'ACTION', get: (p) => p.verdict },
      ],
    ),
  );
  await record({ event: 'status', equity: account.equity, gross: exposure.gross, positions: positions.length });
}

async function cmdPlan() {
  const [{ ranked }, account, positions] = await Promise.all([
    loadUniverse(),
    loadAccount(),
    fetchPositions(CONFIG.account),
  ]);
  const plan = buildPlan({
    ranked,
    positions,
    equity: account.equity,
    freeMargin: account.freeMargin,
    config: CONFIG,
  });

  if (JSON_OUT) return console.log(JSON.stringify(plan, null, 2));

  console.log(h('plan'));
  console.log(`  equity ${n2(account.equity)}  free margin ${n2(account.freeMargin)}`);
  console.log(`  slots ${CONFIG.maxPositions}  gross cap ${CONFIG.grossExposurePct}%  per-position cap ${CONFIG.maxPositionPct}%`);

  console.log(h('open'));
  console.log(
    table(plan.opens, [
      { h: 'PAIR', get: (o) => o.pair },
      { h: 'SIDE', get: (o) => o.side },
      { h: 'NOTIONAL', get: (o) => n2(o.notional, 2) },
      { h: 'CARRY/yr', get: (o) => `${n2(o.carryPct, 2)}%` },
      { h: 'DAILY', get: (o) => n2(o.dailyCarry, 4) },
    ]),
  );

  console.log(h('keep'));
  console.log(
    table(plan.keeps.map((k) => ({ ...k.position, carryPct: k.carryPct, daily: k.dailyCarry })), [
      { h: 'PAIR', get: (p) => pairOf(p.base) },
      { h: 'SIDE', get: (p) => (p.qty >= 0 ? 'long' : 'short') },
      { h: 'NOTIONAL', get: (p) => n2(notionalOf(p), 2) },
      { h: 'CARRY/yr', get: (p) => `${n2(p.carryPct, 2)}%` },
      { h: 'DAILY', get: (p) => n2(p.daily, 4) },
    ]),
  );

  console.log(h('close'));
  console.log(
    table(plan.closes, [
      { h: 'PAIR', get: (c) => c.pair },
      { h: 'NOTIONAL', get: (c) => n2(c.notional, 2) },
      { h: 'REASON', get: (c) => c.reason },
    ]),
  );

  if (plan.skipped.length) {
    console.log(h('skipped'));
    console.log(table(plan.skipped, [
      { h: 'MARKET', get: (s) => s.base },
      { h: 'REASON', get: (s) => s.reason },
    ]));
  }

  await record({ event: 'plan', opens: plan.opens.length, closes: plan.closes.length });
}

async function cmdRun() {
  if (!LIVE) {
    console.log('dry run — pass --live to place orders\n');
    return cmdPlan();
  }

  const [{ ranked }, account, positions] = await Promise.all([
    loadUniverse(),
    loadAccount(),
    fetchPositions(CONFIG.account),
  ]);

  const plan = buildPlan({
    ranked,
    positions,
    equity: account.equity,
    freeMargin: account.freeMargin,
    config: CONFIG,
  });

  const upnl = positions.reduce((s, p) => s + unrealisedPnl(p), 0);
  if (drawdownTripped(account.realisedPnl, upnl, account.equity, CONFIG)) {
    console.log(h('kill switch'));
    console.log(
      `  PnL ${n2(upnl)} is below -${CONFIG.maxDrawdownPct}% of equity ${n2(account.equity)} — no new positions.`,
    );
    await record({ event: 'halt', reason: 'drawdown', upnl, equity: account.equity });
    return;
  }

  console.log(h(`run — ${CONFIG.chainId} ${CONFIG.region} LIVE`));

  for (const c of plan.closes) {
    const res = await closePosition({ base: c.base, submit: true });
    console.log(`  close ${pad(c.pair, 12)} ${res.ok ? 'ok' : 'FAIL'}  net=${res.net ?? '-'}  ${res.error ?? ''}`);
    await record({ event: 'close', pair: c.pair, ok: res.ok, net: res.net, error: res.error ?? null });
    await spacing();
  }

  for (const o of plan.opens) {
    const res = await openPosition({ base: o.base, side: o.side, notional: o.notional, submit: true });
    console.log(
      `  open  ${pad(o.pair, 12)} ${o.side.padEnd(5)} notional=${n2(o.notional)} ${res.ok ? 'ok' : 'FAIL'}  ${res.error ?? ''}`,
    );
    await record({
      event: 'open',
      pair: o.pair,
      side: o.side,
      notional: o.notional,
      carryPct: o.carryPct,
      dailyCarry: o.dailyCarry,
      ok: res.ok,
      value: res.value,
      margin: res.margin,
      error: res.error ?? null,
    });

    if (res.ok) {
      // Attach protection immediately: an unprotected position on this venue can be liquidated by
      // the next funding-driven wick while the operator is asleep.
      const prot = await setProtection({
        base: o.base,
        tpPct: Number(flag('tp', 3)),
        slPct: Number(flag('sl', 3)),
        submit: true,
      });
      console.log(`        protect ${pad(o.pair, 12)} tp=${flag('tp', 3)}% sl=${flag('sl', 3)}%  ${prot.ok ? 'ok' : 'FAIL'}`);
      await record({ event: 'protect', pair: o.pair, ok: prot.ok, tp: flag('tp', 3), sl: flag('sl', 3) });
    }
    await spacing();
  }

  if (!plan.opens.length && !plan.closes.length) {
    console.log('  nothing to do — the book already matches the plan');
  }
  await record({ event: 'run', opens: plan.opens.length, closes: plan.closes.length, live: true });
}

async function cmdReport() {
  const rows = await readLedger();
  const s = summariseLedger(rows);

  if (JSON_OUT) return console.log(JSON.stringify(s, null, 2));

  console.log(h('report'));
  console.log(`  ledger entries : ${s.total}`);
  console.log(`  opens ok       : ${s.opens.length}`);
  console.log(`  closes ok      : ${s.closes.length}`);
  console.log(`  daily carry    : ${n2(s.carryOpened, 4)} ${'USDso'} (sum of opened positions)`);
  console.log('\n  events:');
  for (const [k, v] of Object.entries(s.counts).sort()) console.log(`    ${pad(k, 14)} ${v}`);

  console.log(h('recent opens'));
  console.log(
    table(s.opens.slice(-10), [
      { h: 'TS', get: (r) => r.ts.slice(0, 19).replace('T', ' ') },
      { h: 'PAIR', get: (r) => r.pair },
      { h: 'SIDE', get: (r) => r.side },
      { h: 'NOTIONAL', get: (r) => n2(r.notional, 2) },
      { h: 'CARRY/yr', get: (r) => `${n2(r.carryPct, 2)}%` },
    ]),
  );
}

function usage() {
  console.log(`carrydesk — funding-aware perps position manager for dreamDEX

  node src/cli.mjs doctor
  node src/cli.mjs scan                    [--json]
  node src/cli.mjs status                  [--json]
  node src/cli.mjs plan                    [--json] [--equity N --free-margin N]
  node src/cli.mjs run                     dry run: prints the plan
  node src/cli.mjs run --live --tp 3 --sl 3
  node src/cli.mjs report                  [--json]

Environment:
  DD_ACCOUNT              smart wallet address (required for status/plan/run)
  DD_INDEXER              indexer GraphQL endpoint
  DD_MIN_CARRY_PCT        annualised floor, default ${CONFIG.minCarryPct}
  DD_MAX_POSITIONS        book slots, default ${CONFIG.maxPositions}
  DD_GROSS_EXPOSURE_PCT   gross cap as % of equity, default ${CONFIG.grossExposurePct}
  DD_MAX_DRAWDOWN_PCT     kill switch, default ${CONFIG.maxDrawdownPct}
  DD_WORKSPACE            directory holding the execution adapters
`);
}

const commands = {
  doctor: cmdDoctor,
  scan: cmdScan,
  status: cmdStatus,
  plan: cmdPlan,
  run: cmdRun,
  report: cmdReport,
  help: usage,
};

if (!commands[cmd]) {
  usage();
  process.exit(1);
}

try {
  await commands[cmd]();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
