# CarryDesk

A funding-aware perps position manager for **dreamDEX on Somnia Tokyo testnet**.

Perps venues pay the side that is not crowding the book. On dreamDEX that payment is settled
hourly against a funding index, and on most markets it flows in one direction for days at a time:
longs pay shorts. CarryDesk reads that history from the venue's own indexer, ranks every perp market
by realised funding yield, and maintains a book that sits on the collecting side — with the sizing,
exposure caps and kill switch that keep a carry trade from quietly turning into a leveraged
directional bet.

Built for the **dreamDEX Perps Builder Bounty**, MVP track (bots and agents).

---

## What it does

```
scan     rank all 21 perp markets by realised funding yield over a lookback window
status   the current book: positions, carry attribution, exposure, shock buffer
plan     what the tool would do next — pure function, no writes
run      one cycle: close what lost its edge, open what cleared the floor, attach TP/SL
report   the append-only ledger, so every decision is reconstructable
```

Reads come from the dreamDEX perps indexer (GraphQL). Writes go through the app's own order
ticket, because on the Tokyo chain the local key is not an owner of the smart wallet and a locally
signed Safe transaction reverts `GS026`.

## Who it is for

Perps traders who want the funding side of the market rather than a directional view, and bot
developers who need a working example of reading dreamDEX perps state and placing real orders
against the venue.

## How to run it

Requirements:

- Node.js 20+
- A dreamDEX account that can trade perps on Somnia Tokyo testnet
- A Chromium instance running with remote debugging, with that account already signed in to
  `app.testnet.dreamdex.io` — orders are signed by the app's own Privy session, so the browser is
  the signer. See [`docs/RUNNING.md`](docs/RUNNING.md) for the exact setup.

```bash
git clone https://github.com/anakbaik99/dreamdex-carry-desk
cd dreamdex-carry-desk
npm install
npx playwright install chromium      # only needed if the browser is launched by Playwright

export DD_ACCOUNT=0x...            # your dreamDEX smart wallet address

node src/cli.mjs doctor            # indexer, markets, positions, execution adapters
node src/cli.mjs scan              # rank markets by realised funding
node src/cli.mjs status            # current book and risk
node src/cli.mjs plan              # what it would do next (dry)
node src/cli.mjs run               # same, printed as a plan
node src/cli.mjs run --live --tp 3 --sl 3   # place the orders
```

`run` is a dry run unless `--live` is passed. Every action is appended to `data/ledger.jsonl`.

### Configuration

All settings are environment variables with documented defaults; see `src/config.mjs`.

| Variable | Default | Meaning |
|---|---|---|
| `DD_ACCOUNT` | — | smart wallet address (required for status/plan/run) |
| `DD_MIN_CARRY_PCT` | `4` | minimum annualised yield to consider a market |
| `DD_MAX_POSITIONS` | `4` | how many markets the book may hold |
| `DD_GROSS_EXPOSURE_PCT` | `150` | gross notional cap as % of equity |
| `DD_MAX_POSITION_PCT` | `60` | per-position notional cap as % of equity |
| `DD_EXIT_CARRY_PCT` | `0` | close a position when its yield falls below this |
| `DD_MAX_DRAWDOWN_PCT` | `15` | kill switch: stop opening below this PnL |
| `DD_INDEXER` | Tokyo indexer | GraphQL endpoint |
| `DD_WORKSPACE` | `~/scripts/dreamdex` | directory holding the order-ticket adapters |

## How the strategy works

1. **Measure, don't guess.** The indexer publishes a funding candle series. Each bucket carries the
   eight-hour-equivalent rate the venue actually settled, plus a `coverage` figure for how much of
   the bucket was observed. Buckets are weighted by coverage, so a market with three clean buckets
   cannot outrank one with a week of data.
2. **Require consistency.** The average alone is not a signal — a market that flips sign every
   bucket has no carry. A candidate must settle with the same sign in at least 60% of buckets.
3. **Size at account level.** dreamDEX perps are cross-margined: every position draws from one
   margin bank, so the model sizes against free margin and a gross exposure cap, never per position
   in isolation. Sizing is the minimum of three limits — per-position cap, remaining gross budget,
   and the free-margin floor.
4. **Never resizize, only close.** An amend on this venue is a cancel plus a place, which donates
   fees and queue position. When a market stops paying, the position is closed, not shrunk.
5. **Protect immediately.** Every opened position gets venue-side TP/SL in the same cycle.

## Evidence of building

Live orders placed by this tool on Somnia Tokyo testnet (chain 50383), with the console output and
the resulting positions recorded in [`docs/EVIDENCE.md`](docs/EVIDENCE.md).

## X posts

<!-- Fill in after publishing. The bounty requires 2-3 posts tagging @DreamDEXSomnia. -->

- [ ] post 1 — what CarryDesk does and the funding edge it targets
- [ ] post 2 — a live order on Tokyo testnet with the transaction hash
- [ ] post 3 — how the risk model sizes a cross-margined carry book

## Repository layout

```
src/config.mjs      runtime configuration, all env-overridable
src/indexer.mjs     GraphQL read plane: markets, funding candles, positions, funding payments
src/funding.mjs     carry maths: annualising, coverage-weighted aggregation, ranking
src/risk.mjs        account-level exposure, shock buffer, sizing bounds, kill switch
src/planner.mjs     pure planner: ranked candidates + current book -> ordered intents
src/executor.mjs    order-ticket adapters (open / close / protect) and result parsing
src/ledger.mjs      append-only JSONL ledger
src/cli.mjs         the command surface
adapters/           the order-ticket drivers the executor shells out to (Playwright)
docs/ARCHITECTURE.md  design notes and the venue constraints that shaped them
docs/RUNNING.md       browser prerequisite and why the app is the signer
docs/EVIDENCE.md      live order evidence
```

## Known constraints

- **Cross-margin.** There is no per-position liquidation price on this venue. The risk model reports
  a book-level shock buffer instead.
- **Execution is UI-driven.** The adapters drive the app's order ticket, so a cycle takes seconds per
  order rather than milliseconds. That is a property of the venue's signing model on Tokyo, not a
  design choice.
- **Testnet only.** Paper USDso. Nothing here touches mainnet funds.
