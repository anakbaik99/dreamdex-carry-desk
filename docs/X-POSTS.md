# X posts

Drafts for the MVP submission. Each is under X's 280-character limit (the repository URL is weighted
at 23 characters, which is how X counts links).

Post them from the build account, then replace the checkboxes in the README with the links.

---

## Post 1 — what it does

```
Most perp bots chase price. CarryDesk follows funding.

Funding on dreamDEX settled positive in nearly every interval we measured: longs pay shorts. The book holds that side. The risk model keeps it from becoming a 20x directional bet.

github.com/anakbaik99/dreamdex-carry-desk
@DreamDEXSomnia
```

## Post 2 — the full lifecycle, on chain

Attachment: `demo/tx-hashes.png` (regenerate with `python3 demo/make-tx-card.py`; block numbers and
timestamps in it are read back from the venue RPC, not copied from a note).

```
One position, opened and closed by its own trigger.

LIT-PERP long 3,052 USDso at 3.0129. TP 3.1032 filled on chain: +89.60 USDso.

Three hashes, no explorer needed - verify against the venue RPC.

@DreamDEXSomnia
```

## Post 3 — the gross cap, stated the way the code behaves

```
The cap gates new entries. It does not force an inherited book down - CarryDesk prints the breach instead of pretending the book is flat.

That cap is 150% of equity. The demo account sits well above it from positions CarryDesk did not open.

@DreamDEXSomnia
```

---

## Notes on accuracy

Every number is checkable against this repository:

| claim | source |
|---|---|
| funding settled positive in nearly every interval | `node src/cli.mjs scan`, and the measured rates in `docs/ARCHITECTURE.md` |
| LIT-PERP long, 3,052 USDso, entry 3.0129 | `docs/EVIDENCE.md`, step 1 |
| TP 3.1032 fired, +89.60 USDso | `docs/EVIDENCE.md`, step 2 |
| open tx `0x2aa8406c…` / close tx `0x5d8fab86…` | `docs/EVIDENCE.md`, transaction hashes |
| cross-margined, one margin bank per account | `docs/ARCHITECTURE.md` |
| the cap gates new entries only | `src/cli.mjs`, the `over gross cap` line in `status` and `plan` |

Two things not to claim in the posts:

- **Do not call it "risk-free carry" or "market-neutral".** It is funding-tilted and unhedged; a
  reviewer who knows perps will call that out immediately. The README says so explicitly.
- **Do not link a block explorer.** Chain 50383 has no public explorer — both Somnia explorers serve
  chain 50312 and return "Transaction not found". Give the hashes, not a dead link.
