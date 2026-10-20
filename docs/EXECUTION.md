# Execution paths

CarryDesk can reach the perps venue two ways. This document states which one the current build uses,
why, and what the official path requires.

## What the current build does

Orders are placed through the app's own order ticket, driven over CDP by Playwright
(`adapters/perp-ui-order.mjs`). It opens the ticket, fills size and side, reads the preview the app
renders, and clicks submit. Take-profit and stop-loss are attached the same way and then verified
against the venue's `StopOrder` table.

This works, and the evidence in [`EVIDENCE.md`](EVIDENCE.md) is the output of it. It is also the
weakest part of the design: it depends on a logged-in browser, on DOM structure that can change
without notice, and on a viewport wide enough to render the table variant of the positions panel.

**Why it was built this way.** The bot's own key is not an owner of the smart wallet. Signing a
position directly as `msg.sender` fails with `GS026` (invalid owner) from the Safe. The app signs
through the smart wallet's session, which the bot key cannot do.

## The official path: Link a Bot

The venue documents a first-class way to let a bot trade a wallet without custody:
[Link a Bot](https://app.dreamdex.io/docs/trading/common/link-a-bot), backed by
[Operators & Session Keys](https://app.dreamdex.io/docs/trading/spot/operators).

You paste the bot's **address** (never a private key) into the app for a chosen wallet. Access is
granted per wallet and, for perps, **per market**. The bot then signs with its own key and acts for
the owner through operator entrypoints:

| capability | linked bot |
|---|---|
| place, cancel, reduce orders for that wallet | yes |
| withdraw, send, or transfer the wallet's funds | no |
| trade the owner's other wallets | no — access is per wallet |
| arm take-profit / stop-loss **on the exchange** | no — only the wallet itself can |
| pay for its own gas | yes, from its own key |

Each capability is a separate grant keyed by function selector on the `OperatorPermissionsRegistry`,
so approving place does not approve cancel, and none of them touch custody: every fill settles to
the owner, never to the operator.

The open-source dreamDEX bot kit already works this way when `OWNER_ADDRESS` is set to the linked
wallet.

### What this means for CarryDesk

Switching to this path removes the browser from the execution loop entirely, and removes the `GS026`
failure mode along with it. It changes two things:

1. **Orders** go from "drive the ticket" to "sign `placeOrder*For` as the operator" — no DOM, no
   viewport, no logged-in session.
2. **Protection moves in-process.** A linked bot cannot arm exchange-side TP/SL, so the tool has to
   hold the levels itself: poll mark price, and when a level is crossed, submit the reduce. The
   planner already computes both levels per position; the executor needs a price watcher instead of
   a ticket driver.

That trade is worth naming honestly: exchange-side triggers survive the bot dying, bot-side triggers
do not. A hybrid is possible — arm the exchange trigger from the wallet (as this build does) and keep
the operator path for entries and exits.

### Status

Not implemented in this build. Implementing it needs three things that are each verifiable but not
yet done here:

- the perps contract's operator entrypoints and their exact signatures (the spot ones are
  `placeOrderFor` / `cancelOrderFor` / `reduceOrderFor`; the perps surface must be read from the
  deployed dispatcher, the same way the 13 audited selectors were);
- a per-market grant recorded for the bot address on the perps side;
- a signing loop with nonce and gas management for the bot key.

The UI path stays as the reference implementation precisely because it produces end-to-end evidence
today: an order opened, protected, and closed by its own trigger, all three verifiable on chain.
