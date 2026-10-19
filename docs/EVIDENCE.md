# Evidence of building

All activity below is on **Somnia Tokyo testnet**, dreamDEX perps, chain **50383**, region `tokyo`,
collateral `USDso`. This is testnet paper money.

## Cycle 1 — 2026-10-19T19:55Z

The scan ranked 21 perp markets by realised funding over a 7-day lookback. The top candidates the
book did not already hold were LIT (long, 33.43% annualised) and BNB (short, 19.64%). The planner
sized a single position at the per-position cap because the account was already near its gross
exposure ceiling; it emitted exactly one intent.

```
$ node src/cli.mjs scan
  PAIR           SIDE   MARK        CARRY/yr  RATE/8h   CONSIST  HOURS
  BTC-PERP       short  81766.1182  76.88%    0.0702%   100%     498
  LIT-PERP       long   3.0469      33.43%    -0.0305%  89%      279
  BNB-PERP       short  725.8578    19.64%    0.0179%   100%     498
  ...
```

### Order placed

```
$ node src/cli.mjs run --live --tp 3 --sl 3
run — 50383 tokyo LIVE
  open  LIT-PERP     long  notional=3052.36 ok
        protect LIT-PERP     tp=3% sl=3%  FAIL
```

The open succeeded. The protect step failed on the first attempt; the cause and the fix are under
"Execution bugs found and fixed" below.

The ticket's own preview, returned by the adapter before submitting:

```
ORDER_PREVIEW LIT-PERP long market qty=3052.36 value=3052.32 margin=625.77 mark=3.0127
submit "long LIT"   : rendered, disabled=false
ORDER_SUBMITTED LIT-PERP long market qty=3052.36 positions=7
```

Position as the indexer reports it afterwards:

```
LIT-PERP  long  1008.80 LIT  entry 3.0129  mark 3.0117  notional 3038.23  uPnL -1.14
```

### Protection attached

Retried through the fixed adapter:

```
TPSL_PREVIEW LIT-PERP tp=3 sl=3 est_profit=+115.84 est_loss=-115.88 submit_button_disabled=false
TPSL_POST_SUBMIT {"modals":["Success: 2 triggers set 0.15 STT per trigger, refunded on cancel."]}
```

Confirmed independently against the venue's `StopOrder` table rather than the dialog text:

```
LIT  1792444456  PENDING  trigger=2922500000000000000   (2.9225 — stop loss, -3%)
LIT  1792444456  PENDING  trigger=3103200000000000000   (3.1032 — take profit, +3%)
```

Two pending triggers on the venue for the position this tool opened.

### Ledger

`data/ledger.jsonl` (gitignored) holds one JSON line per decision:

```json
{"ts":"2026-10-19T19:55:29.724Z","chainId":50383,"region":"tokyo","event":"open","pair":"LIT-PERP","side":"long","notional":3052.3601658,"carryPct":33.433690111050026,"ok":true,"value":3052.32,"margin":625.77}
{"ts":"2026-10-19T19:55:30.981Z","chainId":50383,"region":"tokyo","event":"protect","pair":"LIT-PERP","ok":false,"tp":"3","sl":"3"}
{"ts":"2026-10-19T19:55:38.983Z","chainId":50383,"region":"tokyo","event":"run"}
```

## Execution bugs found and fixed while building this

Both were found by running the tool against the live app, not by reading code.

**1. The Positions panel hides the TP/SL control below a desktop width.**
The app renders two variants of every position row: a table row that carries `Set TP/SL`, and a card
that carries only Share and Close. Below roughly 1536px the table row is `display: none`, so the
TP/SL button still exists in the DOM with a `0x0` box and every click fails with
`no bounding box for locator`. Fix: force a 1920x1080 viewport, and re-assert it after navigation
because the override is dropped on a full page load.

**2. `[aria-label="Set TP/SL"].first()` targets the wrong position.**
The positions table lists every open position, so the label matches one control per row. Taking
`.first()` opens whichever row sorts first — a run asked for LIT opened the NEAR dialog instead.
Fix: tag the control whose tightest containing ancestor names the requested pair, and click that.

Both fixes live in the order-ticket adapter, not in this repository, because that is where the
venue's UI-specific behaviour belongs.
