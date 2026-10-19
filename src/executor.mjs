/**
 * Execution adapter.
 *
 * Orders on this venue are placed through the app's own order ticket, because the app holds the
 * Privy session that signs for the smart wallet. On the Tokyo chain (50383) the local key is not an
 * owner of that wallet, so a locally signed Safe `execTransaction` reverts with GS026 — the UI route
 * is not a shortcut, it is the only path available to an external bot.
 *
 * The adapters therefore shell out to the driver scripts in the dreamDEX toolbox and parse their
 * machine-readable output lines. Each call is one order: no batching, no retries inside a single
 * call, because a retried click on this ticket can place the order twice.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG, pairOf } from './config.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const script = (name) => `${CONFIG.workspace}/${name}`;

/**
 * Place a market order. `notional` is in USDso — the ticket's native size unit, which its switcher
 * reports as `Switch size unit (currently USDso)`. Passing the notional directly avoids a decimal
 * conversion that differs per market (BTC is 8 decimals, NEAR is 24) and is what the venue's own
 * preview labels as `Order value`.
 */
export async function openPosition({ base, side, notional, market = null, submit = false }) {
  const pair = market ?? pairOf(base);
  const args = [
    script('perp-ui-order.mjs'),
    '--market', pair,
    '--region', CONFIG.region,
    '--side', side,
    '--type', 'market',
    '--unit', 'usdso',
    '--qty', String(notional),
  ];
  if (submit) args.push('--submit');

  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await run(process.execPath, args, {
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseOpenResult({ pair, side, notional, stdout, stderr, submit, startedAt });
  } catch (err) {
    return {
      ok: false,
      pair,
      side,
      notional,
      submitted: false,
      error: String(err.message ?? err).split('\n')[0],
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function parseOpenResult({ pair, side, notional, stdout, stderr, submit, startedAt }) {
  const preview = /ORDER_PREVIEW\s+(\S+)\s+(\S+)\s+(\S+)\s+qty=(\S+)\s+value=(\S+)\s+margin=(\S+)/.exec(stdout);
  const submittedLine = /ORDER_SUBMITTED\s+(\S+)\s+(\S+)\s+(\S+)\s+qty=(\S+)\s+positions=(\S+)/.exec(stdout);
  const armed = /submit\s+"[^"]*"\s+:\s+rendered, disabled=(true|false)/.exec(stdout);

  const rejected = /not armed|rejected by the ticket|never armed|disabled=true/i.test(stdout);

  return {
    ok: submit ? Boolean(submittedLine) && !rejected : Boolean(preview) && !rejected,
    pair,
    side,
    notional,
    submitted: Boolean(submittedLine),
    value: preview ? Number(preview[5]) : null,
    margin: preview ? Number(preview[6]) : null,
    armed: armed ? armed[1] === 'false' : null,
    rejected,
    stdout,
    stderr,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Close an open position by its app label (e.g. BTC-PERP). */
export async function closePosition({ base, market = null, submit = false }) {
  const pair = market ?? pairOf(base);
  const args = [script('perp-ui-close.mjs'), '--market', pair, '--region', CONFIG.region];
  if (submit) args.push('--submit');

  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await run(process.execPath, args, {
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const net = /CLOSE_NET\s+(\S+)\s+(\S+)/.exec(stdout);
    const okLine = /CLOSE_OK\s+(\S+)/.exec(stdout);
    const skipped = /CLOSE_SKIP\s+(\S+)/.exec(stdout);
    return {
      ok: submit ? Boolean(okLine) : Boolean(net),
      pair,
      submitted: Boolean(okLine),
      net: net ? Number(net[2]) : null,
      skipped: Boolean(skipped),
      stdout,
      stderr,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      pair,
      submitted: false,
      error: String(err.message ?? err).split('\n')[0],
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** Attach venue-side TP/SL. Percentages are price-move percentages, not ROI. */
export async function setProtection({ base, tpPct, slPct, market = null, submit = false }) {
  const pair = market ?? pairOf(base);
  const args = [
    script('perp-ui-tpsl.mjs'),
    '--pair', pair,
    '--region', CONFIG.region,
    '--tp', String(tpPct),
    '--sl', String(slPct),
  ];
  if (submit) args.push('--submit');

  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await run(process.execPath, args, {
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const result = /TPSL_RESULT\s+(\S+)\s+tp=(\S+)\s+sl=(\S+)\s+submitted=(\S+)\s+verified=(\S+)/.exec(stdout);
    return {
      ok: result ? result[4] === 'true' : false,
      pair,
      submitted: result ? result[4] === 'true' : false,
      verified: result ? result[5] === 'true' : false,
      stdout,
      stderr,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      pair,
      submitted: false,
      error: String(err.message ?? err).split('\n')[0],
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** Convert a notional in quote currency to the base quantity the ticket expects, rounded down. */
export function baseQtyFor(notional, mark, baseDecimals) {
  if (!(mark > 0)) return 0;
  const raw = notional / mark;
  const factor = 10 ** Math.min(baseDecimals, 8);
  return Math.floor(raw * factor) / factor;
}

/** Pause between orders so the app's ticket and the indexer both settle. */
export async function spacing() {
  await sleep(CONFIG.orderSpacingSec * 1000);
}
