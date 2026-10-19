/**
 * Close an open perp position through the app's own UI (same Privy-signed route as perp-ui-order.mjs).
 *
 * The position row in the bottom panel carries a close control: [aria-label="Close <MARKET> position"].
 * Clicking it opens a close dialog; this script reads the dialog and, with --submit, confirms it.
 *
 *   node perp-ui-close.mjs                        # show the position row + the close dialog, click nothing
 *   node perp-ui-close.mjs --market BTC-PERP --submit
 *   node perp-ui-close.mjs --submit --all         # close every open position on the venue
 *
 * Prints a machine-readable POSITION/POSITION_CLOSED line so a caller can log the fill.
 */
import { chromium } from 'playwright';
import { readPositions } from './lib/ui-read.mjs';

const CDP = process.env.MM_CDP ?? 'http://127.0.0.1:9222';
const APP = 'https://app.testnet.dreamdex.io';

const argv = process.argv.slice(2);
const flag = (n, d = null) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] ?? true : d);
const REGION = flag('region', 'tokyo');
const MARKET = flag('market', 'BTC-PERP');
const SUBMIT = argv.includes('--submit');
const ALL = argv.includes('--all');

const browser = await chromium.connectOverCDP(CDP, { timeout: 90000 });
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith(APP)) ?? (await ctx.newPage());

async function closeOne(market) {
  const btn = page.locator(`[aria-label="Close ${market} position"]`).first();
  if (!(await btn.count())) { console.log(`CLOSE_SKIP ${market} (no position row)`); return false; }
  await btn.click();
  await page.waitForTimeout(5000);

  const dialog = page.locator('[role="dialog"]').first();
  if (!(await dialog.count())) {
    console.log(`CLOSE_NO_DIALOG ${market} — the row closed it directly, or the dialog is not a role=dialog`);
    await page.waitForTimeout(6000);
    return true;
  }
  // The preview computes asynchronously; without this poll "Net" is often still "—" at read time,
  // which is how a fill gets logged with an unknown PnL.
  let text = '';
  for (let i = 0; i < 15; i++) {
    text = (await dialog.innerText()).replace(/\n+/g, ' | ');
    if (/Net\s*\|?\s*[+-]?[\d,.]+\s*USDso/i.test(text)) break;
    await page.waitForTimeout(1500);
  }
  console.log(`CLOSE_DIALOG ${market}: ${text.slice(0, 400)}`);
  const net = /Net\s*\|?\s*([+-]?[\d,.]+)\s*USDso/i.exec(text);
  console.log(`CLOSE_NET ${market} ${net ? net[1].replace(/,/g, '') : 'unknown'}`);

  // Footer reads: Cancel | Close position | Close — the labelled action is the submit, not the bare "Close".
  const confirm = dialog.getByRole('button', { name: /^\s*close position\s*$/i }).first()
    .or(dialog.getByRole('button', { name: /^\s*close\s*$/i })).first();
  if (!SUBMIT) { console.log('CLOSE_DRY  (not submitted; add --submit)'); return false; }
  if (!(await confirm.count())) {
    const labels = await dialog.locator('button').allInnerTexts();
    console.log(`CLOSE_NO_CONFIRM ${market} buttons=${JSON.stringify(labels.slice(0, 8))}`);
    return false;
  }
  await confirm.click();
  await page.waitForTimeout(9000);
  const gone = await page.locator(`[aria-label="Close ${market} position"]`).count();
  console.log(`CLOSE_${gone === 0 ? 'OK' : 'UNCONFIRMED'} ${market}`);
  return gone === 0;
}

console.log(`navigate ${APP}/trade/perps/${REGION}/${MARKET}`);
// --no-nav: the caller (arena-bot) already has this market loaded; re-navigating only makes the app
// re-hydrate and the close dialog slower to appear.
if (argv.includes('--no-nav')) console.log('skipped (--no-nav)');
else await page.goto(`${APP}/trade/perps/${REGION}/${MARKET}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(9000);

let positions = await readPositions(page);
console.log(`POSITIONS ${JSON.stringify(positions)}`);
if (!positions.length) { console.log('flat: nothing to close'); process.exit(0); }

const targets = ALL ? positions.map((p) => p.market) : [MARKET];
for (const m of targets) {
  await closeOne(m);
  await page.waitForTimeout(4000);
  console.log(`AFTER ${m}: ${JSON.stringify(await readPositions(page))}`);
}
process.exit(0);
