/**
 * Attach a venue-side TP/SL to an open position through the app's own `Set TP/SL` dialog.
 *
 * The dialog is the Privy-signed path, so this works on Hideki where a locally signed Safe
 * execTransaction reverts GS026. Percentages are PRICE MOVE percents — the same quantity the dialog's
 * gain/loss boxes take, calibrated against the app's own estimate readout, and the same quantity
 * `arena-bot.mjs --tp-roi/--stop-roi` already derives. Do not convert twice.
 *
 *   node perp-ui-tpsl.mjs --pair XRP-PERP --tp 0.5 --sl 0.3 --submit
 *   node perp-ui-tpsl.mjs --tp 0.5                 # single open position, dry run
 *
 * Prints `TPSL_SET <pair> tp=<pct> sl=<pct> submitted=<bool>`. Attaching both legs links them on the
 * venue ("when either one executes, the other is cancelled"), which is the intended behaviour.
 */
import { connectApp, gotoMarket, readPositions } from './lib/ui-read.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] ?? d : d);
const SUBMIT = argv.includes('--submit');
const NO_NAV = argv.includes('--no-nav'); // caller already parked the shared tab on this market
const REGION = String(flag('region', 'tokyo'));
const TP = flag('tp', null);
const SL = flag('sl', null);
const PAIR = flag('pair', null);
const SEL = '[aria-label="Set TP/SL"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INDEXER = 'https://hideki-dev.smk.somnia.host/v1/graphql';

/**
 * A click that lands is not an attach. The dialog says nothing useful on success, so ask the indexer:
 * a StopOrder row for this market, created since the dialog opened, is the only proof the venue took it.
 */
async function verifyOnChain(pair, since) {
  const q =
    '{ StopOrder(order_by: {createdAt: desc}, limit: 10) { id owner createdAt status triggerPrice siblingOrderId placedOrderId market { baseSymbol } } }';
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
  const rows = (await r.json())?.data?.StopOrder ?? [];
  const base = String(pair).split('-')[0].toUpperCase();
  const hit = rows.find((x) => String(x.market?.baseSymbol ?? '').toUpperCase() === base && Date.parse(x.createdAt) >= since);
  return { verified: Boolean(hit), row: hit ?? null, scanned: rows.length };
}

const { page } = await connectApp();

// The Positions panel renders two variants of every row: a table row (which carries the
// `Set TP/SL` control) and a card (which carries only Share and Close). The table row is hidden
// below roughly 1536px, so at the default 1280px window the TP/SL control exists in the DOM but
// has a 0x0 box and every click through it fails with `no bounding box for locator`.
// Force a desktop width before navigating, and re-apply it after navigation in case the override
// is dropped on load.
await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});

/**
 * Click by viewport coordinates. Locator.click() is refused on these custom inputs — they wrap the
 * real target, so Playwright reports a child intercepting pointer events and never fires.
 */
async function clickCentre(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no bounding box for locator');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const dialogText = () =>
  page.evaluate(() => (document.querySelector('[role="dialog"]')?.innerText || '').replace(/\s+/g, ' ').trim());

async function closeDialog() {
  for (let i = 0; i < 3 && (await page.locator('[role="dialog"]').count()); i++) {
    await page.keyboard.press('Escape');
    await sleep(350);
  }
  return (await page.locator('[role="dialog"]').count()) === 0;
}

let pair = PAIR;
if (!pair) {
  const open = (await readPositions(page)).filter((p) => p.closable);
  if (open.length !== 1) {
    console.log(`TPSL_SKIP need exactly one open position, found ${open.length}`);
    process.exit(0);
  }
  pair = open[0].market;
}
if (!NO_NAV && !page.url().includes(`/trade/perps/${REGION}/${pair}`)) await gotoMarket(page, pair, REGION);
// Re-assert the desktop width: the override can be dropped by a full page load.
await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});

// The positions table lists EVERY open position, so `[aria-label="Set TP/SL"]` matches one control
// per row. `.first()` therefore opens whichever row happens to sort first, not the requested pair —
// which is how an earlier run opened the NEAR dialog while being asked for LIT. Tag the control
// inside the row that actually names `pair`, then click that one.
async function tagPairButton(wanted) {
  return page.evaluate((want) => {
    document.querySelectorAll('[data-tpsl-target]').forEach((n) => n.removeAttribute('data-tpsl-target'));
    let best = null;
    let bestLen = Infinity;
    for (const b of document.querySelectorAll('[aria-label="Set TP/SL"]')) {
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Walk up, but keep only the TIGHTEST ancestor whose text names the pair. Stopping at the first
      // match would tag a button in the shared table container, which names every pair — that is how
      // a run asked for LIT ended up setting triggers on NEAR.
      let row = b.parentElement;
      let tight = null;
      for (let i = 0; i < 10 && row; i++) {
        const text = row.innerText || '';
        if (text.includes(want) && text.length < 250 && text.length < bestLen) {
          tight = { node: b, len: text.length };
        }
        row = row.parentElement;
      }
      if (tight && tight.len < bestLen) {
        best = tight.node;
        bestLen = tight.len;
      }
    }
    if (!best) return false;
    best.setAttribute('data-tpsl-target', '1');
    return true;
  }, wanted);
}

const TARGET = '[data-tpsl-target="1"]';
if (pair) await tagPairButton(pair);
const btn = page.locator(TARGET).first();
if (!(await btn.count())) {
  // A leg that filled seconds ago is not in the positions table yet. Give it time, then fall back to a
  // fresh navigation: the table always renders on a clean load, but a reused tab can be mid-render.
  for (let i = 0; i < 4 && !(await page.locator(TARGET).count()); i++) await sleep(2500);
  if (!(await page.locator(TARGET).count())) {
    await gotoMarket(page, pair, REGION).catch(() => {});
    await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
    await tagPairButton(pair);
    for (let i = 0; i < 8 && !(await page.locator(TARGET).count()); i++) await sleep(2500);
  }
}
if (!(await btn.count())) {
  console.log(`TPSL_SKIP no Set TP/SL control for ${pair} — is a position open?`);
  process.exit(0);
}

let submitted = false;
let verified = null; // proof from the indexer, never from the click
try {
  await clickCentre(btn);
  const openedAt = Date.now();
  await sleep(900);

  const box = page.locator('[role="dialog"] section[aria-label="Protection group"]');
  if (!(await box.count())) throw new Error('protection group missing from the dialog');

  // `Entire Position` is already aria-pressed, but pin it rather than inherit whatever the last use left
  const entire = page.locator('[role="dialog"] [role="group"][aria-label="Trigger size"] button').first();
  if (await entire.count()) await clickCentre(entire);

  const rows = box.locator(':scope > section');
  // Each row holds two [data-slot="input"] boxes: a USDso price box, then the percent box.
  for (const [i, pct] of [
    [0, TP],
    [1, SL],
  ]) {
    if (pct === null) continue;
    const inputs = rows.nth(i).locator('[data-slot="input"]');
    const n = await inputs.count();
    if (n < 2) throw new Error(`row ${i} has ${n} input boxes, expected 2`);
    await clickCentre(inputs.nth(n - 1));
    await page.keyboard.type(String(pct), { delay: 80 });
    await sleep(600);
  }

  // The action button relabels by state — `Set trigger` while the form is incomplete, `Set TP / SL`
  // once it is armed. Match the whole known set, or an armed dialog reads as a missing button.
  const ACTION = /set trigger|set tp\s*\/?\s*sl/i;
  const state = await page.evaluate(
    (actionSource) => {
      const rx = new RegExp(actionSource, 'i');
      const dlg = document.querySelector('[role="dialog"]');
      const buttons = [...(dlg?.querySelectorAll('button') ?? [])].map((el) => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        disabled: el.disabled,
      }));
      const b = buttons.find((el) => rx.test(el.text));
      return { disabled: b ? b.disabled : 'not-found', buttons, text: (dlg?.innerText || '').replace(/\s+/g, ' ').trim() };
    },
    ACTION.source,
  );
  const profit = /Estimated profit ([+\-\d.]+) USDso/.exec(state.text)?.[1] ?? null;
  const loss = /Estimated loss ([+\-\d.]+) USDso/.exec(state.text)?.[1] ?? null;
  console.log(`TPSL_PREVIEW ${pair} tp=${TP} sl=${SL} est_profit=${profit} est_loss=${loss} submit_button_disabled=${state.disabled}`);
  console.log('TPSL_BUTTONS ' + JSON.stringify(state.buttons));

  if (SUBMIT) {
    if (state.disabled !== false) throw new Error(`Set trigger is not armed (disabled=${state.disabled}) — values rejected`);
    const trigger = page.locator('[role="dialog"] button').filter({ hasText: ACTION }).first();
    await clickCentre(trigger);
    submitted = true;
    await sleep(4000);
    const post = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const dlg = document.querySelector('[role="dialog"]');
      const modals = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-sonner-toast],[role="status"]')].map(
        (el) => clean(el.innerText).slice(0, 300),
      );
      return { dialog: clean(dlg?.innerText || '').slice(0, 900), modals };
    });
    console.log('TPSL_POST_SUBMIT ' + JSON.stringify(post, null, 1));
    const v = await verifyOnChain(pair, openedAt);
    verified = v.verified;
    console.log('TPSL_VERIFIED ' + JSON.stringify(v).slice(0, 400));
  } else {
    console.log('TPSL_DRY_RUN nothing submitted');
  }
} catch (e) {
  console.log(`TPSL_ERROR ${String(e.message).slice(0, 200)}`);
} finally {
  const closed = await closeDialog();
  console.log(`TPSL_RESULT ${pair} tp=${TP} sl=${SL} submitted=${submitted} verified=${verified} dialog_closed=${closed}`);
}

process.exit(0);
