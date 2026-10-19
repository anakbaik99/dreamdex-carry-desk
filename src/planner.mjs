/**
 * Planner: turn the ranked candidate list plus the current book into an ordered set of intents.
 *
 * Pure function of its inputs — no I/O, no clock, no randomness — so the same market snapshot
 * always produces the same plan and a `--plan` run can be diffed against the executed one.
 */
import { exposureOf, notionalOf, sizePosition } from './risk.mjs';
import { dailyCarry } from './funding.mjs';

/**
 * @param {object}   input
 * @param {Array}    input.ranked    candidates from rankCandidates(), best first
 * @param {Array}    input.positions open positions from the indexer
 * @param {number}   input.equity    account equity in quote currency
 * @param {number}   input.freeMargin free margin available right now
 * @param {object}   input.config
 * @returns {{opens: Array, keeps: Array, closes: Array, skipped: Array}}
 */
export function buildPlan({ ranked, positions, equity, freeMargin, config }) {
  const current = exposureOf(positions);
  const heldByMarket = new Map(positions.map((p) => [p.marketId, p]));

  const opens = [];
  const keeps = [];
  const closes = [];
  const skipped = [];

  // --- 1. decide what to do with what is already open ---------------------------------------
  for (const p of positions) {
    const candidate = ranked.find((r) => r.market.id === p.marketId);
    const heldSide = p.qty >= 0 ? 'long' : 'short';
    const carryPct = candidate
      ? candidate.side === heldSide
        ? candidate.expectedAnnualPct
        : -candidate.expectedAnnualPct
      : 0;

    if (carryPct < config.exitCarryPct) {
      closes.push({
        pair: `${p.base}-PERP`,
        base: p.base,
        notional: notionalOf(p),
        reason: candidate ? `carry ${carryPct.toFixed(2)}%/yr below exit floor` : 'no longer ranked',
      });
    } else {
      keeps.push({ position: p, carryPct, dailyCarry: dailyCarry(notionalOf(p), carryPct) });
    }
  }

  // --- 2. fill the remaining slots ----------------------------------------------------------
  const slots = Math.max(0, config.maxPositions - keeps.length);
  let exposure = current.gross;
  let free = freeMargin;

  for (const c of ranked) {
    if (opens.length >= slots) break;
    const held = heldByMarket.get(c.market.id);
    if (held) {
      // Already on the right side — counted in keeps, not a new open.
      continue;
    }

    const maxLeverage = 10_000 / (c.market.initialMarginBps || 500);
    const size = sizePosition({
      equity,
      freeMargin: free,
      currentExposure: { gross: exposure },
      config,
      maxLeverage,
    });
    if (!(size > 0)) {
      skipped.push({ base: c.market.base, reason: 'no exposure budget left' });
      continue;
    }
    // Respect the venue's minimum order size, so the plan never emits an order the exchange rejects.
    const minNotional = (c.market.minQuantity || 0) * c.market.mark;
    if (minNotional > size) {
      skipped.push({
        base: c.market.base,
        reason: `below venue minimum (${minNotional.toFixed(2)} ${c.market.quote})`,
      });
      continue;
    }

    opens.push({
      pair: `${c.market.base}-PERP`,
      base: c.market.base,
      marketId: c.market.id,
      baseDecimals: c.market.baseDecimals,
      side: c.side,
      notional: size,
      mark: c.market.mark,
      carryPct: c.expectedAnnualPct,
      dailyCarry: dailyCarry(size, c.expectedAnnualPct),
      consistency: c.consistency,
    });

    exposure += size;
    free -= (size * (c.market.initialMarginBps || 500)) / 10_000;
  }

  if (ranked.length && !opens.length && !keeps.length && !closes.length) {
    skipped.push({ base: '-', reason: 'no candidate cleared every filter' });
  }

  return { opens, keeps, closes, skipped, exposureBefore: current };
}
