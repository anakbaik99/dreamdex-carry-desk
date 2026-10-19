# ARCHITECTURE

## The venue, as it actually behaves

CarryDesk is shaped by three properties of dreamDEX perps on Somnia Tokyo testnet, all of them
discovered by reading venue state rather than from the docs.

**1. Tokyo is chain 50383, region `tokyo`.**
The app's trade URLs carry the region segment (`/trade/perps/tokyo/BTC-PERP`), and that segment maps
to chain 50383 with `USDso` collateral. The same codebase also serves chain 50312 (`shannon`,
50x max leverage); the Tokyo venue is 20x.

**2. Margin is cross-margined at the account level.**
There is one margin bank per chain. Every open position draws from it, so adding a position can move
an unrelated one closer to liquidation. This is why the risk model works on aggregate exposure and a
shock buffer rather than per-position liquidation prices.

**3. Orders cannot be signed locally.**
The trading wallet is a smart wallet. On chain 50383 the local key is **not** an owner, so a locally
signed `execTransaction` reverts with `GS026`. The app holds a Privy session that signs for it. The
execution adapters therefore drive the app's own order ticket over CDP.

That third property is the least obvious and the most consequential. It means:

- the executor is a set of subprocess adapters, not an RPC client;
- a cycle costs seconds per order, so the strategy is deliberately low-frequency;
- order placement is not retried inside a single call, because a retried click can place twice.

## Layers

```
                 ┌──────────────────────────────┐
   reads         │  indexer.mjs  (GraphQL)      │  markets, funding candles,
                 │                              │  positions, funding payments
                 └───────────────┬──────────────┘
                                 │
                 ┌───────────────▼──────────────┐
   strategy      │  funding.mjs   rank          │
                 │  risk.mjs      size / guard  │
                 │  planner.mjs   intents       │
                 └───────────────┬──────────────┘
                                 │  pure, testable
                 ┌───────────────▼──────────────┐
   writes        │  executor.mjs  (ticket)      │  open / close / protect
                 └───────────────┬──────────────┘
                                 │
                 ┌───────────────▼──────────────┐
   record        │  ledger.mjs   (JSONL)        │
                 └──────────────────────────────┘
```

The planner is a pure function of `(ranked candidates, open positions, equity, free margin, config)`.
Given the same snapshot it always emits the same plan, which is what makes `plan` useful as a dry run
against `run`.

## Funding maths

The indexer reports each funding bucket as `avgFundingRate8h`, X18-scaled, normalised to the venue's
eight-hour funding window. The annualised yield is therefore:

```
annual_pct = rate_8h * (365 * 24 / 8) * 100
```

Sign convention, measured from the venue's applied funding index: a **positive** rate means longs pay
shorts. A positive-carry market is therefore traded **short**.

Aggregation is coverage-weighted rather than a plain mean, because the indexer emits partial buckets
at the edges of the window and for markets that were listed mid-window. A market needs the same sign
in at least 60% of its buckets to be a candidate.

## Sizing

Three ceilings, smallest wins:

```
per-position   equity * DD_MAX_POSITION_PCT / 100
gross budget   equity * DD_GROSS_EXPOSURE_PCT / 100  -  current gross notional
margin budget  (free margin - equity * DD_MIN_FREE_MARGIN_PCT / 100) * 20
```

The margin budget is multiplied by 20 because that is the venue's maximum leverage; the planner then
respects each market's own `initialMarginBps`. The effect is that a book never grows by borrowing
margin it does not have, even as the scan returns more candidates than there are slots.

## Failure behaviour

- Indexer unreachable → the command exits non-zero with the GraphQL error, and nothing is written.
- Order rejected by the ticket (button never armed) → recorded as `ok: false` with the adapter's
  stdout, no retry, cycle continues to the next intent.
- Drawdown beyond `DD_MAX_DRAWDOWN_PCT` → `halt` event, no new positions, existing positions are
  still closed if their carry has gone.
- Ledger is append-only; a corrupt line is skipped on read rather than aborting the report.
