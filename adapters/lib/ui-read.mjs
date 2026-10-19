/**
 * Shared readers for the dreamDEX perps UI over CDP. One place parses the header, the account panel,
 * and the bottom-panel position rows, so the order/close/bot scripts never drift apart.
 *
 * All readers are side-effect free; they only read what the page already rendered.
 */
import { chromium } from 'playwright';

export const APP = process.env.DD_APP ?? 'https://app.testnet.dreamdex.io';
export const CDP = process.env.MM_CDP ?? 'http://127.0.0.1:9222';

/** Attach to the running Chrome and return the app tab (creating one if the app was closed). */
export async function connectApp() {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 90000 });
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().startsWith(APP)) ?? (await ctx.newPage());
  return { browser, ctx, page };
}

/**
 * Clear the "Start trading on DreamDEX" onboarding overlay. It mounts above the ticket and silently
 * swallows every click on the order panel (the click "lands" but the form never reacts), so every
 * navigation has to re-check for it. Returns true if an overlay was present and dismissed.
 */
export async function dismissLaunchModal(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('div[aria-label="Start trading on DreamDEX"], .launch-modal');
    if (!dlg) return false;
    const btns = [...dlg.querySelectorAll('button')];
    const target =
      btns.find((b) => /skip/i.test(b.innerText || '')) ??
      btns.find((b) => (b.getAttribute('aria-label') || '').toLowerCase() === 'close');
    if (!target) return false;
    target.click();
    return true;
  });
}

export async function gotoMarket(page, market, region = 'tokyo') {
  await page.goto(`${APP}/trade/perps/${region}/${market}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000); // the SPA mounts after domcontentloaded
  if (await dismissLaunchModal(page)) await page.waitForTimeout(1200);
  return market;
}

/** Header block: MARK / ORACLE / MID / 24H CHANGE / OPEN INTEREST / LAST FUNDING / 24H HIGH-LOW-VOL. */
export async function readHeader(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const lines = document.body.innerText.split('\n').map(clean).filter(Boolean);
    const at = (label) => {
      const i = lines.indexOf(label);
      return i >= 0 ? (lines[i + 1] ?? null) : null;
    };
    const num = (s) => (s ? Number(String(s).replace(/[^\d.-]/g, '')) : null);
    const market = lines.find((l) => /^[A-Z0-9]+-PERP$/.test(l)) ?? null;
    return {
      market,
      mark: num(at('MARK')),
      oracle: num(at('ORACLE')),
      mid: num(at('MID')),
      change24h: num(at('24H CHANGE')),
      funding: at('LAST FUNDING'),
      high24h: num(at('24H HIGH')),
      low24h: num(at('24H LOW')),
      vol24h: at('24H VOL'),
      loading: /Loading market data/i.test(document.body.innerText),
    };
  });
}

/** Account panel: equity, available, buying power, margin usage, position count. */
export async function readAccount(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const lines = document.body.innerText.split('\n').map(clean).filter(Boolean);
    const at = (label) => {
      const i = lines.indexOf(label);
      return i >= 0 ? (lines[i + 1] ?? null) : null;
    };
    const num = (s) => (s ? Number(String(s).replace(/[^\d.-]/g, '')) : null);
    const m = /Positions \((\d+)\)/.exec(document.body.innerText);
    // The leverage is per market (BTC 20×, DOGE 10×) and this label is the authoritative read of it.
    const levLabel = /Buying power \((\d+(?:\.\d+)?)×\)/.exec(document.body.innerText);
    return {
      equity: num(at('Account equity')),
      available: num(at('Available to trade')),
      buyingPower: num(at(`Buying power (${levLabel?.[1] ?? 20}×)`)),
      leverage: levLabel ? Number(levLabel[1]) : null,
      marginUsage: at('Margin usage'),
      marginStatus: at('Margin status'),
      positionsCount: m ? Number(m[1]) : null,
    };
  });
}

/**
 * Bottom-panel rows look like:
 * MARKET | 20× | Long | size | value | entry | mark | liq | initial margin | funding | pnl | tp/sl
 */
export async function readPositions(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const lines = document.body.innerText.split('\n').map(clean).filter(Boolean);
    const i = lines.indexOf('MARKET');
    if (i < 0) return [];
    const num = (s) => {
      const v = Number(String(s ?? '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(v) ? v : null;
    };
    const out = [];
    for (let j = i + 1; j < lines.length - 2; j++) {
      if (!/^[A-Z0-9]+-PERP$/.test(lines[j])) continue;
      // Row layout (see the header comment): … initial margin | funding | pnl | tp/sl. The PnL cell is
      // +10, not +11 — +11 is the TP/SL column, which renders as "— / —", so num() turned it into 0 and
      // every position reported a PnL of exactly zero.
      const pnlCell = lines[j + 10] ?? null;
      const pnlPct = (() => {
        const m = /\((-?[\d.]+)%\)/.exec(pnlCell ?? '');
        return m ? Number(m[1]) : null;
      })();
      out.push({
        market: lines[j],
        lev: num(lines[j + 1]),
        side: /long/i.test(lines[j + 2] ?? '') ? 'long' : /short/i.test(lines[j + 2] ?? '') ? 'short' : lines[j + 2] ?? null,
        size: num(lines[j + 3]),
        value: num(lines[j + 4]),
        entry: num(lines[j + 5]),
        mark: num(lines[j + 6]),
        liq: num(lines[j + 7]),
        margin: num(lines[j + 8]),
        pnl: num(pnlCell),
        pnlPct,
        closable: Boolean(document.querySelector(`[aria-label="Close ${lines[j]} position"]`)),
      });
      if (out.length >= 8) break;
    }
    return out;
  });
}

/** Price move in percent from entry to a given mark, signed by position side (positive = in profit). */
export function movePct(pos, mark) {
  if (!pos?.entry || !mark) return null;
  const raw = ((mark - pos.entry) / pos.entry) * 100;
  return pos.side === 'short' ? -raw : raw;
}
