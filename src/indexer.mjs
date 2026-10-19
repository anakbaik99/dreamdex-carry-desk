/**
 * Indexer read plane.
 *
 * dreamDEX's perps indexer exposes a Hasura-style GraphQL API. Everything the strategy needs is
 * there: markets with live mark price and funding parameters, the funding candle series, and the
 * account's positions. Reads are cheap and stateless, so no caching layer is needed here.
 *
 * All numbers arrive as decimal strings of X18-scaled integers; convert at the edge and keep the
 * raw strings out of the strategy code.
 */
import { CONFIG } from './config.mjs';

const ENDPOINT = CONFIG.indexer;

export async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`indexer returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.errors?.length) {
    throw new Error(`indexer: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

/** All perp markets with the fields the strategy and risk model use. */
export async function fetchMarkets() {
  const data = await gql(`{
    Market(where: {perpRegistered: {_eq: true}}, order_by: {cumulativeQuoteVolume: desc}) {
      id
      marketId
      marketAddress
      poolAddress
      baseSymbol
      quoteSymbol
      baseDecimals
      quoteDecimals
      markPrice
      indexPrice
      lastPrice
      fundingRate
      fundingIntervalSec
      fundingWindowSec
      cumulativeFundingPerUnit
      openInterest
      initialMarginBps
      lotSize
      minQuantity
      tickSize
      perpStatus
    }
  }`);
  return data.Market.map((m) => ({
    id: m.id,
    marketId: m.marketId,
    address: m.marketAddress,
    pool: m.poolAddress,
    base: m.baseSymbol,
    quote: m.quoteSymbol,
    baseDecimals: Number(m.baseDecimals ?? 18),
    quoteDecimals: Number(m.quoteDecimals ?? 18),
    mark: toX18(m.markPrice),
    index: toX18(m.indexPrice),
    last: toX18(m.lastPrice),
    fundingRate: toX18(m.fundingRate),
    fundingIntervalSec: Number(m.fundingIntervalSec ?? 0),
    fundingWindowSec: Number(m.fundingWindowSec ?? 0),
    cumulativeFunding: Number(m.cumulativeFundingPerUnit ?? 0) / 1e18,
    openInterest: toX18(m.openInterest),
    initialMarginBps: Number(m.initialMarginBps ?? 0),
    lotSize: toX18(m.lotSize),
    minQuantity: toX18(m.minQuantity),
    tickSize: toX18(m.tickSize),
    status: m.perpStatus,
  }));
}

/**
 * Funding candle series for the lookback window. One row per market per bucket; each row carries
 * the eight-hour-equivalent rate that dreamDEX's own funding engine settled over that bucket.
 */
export async function fetchFundingCandles({ sinceTs, limit = 20_000 } = {}) {
  const since = sinceTs ?? Math.floor(Date.now() / 1000) - CONFIG.lookbackDays * 86_400;
  const data = await gql(
    `query Candles($since: numeric!, $limit: Int!) {
      FundingRateCandle(
        where: {bucketStart: {_gte: $since}}
        order_by: {bucketStart: desc}
        limit: $limit
      ) {
        market_id
        bucketStart
        avgFundingRate8h
        minFundingRate8h
        maxFundingRate8h
        coverage
        coveredSeconds
        updateCount
        intervalSeconds
      }
    }`,
    { since, limit },
  );
  return data.FundingRateCandle.map((c) => ({
    marketId: c.market_id,
    bucketStart: Number(c.bucketStart),
    rate8h: toX18(c.avgFundingRate8h),
    min8h: toX18(c.minFundingRate8h),
    max8h: toX18(c.maxFundingRate8h),
    coverage: toX18(c.coverage),
    coveredSeconds: Number(c.coveredSeconds ?? 0),
    updates: Number(c.updateCount ?? 0),
    intervalSeconds: Number(c.intervalSeconds ?? 0),
  }));
}

/** Open positions for an account, joined with the market row for price and decimals. */
export async function fetchPositions(account) {
  if (!account) throw new Error('no account configured (set DD_ACCOUNT)');
  const data = await gql(
    `query Positions($account: String!) {
      PerpPosition(where: {account: {_eq: $account}, size: {_neq: "0"}}) {
        market_id
        pool
        size
        isLong
        entryPriceX18
        realizedPnl
        entryFundingIndex
        updatedAt
        market {
          baseSymbol
          baseDecimals
          quoteDecimals
          markPrice
          fundingRate
          fundingIntervalSec
          initialMarginBps
        }
      }
    }`,
    { account: account.toLowerCase() },
  );
  return data.PerpPosition.map((p) => {
    const baseDecimals = Number(p.market?.baseDecimals ?? 18);
    const qty = Number(p.size) / 10 ** baseDecimals;
    return {
      marketId: p.market_id,
      pool: p.pool,
      base: p.market?.baseSymbol ?? p.market_id,
      baseDecimals,
      qty: p.isLong ? qty : -qty,
      entry: Number(p.entryPriceX18) / 1e18,
      mark: Number(p.market?.markPrice ?? 0) / 1e18,
      fundingRate: Number(p.market?.fundingRate ?? 0) / 1e18,
      initialMarginBps: Number(p.market?.initialMarginBps ?? 0),
      realizedPnl: Number(p.realizedPnl ?? 0) / 1e18,
      updatedAt: Number(p.updatedAt ?? 0),
    };
  });
}

/** Realised funding paid or received by this account per market, from the funding events. */
export async function fetchFundingPayments(account, { sinceTs } = {}) {
  if (!account) throw new Error('no account configured (set DD_ACCOUNT)');
  const since = sinceTs ?? Math.floor(Date.now() / 1000) - CONFIG.lookbackDays * 86_400;
  const data = await gql(
    `query Payments($account: String!, $since: numeric!) {
      FundingPayment(
        where: {account: {_eq: $account}, timestamp: {_gte: $since}}
        order_by: {timestamp: desc}
        limit: 5000
      ) { pool amount timestamp txHash }
    }`,
    { account: account.toLowerCase(), since },
  );
  return data.FundingPayment.map((p) => ({
    pool: p.pool,
    amount: Number(p.amount) / 1e18,
    timestamp: Number(p.timestamp ?? 0),
    txHash: p.txHash,
  }));
}

/**
 * X18-scaled integer as a JS number. Amounts here (prices, rates) stay far below 2^53 after
 * scaling, so the float is exact enough for ranking and sizing; on-chain execution always
 * re-derives size from the venue's own decimals, never from this number.
 */
export function toX18(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n / 1e18 : 0;
}
