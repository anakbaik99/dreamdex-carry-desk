# Evidence of building

All activity is on **Somnia Tokyo testnet** — dreamDEX perps, chain **50383**, app region `tokyo`,
collateral `USDso`. Testnet paper money.

Two complete cycles are recorded below, including the close path: the take-profit that this tool
attached was triggered by the venue and the position closed at +89.60 USDso.

## Transaction hashes

```
open   LIT-PERP long   2026-10-19T19:55:21Z  block 27878806
       0x2aa8406c2c5978e1409bf79e102dbed000a0c47a281c331d4c0d950e012a7fdb

close  LIT-PERP (TP)   2026-10-19T23:38:30Z  block 28012607
       0x5d8fab861ebde05699771f60ba62e268e6fdd837d572aabb5c6464ed10fc1962

TP/SL  2 stop orders created (same tx as the triggers below)
       0x19cf0c18ee2782b31baa06e041a7a43a6c66e923991e1238faeb9d5a23f62781
```

**There is no public block explorer for chain 50383.** `shannon-explorer.somnia.network` and
`explorer.testnet.somnia.network` both serve chain 50312 and answer `Transaction not found` for
these hashes. Each hash is verifiable against the venue's own RPC, which is what the block numbers
above came from:

```bash
curl -s -X POST https://api.hideki2.infra.testnet.somnia.network \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash",
           "params":["0x2aa8406c2c5978e1409bf79e102dbed000a0c47a281c331d4c0d950e012a7fdb"]}'
```

Returns `blockNumber: 0x1a96596` (27878806), `from` the smart wallet's owner, `to` the position
contract. The same call on `api.infra.testnet.somnia.network` (chain 50312) returns `null`, which is
how the chain attribution was confirmed.

## Cycle 1 — open

Scan ranked 21 perp markets by realised funding over a 7-day window:

```
$ node src/cli.mjs scan
  PAIR           SIDE   MARK        CARRY/yr  RATE/8h   CONSIST  HOURS
  BTC-PERP       short  81766.1182  76.88%    0.0702%   100%     498
  LIT-PERP       long   3.0469      33.43%    -0.0305%  89%      279
  BNB-PERP       short  725.8578    19.64%    0.0179%   100%     498
  ...
```

LIT was the best candidate not already in the book, and its funding was negative — shorts pay longs,
so the collecting side was **long**.

```
$ node src/cli.mjs run --live --tp 3 --sl 3
run — 50383 tokyo LIVE
  open  LIT-PERP     long  notional=3052.36 ok
        protect LIT-PERP     tp=3% sl=3%  FAIL
```

Ticket preview returned by the adapter before submitting:

```
ORDER_PREVIEW LIT-PERP long market qty=3052.36 value=3052.32 margin=625.77 mark=3.0127
submit "long LIT"   : rendered, disabled=false
ORDER_SUBMITTED LIT-PERP long market qty=3052.36 positions=7
```

On-chain, from `PerpPositionChange`:

```
2026-10-19T19:55:21Z  LIT  OPEN      0 -> 332.1 LIT       entry 3.0117
2026-10-19T19:55:21Z  LIT  INCREASE  332.1 -> 996.4 LIT   entry 3.01283
2026-10-19T19:55:21Z  LIT  INCREASE  996.4 -> 1008.8 LIT  entry 3.01286
tx 0x2aa8406c2c5978e1409bf79e102dbed000a0c47a281c331d4c0d950e012a7fdb  block 27878806
```

Three fills inside one transaction: the market order swept three price levels.

### Protection attached

The first protect attempt failed (adapter bug, fixed since — see below). Retry:

```
TPSL_PREVIEW LIT-PERP tp=3 sl=3 est_profit=+115.84 est_loss=-115.88 submit_button_disabled=false
TPSL_POST_SUBMIT {"modals":["Success: 2 triggers set 0.15 STT per trigger, refunded on cancel."]}
```

Confirmed against the venue's `StopOrder` table, not the dialog text:

```
LIT  PENDING  trigger 2.9225   <- stop loss,   -3%
LIT  PENDING  trigger 3.1032   <- take profit, +3%
tx 0x19cf0c18ee2782b31baa06e041a7a43a6c66e923991e1238faeb9d5a23f62781
```

## Cycle 2 — the take-profit fires

At 23:38:30Z the venue triggered the take-profit the tool had attached:

```
LIT  TRIGGERED  trigger 3.1032
LIT  CANCELLED  trigger 2.9225      (sibling cancelled, as designed)
```

Position changes in the closing transaction:

```
2026-10-19T23:38:30Z  LIT  REDUCE  1008.8 -> 686.5 LIT   exit 3.1022  pnl +28.7951
2026-10-19T23:38:30Z  LIT  REDUCE   686.5 -> 42.0 LIT   exit 3.1016  pnl +57.1945
2026-10-19T23:38:30Z  LIT  CLOSE     42.0 -> 0 LIT      exit 3.0988  pnl  +3.6096
tx 0x5d8fab861ebde05699771f60ba62e268e6fdd837d572aabb5c6464ed10fc1962  block 28012607
realised: +89.5992 USDso on 3,052.36 notional  (+2.94%)
```

The order was opened by this tool, protected by this tool, and closed by the trigger this tool
attached — all three verifiable on chain.

## What this is not

This is **not** a hedged carry strategy. A long with a 3% stop is a directional position that is
paid to exist. At 33%/yr the funding is roughly 0.09%/day against a 3% stop, so price movement
dominates PnL — as the result shows: +89.60 came from a 2.9% price move, not from funding. The
honest description is *funding-tilted*, not *carry without risk*. A hedged version would need a
second leg on the same underlying, which this venue does not currently offer as a perp pair.

## Execution bugs found and fixed

Both were found by running against the live app.

**1. The Positions panel hides the TP/SL control below a desktop width.**
The app renders two variants of every position row: a table row carrying `Set TP/SL`, and a card
carrying only Share and Close. Below roughly 1536px the table row is `display: none`, so the control
exists in the DOM with a `0x0` box and every click fails with `no bounding box for locator`.
Fix: force a 1920x1080 viewport, and re-assert it after navigation (the override is dropped by a
full page load). This fix is in `adapters/perp-ui-tpsl.mjs` in this repository.

**2. `[aria-label="Set TP/SL"].first()` targets the wrong position.**
The table lists every open position, so the label matches one control per row. `.first()` opens
whichever row sorts first — a run asked for LIT opened the NEAR dialog instead. Fix: tag the control
whose tightest containing ancestor names the requested pair. Also in `adapters/perp-ui-tpsl.mjs`.
