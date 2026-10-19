# X posts

Drafts for the MVP submission. Each is under X's 280-character limit (URLs weighted at 23).

Post them from the build account, then paste the links into the `## X posts` section of the
[README](../README.md).

---

## Post 1 — what it does

```
Most perp bots chase price. CarryDesk harvests funding.

On dreamDEX, funding settles positive in nearly every interval we measured: longs pay shorts. So the book holds the collecting side. The hard part is doing that without blowing up.

github.com/anakbaik99/dreamdex-carry-desk
@DreamDEXSomnia
```

## Post 2 — live evidence

```
Live on Somnia Tokyo testnet, not a mockup:

LIT-PERP long, 3,052 USDso notional @ 3.0129.
Protection attached at the venue: TP 3.1032 / SL 2.9225 — confirmed as 2 StopOrder rows on chain, not a UI toast.

@DreamDEXSomnia
```

## Post 3 — the risk model

```
Perps on dreamDEX are cross-margined: one margin bank per account. Adding a position can liquidate an unrelated one.

CarryDesk sizes at account level: per-position cap, gross budget, free-margin floor, smallest wins. Reports a shock buffer, not a fake liq price.

@DreamDEXSomnia
```

---

## Notes on accuracy

Every number in the drafts is checkable against this repository:

| claim | where |
|---|---|
| funding settles positive in nearly every interval | `node src/cli.mjs scan`, and the measured rates in the README |
| LIT-PERP long, 3,052 USDso, entry 3.0129 | `docs/EVIDENCE.md` |
| TP 3.1032 / SL 2.9225 as StopOrder rows | `docs/EVIDENCE.md` |
| cross-margined, one margin bank per account | `docs/ARCHITECTURE.md` |

Do not add numbers that are not in the repository. The bounty scores posts on accuracy, and a
figure that cannot be reproduced is worse than no figure.
