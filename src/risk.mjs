/**
 * Risk model.
 *
 * The venue is cross-margined: every position on a chain draws from one margin bank, and margin
 * health is a property of the ACCOUNT, not of a single position. That changes the sizing rules —
 * adding a position can liquidate an unrelated one — so the model works at account level and only
 * uses per-position figures for attribution.
 *
 * Everything here is an estimate derived from indexer state. It is deliberately conservative: the
 * upkeep margin is modelled at the market's `initialMarginBps`, which is the venue's own
 * maintenance proxy for these pools.
 */
import { dailyCarry } from './funding.mjs';

/** Notional of a position in quote currency. `qty` is signed: positive long, negative short. */
export function notionalOf(position) {
  return Math.abs(position.qty) * position.mark;
}

/** Unrealised PnL in quote currency, signed by direction. */
export function unrealisedPnl(position) {
  const move = position.mark - position.entry;
  return position.qty >= 0 ? move * position.qty : move * position.qty;
}

/** Aggregate exposure across the book. */
export function exposureOf(positions) {
  let gross = 0;
  let net = 0;
  let longs = 0;
  let shorts = 0;
  for (const p of positions) {
    const n = notionalOf(p);
    gross += n;
    net += p.qty >= 0 ? n : -n;
    if (p.qty >= 0) longs += n;
    else shorts += n;
  }
  return { gross, net, longs, shorts, count: positions.length };
}

/**
 * Minutes of margin left if price moved against the book uniformly, using maintenance margin at
 * the weighted `initialMarginBps` of the open positions. Returns Infinity when there is no
 * exposure, and 0 when the account is already below maintenance.
 *
 * This is a "how much shock can the book take" figure, not a per-position liquidation price: under
 * cross margin there is no single liquidation price per position.
 */
export function shockBufferPct(positions, equity) {
  const { gross } = exposureOf(positions);
  if (gross <= 0) return Infinity;
  const weightedBps =
    positions.reduce((sum, p) => sum + notionalOf(p) * (p.initialMarginBps || 500), 0) / gross;
  const maintenance = (gross * weightedBps) / 10_000;
  return ((equity - maintenance) / gross) * 100;
}

/**
 * Size a new position so the resulting free-margin cushion stays above the configured floor.
 *
 * Sizing is bounded three ways: the per-position cap, the remaining gross-exposure budget, and the
 * free-margin floor. The smallest of the three wins — that is what keeps a carry book from quietly
 * becoming a leveraged directional book.
 *
 * `maxLeverage` is the CANDIDATE MARKET's own maximum (10000 / initialMarginBps), not a global
 * constant: markets on this venue differ (500 bps = 20x, 2000 bps = 5x), and sizing a 5x market as
 * if it were 20x would tie up four times the margin the plan assumed.
 */
export function sizePosition({ equity, freeMargin, currentExposure, config, maxLeverage = 20 }) {
  const perPosition = (equity * config.maxPositionPct) / 100;
  const grossBudget = Math.max(0, (equity * config.grossExposurePct) / 100 - currentExposure.gross);
  // Every unit of notional ties up 1/maxLeverage of margin; keep the rest free.
  const marginBudget = Math.max(0, freeMargin - (equity * config.minFreeMarginPct) / 100);
  const byMargin = marginBudget * maxLeverage;
  return Math.max(0, Math.min(perPosition, grossBudget, byMargin));
}

/**
 * Decide what to do with what the book already holds.
 *
 * Returns explicit actions so the executor never improvises: `close` when the edge has gone or the
 * direction flipped, `hold` otherwise. Positions are only ever closed from here, never resized —
 * a resize on this venue is a cancel plus a place, and doing that on a carry book mostly donates
 * fees and queue position.
 */
export function reviewBook(positions, ranked, config) {
  const byMarket = new Map(ranked.map((r) => [r.market.id, r]));
  const actions = [];
  for (const p of positions) {
    const candidate = byMarket.get(p.marketId);
    const heldSide = p.qty >= 0 ? 'long' : 'short';
    const currentCarry = candidate
      ? candidate.side === heldSide
        ? candidate.expectedAnnualPct
        : -candidate.expectedAnnualPct
      : 0;

    if (currentCarry < config.exitCarryPct) {
      actions.push({
        type: 'close',
        position: p,
        reason: candidate
          ? `carry turned against the position (${currentCarry.toFixed(2)}%/yr)`
          : 'market no longer in the ranked set',
        carryPct: currentCarry,
      });
    } else {
      actions.push({
        type: 'hold',
        position: p,
        reason: 'still on the paying side',
        carryPct: currentCarry,
        dailyCarry: dailyCarry(notionalOf(p), currentCarry),
      });
    }
  }
  return actions;
}

/** The kill switch: true when the book has lost more than the configured share of equity. */
export function drawdownTripped(realisedPnl, unrealisedPnlTotal, equity, config) {
  if (!(equity > 0)) return true;
  const pnl = realisedPnl + unrealisedPnlTotal;
  return (pnl / equity) * 100 < -config.maxDrawdownPct;
}
