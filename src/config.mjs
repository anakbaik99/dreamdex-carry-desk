/**
 * Runtime configuration. Every value can be overridden by an environment variable so the bot can be
 * pointed at a different environment without editing source.
 *
 * The venue is Somnia Tokyo testnet, which dreamDEX exposes as chain 50383 and the app labels
 * `tokyo` in its trade URLs. The indexer is the read plane; order writes go through the app's own
 * ticket because the local key is not an owner of the smart wallet on this chain.
 */
export const CONFIG = {
  // --- venue ---------------------------------------------------------------------------------
  chainId: Number(process.env.DD_CHAIN_ID ?? 50383),
  region: process.env.DD_REGION ?? 'tokyo',
  app: process.env.DD_APP ?? 'https://app.testnet.dreamdex.io',
  indexer: process.env.DD_INDEXER ?? 'https://hideki-dev.smk.somnia.host/v1/graphql',

  // --- reads ---------------------------------------------------------------------------------
  lookbackDays: Number(process.env.DD_LOOKBACK_DAYS ?? 7),

  // --- strategy ------------------------------------------------------------------------------
  // Minimum annualised funding yield, in percent, for a market to be a candidate.
  minCarryPct: Number(process.env.DD_MIN_CARRY_PCT ?? 4),
  // How many markets the book may hold at once.
  maxPositions: Number(process.env.DD_MAX_POSITIONS ?? 4),
  // Share of account equity allowed as total position notional, in percent.
  grossExposurePct: Number(process.env.DD_GROSS_EXPOSURE_PCT ?? 150),
  // Per-position cap, in percent of equity (notional).
  maxPositionPct: Number(process.env.DD_MAX_POSITION_PCT ?? 60),
  // Refuse to open a position whose notional would make the venue's margin status anything but
  // healthy after the fill. Expressed as a fraction of equity left free.
  minFreeMarginPct: Number(process.env.DD_MIN_FREE_MARGIN_PCT ?? 25),
  // Close a position when its funding yield falls below this (the edge is gone).
  exitCarryPct: Number(process.env.DD_EXIT_CARRY_PCT ?? 0),

  // --- execution -----------------------------------------------------------------------------
  // Drawdown guard: stop opening new positions once realised+unrealised PnL is below this
  // percentage of equity. The kill switch.
  maxDrawdownPct: Number(process.env.DD_MAX_DRAWDOWN_PCT ?? 15),
  // Path to the execution adapters. They drive the app ticket, which signs through the app's
  // own Privy session; a locally signed Safe transaction reverts GS026 on this chain.
  workspace: process.env.DD_WORKSPACE ?? '/home/ubuntu/scripts/dreamdex',
  // Seconds to wait between two order placements, so the app UI settles between fills.
  orderSpacingSec: Number(process.env.DD_ORDER_SPACING_SEC ?? 8),

  // --- files ---------------------------------------------------------------------------------
  ledgerPath: process.env.DD_LEDGER ?? new URL('../data/ledger.jsonl', import.meta.url).pathname,
  statePath: process.env.DD_STATE ?? new URL('../data/state.json', import.meta.url).pathname,

  // The account the app trades through. Read from env, never hardcoded, never logged with a key.
  account: (process.env.DD_ACCOUNT ?? '').toLowerCase(),
};

export const MARKET_SUFFIX = '-PERP';

/** App-side market label, e.g. BTC -> BTC-PERP. */
export const pairOf = (baseSymbol) => `${baseSymbol}${MARKET_SUFFIX}`;
