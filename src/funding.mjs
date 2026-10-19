/**
 * Funding analytics.
 *
 * dreamDEX settles funding per interval (currently 3600s) over an 8-hour window, and the indexer
 * reports each bucket's rate normalised to that 8-hour window as `avgFundingRate8h`, X18-scaled.
 *
 * The convention in this venue, measured from its own applied funding index, is that a POSITIVE
 * rate means longs pay shorts. That is what makes a funding-carry book possible: hold the side
 * that receives, and collect the payments. Every function here returns a yield in percent, so the
 * strategy never has to remember the scaling.
 */

const WINDOW_SECONDS = 8 * 3600;
const PERIODS_PER_YEAR = (365 * 24 * 3600) / WINDOW_SECONDS; // 1095

/** Annualised yield in percent for a funding rate expressed over the 8-hour window. */
export function annualise(rate8h) {
  return rate8h * PERIODS_PER_YEAR * 100;
}

/** Yield in percent earned by the SIDE that holds a position, given the market's funding rate. */
export function carryForSide(rate8h, isLong) {
  const annual = annualise(rate8h);
  return isLong ? -annual : annual;
}

/**
 * Collapse the candle series into one row per market.
 *
 * Buckets are weighted by `coverage` — the fraction of the bucket the indexer actually observed —
 * so a market with a handful of partial buckets cannot outrank one with a full week of clean data.
 * A market with no covered time at all is dropped rather than ranked at zero.
 */
export function summariseFunding(candles) {
  const byMarket = new Map();
  for (const c of candles) {
    if (!(c.coverage > 0)) continue;
    const row = byMarket.get(c.marketId) ?? {
      marketId: c.marketId,
      weighted: 0,
      weight: 0,
      min8h: Infinity,
      max8h: -Infinity,
      buckets: 0,
      coveredSeconds: 0,
    };
    row.weighted += c.rate8h * c.coverage;
    row.weight += c.coverage;
    row.min8h = Math.min(row.min8h, c.min8h || c.rate8h);
    row.max8h = Math.max(row.max8h, c.max8h || c.rate8h);
    row.buckets += 1;
    row.coveredSeconds += c.coveredSeconds;
    byMarket.set(c.marketId, row);
  }

  const out = [];
  for (const row of byMarket.values()) {
    if (row.weight <= 0) continue;
    const rate8h = row.weighted / row.weight;
    out.push({
      marketId: row.marketId,
      rate8h,
      annualPct: annualise(rate8h),
      minAnnualPct: annualise(row.min8h === Infinity ? rate8h : row.min8h),
      maxAnnualPct: annualise(row.max8h === -Infinity ? rate8h : row.max8h),
      buckets: row.buckets,
      coveredHours: row.coveredSeconds / 3600,
      // Fraction of buckets that settled with the same sign as the average. A market that flips
      // sign every few buckets is not a carry trade, however good the average looks.
      consistency: consistencyOf(candles, row.marketId, rate8h),
    });
  }
  return out.sort((a, b) => Math.abs(b.annualPct) - Math.abs(a.annualPct));
}

function consistencyOf(candles, marketId, meanRate) {
  const rows = candles.filter((c) => c.marketId === marketId && c.coverage > 0);
  if (!rows.length || meanRate === 0) return 0;
  const same = rows.filter((c) => Math.sign(c.rate8h) === Math.sign(meanRate)).length;
  return same / rows.length;
}

/**
 * Rank markets for a carry book: keep only markets whose yield clears the floor, are consistent
 * enough not to be noise, and are actually tradeable.
 */
export function rankCandidates(summaries, markets, { minCarryPct, minConsistency = 0.6 } = {}) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const ranked = [];
  for (const s of summaries) {
    const market = byId.get(s.marketId);
    if (!market) continue;
    if (!(market.mark > 0)) continue;
    if (market.status && /halt|suspend|settl|delist/i.test(String(market.status))) continue;
    if (Math.abs(s.annualPct) < minCarryPct) continue;
    if (s.consistency < minConsistency) continue;

    // Positive funding: longs pay, so the book shorts and collects. Negative: the reverse.
    const side = s.annualPct > 0 ? 'short' : 'long';
    ranked.push({
      ...s,
      market,
      side,
      expectedAnnualPct: Math.abs(s.annualPct),
    });
  }
  return ranked.sort((a, b) => b.expectedAnnualPct - a.expectedAnnualPct);
}

/** Daily carry in quote currency for a given notional and annual yield. */
export function dailyCarry(notional, annualPct) {
  return (notional * (annualPct / 100)) / 365;
}
