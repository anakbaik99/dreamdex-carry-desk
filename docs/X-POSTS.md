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

```
One position, opened and then closed by its own trigger.

LIT-PERP long 3,052 USDso @ 3.0129. TP at 3.1032 fired on chain: +89.60 USDso.

open  0x2aa8406c2c5978e1409bf79e102dbed0
close 0x5d8fab861ebde05699771f60ba62e

@DreamDEXSomnia
```

## Post 3 — the risk model

```
dreamDEX perps are cross-margined: one margin bank per account, so a new position can liquidate an unrelated one.

CarryDesk sizes at account level: per-position cap, gross budget, free-margin floor, smallest wins. Reports a shock buffer, not a fake liq price.

@DreamDEXSomnia
```

---

## Notes on accuracy

Every number is checkable against this repository:

| claim | source |
|---|---|
| funding settled positive in nearly every interval | `node src/cli.mjs scan`, and the measured rates in `docs/ARCHITECTURE.md` |
| LIT-PERP long, 3,052 USDso, entry 3.0129 | `docs/EVIDENCE.md`, cycle 1 |
| TP 3.1032 fired, +89.60 USDso | `docs/EVIDENCE.md`, cycle 2 |
| open tx `0x2aa8406c…` / close tx `0x5d8fab86…` | `docs/EVIDENCE.md`, transaction hashes |
| cross-margined, one margin bank per account | `docs/ARCHITECTURE.md` |

Two things not to claim in the posts:

- **Do not call it "risk-free carry" or "market-neutral".** It is funding-tilted and unhedged; a
  reviewer who knows perps will call that out immediately. The README says so explicitly.
- **Do not link a block explorer.** Chain 50383 has no public explorer — both Somnia explorers serve
  chain 50312 and return "Transaction not found". Give the hashes, not a dead link.
