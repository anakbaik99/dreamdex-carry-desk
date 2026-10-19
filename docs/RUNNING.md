# Running CarryDesk

## Why a browser is involved

On Somnia Tokyo testnet the trading account is a smart wallet. The key you hold locally is **not an
owner** of that wallet on chain 50383, so a locally signed `execTransaction` reverts with `GS026`.
The dreamDEX app holds a Privy session that signs for it.

That single fact shapes the whole execution path: CarryDesk does not sign anything. It drives the
app's own order ticket in a browser that is already signed in, and the app does the signing.

Reads are unaffected — markets, funding history and positions all come from the public indexer over
GraphQL and need no session.

## Prerequisites

```
Node.js 20+
Chromium (or Chrome) started with --remote-debugging-port=9222
A dreamDEX account signed in inside that browser on the Tokyo region
```

Start the browser with remote debugging, on a machine that can reach `app.testnet.dreamdex.io`:

```bash
chromium --remote-debugging-port=9222 \
         --user-data-dir="$HOME/.cache/carrydesk-profile" \
         https://app.testnet.dreamdex.io
```

Then sign in once, and leave the browser running. CarryDesk connects to it over CDP and reuses the
existing session — it never asks for a password or a key.

```bash
npm install
npx playwright install chromium   # only if Playwright launches the browser itself
```

## Verify before trading

```bash
export DD_ACCOUNT=0x...          # the smart wallet the app trades through
node src/cli.mjs doctor
```

`doctor` checks four things and names any that fail:

```
chain          : 50383 (tokyo)
indexer        : ok
perp markets   : 21
open positions : 6
account        : 0x...
adapter perp-ui-order.mjs     : present
adapter perp-ui-close.mjs     : present
adapter perp-ui-tpsl.mjs      : present
```

If `open positions` reports `n/a`, the indexer is reachable but the account has no rows under that
address — check `DD_ACCOUNT` casing is irrelevant (it is lowercased) but the address must be the
smart wallet, not the login EOA.

If the adapter line says `MISSING`, `DD_WORKSPACE` points somewhere without the ticket drivers.
Leave it unset to use the ones vendored in `adapters/`.

## The browser must be wide enough

The app renders two variants of every position row:

| viewport | row variant | has `Set TP/SL` |
|---|---|---|
| >= ~1536px | table | yes |
| narrower | card | no — only Share and Close |

Below that width the TP/SL control still exists in the DOM with a `0x0` box, so clicking it fails
with `no bounding box for locator`. The `adapters/perp-ui-tpsl.mjs` driver forces a 1920x1080
viewport for this reason. If `run --live` opens a position but the protect step fails, check the
browser width first.

## Order lifecycle

```
scan   indexer only        no browser, no session
plan   indexer + account   no browser
run    indexer + account + browser
```

A full `run --live` cycle that opens one position and attaches protection takes roughly 60-120
seconds: the ticket needs time to arm, and the venue's own confirmation modal has to settle.

## What can go wrong

| symptom | cause |
|---|---|
| `paged` target not found / connect refused | browser not running with `--remote-debugging-port=9222` |
| order button disabled, `available` looks low | account is below initial margin; no new position can be opened |
| `no bounding box for locator` on TP/SL | browser narrower than ~1536px |
| position opened, protect failed | TP/SL submitted but the indexer had not indexed it yet — re-check `StopOrder` after ~90s |
| `TPSL_ERROR protection group missing` | the shared tab was parked on another market mid-dialog; re-run the adapter |
