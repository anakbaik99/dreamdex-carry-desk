/**
 * Print the account panel as JSON.
 *
 * Equity and free margin are not exposed by the indexer — they live in the app, which reads them
 * from the venue's account API. Rather than reimplement that call, this adapter reads the same
 * numbers the app renders, through the already-signed-in browser session.
 *
 *   node adapters/read-account.mjs [--region tokyo] [--market BTC-PERP]
 *
 * Output is one JSON object on stdout. Exit code is non-zero if the panel did not render.
 */
import { connectApp, gotoMarket, readAccount } from './lib/ui-read.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] ?? d : d);
const REGION = String(flag('region', process.env.DD_REGION ?? 'tokyo'));
const MARKET = flag('market', 'BTC-PERP');

const { page } = await connectApp();
await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
await gotoMarket(page, MARKET, REGION);
await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});

let account = null;
for (let i = 0; i < 10; i++) {
  account = await readAccount(page);
  if (account?.equity > 0) break;
  await page.waitForTimeout(1500);
}

if (!(account?.equity > 0)) {
  console.log(JSON.stringify({ ok: false, reason: 'account panel did not render', account }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, ...account }));
// The CDP connection keeps the event loop alive; without an explicit exit the caller waits until its
// own timeout even though the answer is already on stdout.
process.exit(0);
