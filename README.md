# CarryDesk

A funding-aware perps position manager for **dreamDEX on Somnia Tokyo testnet**.

Perps venues pay the side that is not crowding the book. On dreamDEX that payment is settled
hourly against a funding index, and on most markets it flows in one direction for days at a time:
longs pay shorts. CarryDesk reads that history from the venue's own indexer, ranks every perp market
by realised funding yield, and holds the side that is being paid — with account-level sizing,
exposure caps and a kill switch.

**What this is not.** It is not a hedged carry book. Each leg is a directional position that happens
to be paid to exist: LIT settled at 33.43%/yr, about 0.09%/day, while its stop sits 3% away, so price
movement dominates PnL. The one closed position made +89.60 USDso from a 2.9% price move, not from
funding. The honest description is *funding-tilted*, not *risk-free carry*.

**What a hedge would need.** For LIT there is no hedge leg: the venue lists LIT-PERP but no LIT spot
market to offset it. One pair on this venue can be hedged end to end — **short BTC-PERP against long
WBTC:USDso spot**, both settled in USDso on the same chain. Measured 2026-10-20: WBTC:USDso quoted
81,374.5 / 81,390.8 (0.020% spread) against a BTC-PERP mark of 81,207.6, a basis of −0.215%, which
would have to be netted against funding. The blocker is size: the entire WBTC:USDso ask book holds
0.00984 WBTC, about $801, so a hedge leg caps out near $800 notional. This is a roadmap item — the
two-leg sizing, the spot executor and the basis/funding netting are not built.

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

That is the honest limitation of this build, and there is a documented way out: the venue's
**Link a Bot** flow grants a bot order rights per wallet and per market, which removes the browser
from the loop. [`docs/EXECUTION.md`](docs/EXECUTION.md) explains the grant, what a linked bot may and
may not do, and what switching costs.

## Who it is for

Perps traders who want the funding side of the market rather than a directional view, and bot
developers who need a working example of reading dreamDEX perps state and placing real orders
against the venue.

## How to run it

**No wallet, no browser.** The read plane is public. Ranking markets needs nothing but Node:

```bash
git clone https://github.com/anakbaik99/dreamdex-carry-desk
cd dreamdex-carry-desk
node src/cli.mjs scan        # ranks all 21 markets from the indexer alone
```

`scan` and `report` never touch the browser. `doctor` also works without a browser — it reports the
indexer, the market count and whether the adapters are present.

**With a wallet.** Orders and position reads need an account and a signed-in browser:

- Node.js 20+
- A dreamDEX account that can trade perps on Somnia Tokyo testnet
- A Chromium instance running with remote debugging, with that account already signed in to
  `app.testnet.dreamdex.io` — orders are signed by the app's own Privy session, so the browser is
  the signer. See [`docs/RUNNING.md`](docs/RUNNING.md) for the exact setup.

> **Keep the debugging port local.** Launch Chromium with
> `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222` and never bind it to `0.0.0.0`
> or expose it through a tunnel. The DevTools endpoint hands full control of a browser that holds a
> logged-in trading session — anyone who reaches it can read the session and place orders. `MM_CDP`
> defaults to `http://127.0.0.1:9222`.

```bash
npm install
npx playwright install chromium      # only needed if the browser is launched by Playwright

export DD_ACCOUNT=0x...            # your dreamDEX smart wallet address

node src/cli.mjs doctor            # indexer, markets, positions, adapters, workspace
node src/cli.mjs scan              # rank markets by realised funding
node src/cli.mjs status            # current book and risk
node src/cli.mjs plan              # what it would do next (dry)
node src/cli.mjs run               # same, printed as a plan
node src/cli.mjs run --live --tp 3 --sl 3   # place the orders
```

`run` is a dry run unless `--live` is passed. Every action is appended to `data/ledger.jsonl`.

`doctor` from a fresh clone, with no `node_modules` and `DD_WORKSPACE` unset:

```
doctor
------------------------
  chain          : 50383 (tokyo)
  indexer        : ok
  perp markets   : 21
  open positions : 5
  account        : 0xf428a46db589878bedebbb4b8a1dbb0854e92f26
  workspace      : /path/to/dreamdex-carry-desk/adapters
  adapter perp-ui-order.mjs     : present
  adapter perp-ui-close.mjs     : present
  adapter perp-ui-tpsl.mjs      : present
```

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
| `DD_WORKSPACE` | `./adapters` (repo) | directory holding the order-ticket adapters; override only to point at an external checkout |

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
4. **Never resize, only close.** An amend on this venue is a cancel plus a place, which donates
   fees and queue position. When a market stops paying, the position is closed, not shrunk.
5. **Protect immediately.** Every opened position gets venue-side TP/SL in the same cycle.

## Evidence of building

Live orders placed by this tool on Somnia Tokyo testnet (chain 50383), with the console output and
the resulting positions recorded in [`docs/EVIDENCE.md`](docs/EVIDENCE.md).

## X posts

Drafts for all three posts, with the source of every number, are in
[`docs/X-POSTS.md`](docs/X-POSTS.md). Published links go here:

- [ ] post 1 — what CarryDesk does and why funding is the edge
- [ ] post 2 — a live order that hit its take-profit, with both transaction hashes
- [ ] post 3 — how the risk model sizes a cross-margined book

> Pending: the bounty requires 2-3 published posts tagging `@DreamDEXSomnia`. The drafts are ready;
> the links will be added here as they are published.

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
docs/EXECUTION.md     UI execution vs the official Link a Bot operator path
docs/EVIDENCE.md      live order evidence
```

## Known constraints

- **Cross-margin.** There is no per-position liquidation price on this venue. The risk model reports
  a book-level shock buffer instead.
- **Execution is UI-driven.** The adapters drive the app's order ticket, so a cycle takes seconds per
  order rather than milliseconds. That is a limitation of how this build signs, not of the venue;
  **Link a Bot** removes it ([`docs/EXECUTION.md`](docs/EXECUTION.md)).
- **Testnet only.** Paper USDso. Nothing here touches mainnet funds.
