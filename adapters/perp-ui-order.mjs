/**
 * Drive the perps order ticket through the app's own UI, so the app signs (Privy) instead of us.
 *
 * This is the execution route for the Perps Arena venue: the campaign runs on Hideki (chain 50383),
 * where our key is not an owner of the smart wallet, so a locally signed Safe transaction cannot
 * place an order — but the app can, because it holds the Privy session.
 *
 *   node perp-ui-order.mjs --side long --qty 0.001                      # fill the ticket, print the preview
 *   node perp-ui-order.mjs --side short --type limit --price 86000 --qty 0.002
 *   node perp-ui-order.mjs --side long --qty 0.001 --submit             # actually click the order button
 *
 * Default is a dry run: the ticket is filled and the preview is read back, nothing is submitted.
 */
import { chromium } from 'playwright';

const CDP = process.env.MM_CDP ?? 'http://127.0.0.1:9222';
const APP = 'https://app.testnet.dreamdex.io';

const argv = process.argv.slice(2);
const flag = (n, d = null) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] ?? true : d);
const MARKET = flag('market', 'BTC-PERP');
const REGION = flag('region', 'tokyo');
const SIDE = String(flag('side', 'long')).toLowerCase();
const TYPE = String(flag('type', 'market')).toLowerCase();
const PRICE = flag('price');
const QTY = flag('qty');
const SUBMIT = argv.includes('--submit');
// On-chain TP/SL. The ticket exposes `TP trigger price` / `SL trigger price` inputs; arming at least one
// is what the campaign's `tp-sl` quest counts (action "trigger", i.e. a stop that actually FIRES), and
// it is also how R6 gets enforced without a watched exit.
const TP = flag('tp');
const SL = flag('sl');

if (!['long', 'short'].includes(SIDE)) throw new Error('--side must be long or short');
if (!QTY) throw new Error('--qty is required');
if (TYPE === 'limit' && !PRICE) throw new Error('--type limit needs --price');

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith(APP)) ?? (await ctx.newPage());

const banner = (m) => console.log(`\n== ${m}`);
const previewKeys = ['Order value', 'Slippage', 'Maximum spent', 'Margin required', 'Margin if orders fill', 'Liquidation price', 'Fees'];

async function readTicket() {
  return page.evaluate((keys) => {
    const lines = document.body.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
    const out = {};
    for (let i = 0; i < lines.length; i++) {
      for (const k of keys) if (lines[i].startsWith(k) && out[k] === undefined) out[k] = lines[i + 1] ?? null;
    }
    const markIdx = lines.indexOf('MARK');
    return { mark: markIdx > -1 ? lines[markIdx + 1] : null, out };
  }, previewKeys);
}

banner('navigate');
// --no-nav: the caller (arena-bot) already has this market on screen; re-navigating makes the app
// re-hydrate the account, and the ticket stays disabled until that finishes.
if (argv.includes('--no-nav')) console.log('skipped (--no-nav): keeping the page the caller loaded');
else await page.goto(`${APP}/trade/perps/${REGION}/${MARKET}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
for (let i = 0; i < 20; i++) {
  const { mark } = await readTicket();
  if (mark && mark !== '—' && /[\d,]/.test(mark)) break;
  await page.waitForTimeout(1500);
}
let t = await readTicket();
console.log(`market      : ${MARKET} (${REGION})  mark=${t.mark}`);

banner(`order type: ${TYPE}`);
await page.getByRole('button', { name: TYPE === 'limit' ? 'Limit' : 'Market', exact: true }).click();
await page.waitForTimeout(1500);

const visibleInputs = () =>
  page.$$eval('input', (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => ({ aria: e.getAttribute('aria-label'), ph: e.placeholder, v: (e.value || '').slice(0, 24) })));
console.log('inputs after type switch:', JSON.stringify(await visibleInputs()));
console.log('url:', page.url());

if (TYPE === 'limit') {
  const priceBox = page.locator('input[aria-label="Price"], input[placeholder="0.00"]').first();
  await priceBox.fill(String(PRICE));
  await page.waitForTimeout(500);
  console.log(`price       : ${PRICE}`);
}

banner('amount');
// The size box is denominated in USDso by default; the toggle next to it switches to the base asset.
const UNIT = String(flag('unit', '')).toLowerCase();
if (UNIT) {
  const sw = page.locator('button[aria-label^="Switch size unit"]').first();
  const before = await sw.getAttribute('aria-label');
  if (!new RegExp(`currently ${UNIT}`, 'i').test(before ?? '')) {
    await sw.click();
    await page.waitForTimeout(1000);
  }
  console.log(`size unit : ${before} -> ${await sw.getAttribute('aria-label')}`);
}

const sizeBox = page.locator('input[aria-label="Order size"]').first();
await sizeBox.waitFor({ state: 'visible', timeout: 20000 });
await sizeBox.click();
await sizeBox.fill(String(QTY));
await page.waitForTimeout(400);
console.log(`size read-back: "${await sizeBox.inputValue()}"  (wanted ${QTY})`);
await page.waitForTimeout(2000);

banner(`side: ${SIDE}`);
const sideTab = page.getByRole('button', { name: SIDE === 'long' ? 'Long' : 'Short', exact: true }).first();
if (await sideTab.count()) {
  await sideTab.click();
  await page.waitForTimeout(1500);
} else {
  console.log('side control not found');
}
await sizeBox.click();
await sizeBox.fill(String(QTY));
await page.keyboard.press('Tab'); // React validates on blur; without it the button can stay disabled

// Arm the stops BEFORE the arming poll, so the poll watches the ticket's final state. The trigger
// inputs are separate from the order size and take a raw price; the venue validates them on blur.
if (TP || SL) {
  banner('tp/sl');
  // FOOTGUN: this path reaches the app but NOT the venue. A submitted ticket with TP/SL set produces
  // zero StopOrder rows even when the Confirm modal echoes the trigger back, so a filled field here is
  // not an attached stop. The validated route is the `Protection group` dialog in perp-ui-tpsl.mjs.
  // See references/tpsl-and-stt.md in the dreamdex-ops skill.
  console.log('  NOTE: ticket TP/SL is UNVERIFIED as an attach — prefer perp-ui-tpsl.mjs (verified vs StopOrder)');
  // The trigger fields only accept input once the ticket's TP/SL toggle is switched ON. While it is
  // off the whole section is rendered with vis=false, and a value typed into it is silently cleared
  // (fill() sets the DOM value, React re-renders it back to "") — that is what made this look like the
  // venue rejecting the input. The toggle is the first button[role=checkbox] on the ticket; the second
  // is "Reduce only". Clicking the <input> itself does nothing: it is aria-hidden/tabindex=-1.
  const toggle = page.locator('button[role="checkbox"]').first();
  if (await toggle.count()) {
    if ((await toggle.getAttribute('data-state')) !== 'checked') {
      await toggle.click({ force: true });
      await page.waitForTimeout(2500);
    }
    console.log(`  TP/SL toggle      : ${await toggle.getAttribute('data-state')}`);
  } else {
    console.log('  TP/SL toggle      : not found');
  }

  for (const [label, val] of [['TP trigger price', TP], ['SL trigger price', SL]]) {
    if (!val) continue;
    const box = page.locator(`input[aria-label="${label}"]`).first();
    if (!(await box.count())) { console.log(`  ${label.padEnd(18)}: control not found`); continue; }
    if (!(await box.isVisible())) { console.log(`  ${label.padEnd(18)}: still hidden — toggle did not open the section`); continue; }
    await box.click({ force: true, timeout: 8000 });
    await page.keyboard.type(String(val), { delay: 60 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);
    const got = await box.inputValue();
    console.log(`  ${label.padEnd(18)}: set to "${got}"${got ? '' : '   <- REJECTED (venue cleared it)'}`);
  }
  // The trigger fields live outside the size box, so re-assert the size in case the re-render cleared it.
  await sizeBox.click();
  await sizeBox.fill(String(QTY));
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1500);
}

// Poll the action button itself. A computed margin preview does NOT imply an armed submit — that
// mismatch is what produced "the order button is disabled" and silently dropped race rounds. If it
// never arms, re-select the side and re-enter the size once before giving up.
const armedRe = new RegExp(`^${SIDE}\\s+${MARKET.split('-')[0]}\\b`, 'i');
const isArmed = async () => {
  const bs = await page.$$eval('button', (els) =>
    els
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ t: (e.innerText || '').replace(/\s+/g, ' ').trim(), dis: e.disabled === true })),
  );
  const hit = bs.find((b) => armedRe.test(b.t));
  return hit ? !hit.dis : false;
};
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1500);
  t = await readTicket();
  if (await isArmed()) break;
  if (i === 6) {
    console.log('  ticket not armed yet — re-selecting side and re-entering size');
    await sideTab.click().catch(() => {});
    await page.waitForTimeout(1200);
    await sizeBox.click();
    await sizeBox.fill(String(QTY));
    await page.keyboard.press('Tab');
  }
}
await page.waitForTimeout(800);

t = await readTicket();
for (const k of previewKeys) console.log(`  ${k.padEnd(22)}: ${t.out[k] ?? '-'}`);

const num = (s) => (s ?? '').replace(/[^\d.,-]/g, '').replace(/,/g, '') || null;
console.log(
  `ORDER_PREVIEW ${MARKET} ${SIDE} ${TYPE} qty=${QTY} value=${num(t.out['Order value'])} margin=${num(t.out['Margin required'])} mark=${num(t.mark)}`,
);

const BASE = MARKET.split('-')[0];
const baseRe = new RegExp(`^${SIDE}\\s+${BASE}\\b`, 'i');

banner('ticket buttons');
const btns = await page.$$eval('button', (els) =>
  els
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ t: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), aria: e.getAttribute('aria-label'), dis: e.disabled === true }))
    .filter((b) => b.t || b.aria));
const interested = btns.filter((b) => /switch size unit|adjust leverage|^(long|short)\b/i.test(b.t) || /unit|leverage/i.test(b.aria ?? ''));
for (const b of interested) console.log('  ', JSON.stringify(b));

const armed = btns.find((b) => baseRe.test(b.t));
const blocker = btns.find((b) => /^(insufficient perps balance|enter amount|connect wallet|transfer from spot)$/i.test(b.t));
console.log(`submit "${SIDE} ${BASE}"   : ${armed ? `rendered, disabled=${armed.dis}` : 'not rendered'}`);
console.log(`ticket action button : ${blocker ? `"${blocker.t}" (disabled=${blocker.dis})` : '(none of the known states)'}`);

if (!armed) {
  console.log(`\nblocked: the order button is showing "${blocker?.t ?? 'nothing'}" instead of an order action.`);
  if (blocker && /insufficient/i.test(blocker.t)) console.log('cause: no perps collateral — the app will not arm an order until the margin bank has a balance.');
  process.exit(0);  // detach: never browser.close() a shared connectOverCDP session
}
if (armed.dis) {
  const avail = (await readTicket()).out['Available to trade'];
  console.log(`\nblocked: the order button is disabled. Available to trade = ${avail ?? 'unknown'}`);
  process.exit(0);  // detach: never browser.close() a shared connectOverCDP session
}

const submitBtn = page.getByRole('button', { name: baseRe }).first();

if (!SUBMIT) {
  console.log('\ndry run: ticket filled and preview read. nothing submitted. add --submit to place it.');
  process.exit(0);  // detach: never browser.close() a shared connectOverCDP session
}

banner('SUBMIT');
await submitBtn.click();
await page.waitForTimeout(6000);

// The ticket opens a "Confirm order" modal; its own side button is the real submit.
const dialog = page.locator('[role="dialog"]').first();
if (await dialog.count()) {
  const confirm = dialog.getByRole('button', { name: new RegExp(`^${SIDE}\\b`, 'i') }).first();
  if (await confirm.count()) {
    console.log(`modal       : ${(await dialog.innerText()).replace(/\n+/g, ' | ').slice(0, 220)}`);
    await confirm.click();
    console.log('modal       : confirmed');
  }
}
await page.waitForTimeout(12000);
const after = await readTicket();
console.log('post-click mark:', after.mark);
const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n'));
const errs = text.split('\n').map((l) => l.trim()).filter((l) => /insufficient|failed|error|rejected|not enough|margin/i.test(l)).slice(0, 8);
console.log('messages:', errs.length ? errs.join(' | ') : '(none matched)');
const posCount = await page.evaluate(() => {
  const m = /Positions \((\d+)\)/.exec(document.body.innerText);
  return m ? Number(m[1]) : null;
});
console.log(`ORDER_SUBMITTED ${MARKET} ${SIDE} ${TYPE} qty=${QTY} positions=${posCount ?? 'unknown'}`);
process.exit(0);  // detach: never browser.close() a shared connectOverCDP session
