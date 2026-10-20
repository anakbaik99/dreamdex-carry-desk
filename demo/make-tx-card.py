#!/usr/bin/env python3
"""
Render the on-chain lifecycle card used as the image for X post 2.

Every value here was read back from the venue RPC with eth_getTransactionByHash and
eth_getBlockByNumber, not copied from a note: block number and timestamp come from the chain.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "tx-hashes.png"

W, H = 1440, 900
BG = (11, 13, 18)
FG = (232, 236, 244)
DIM = (138, 147, 166)
BLUE = (59, 130, 246)
LINE = (34, 39, 51)

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

TXS = [
    ("OPEN", 27878806, "2026-10-19 19:55:21Z",
     "0x2aa8406c2c5978e1409bf79e102dbed000a0c47a281c331d4c0d950e012a7fdb"),
    ("TP / SL ARMED", 27926132, "2026-10-19 21:14:16Z",
     "0x19cf0c18ee2782b31baa06e041a7a43a6c66e923991e1238faeb9d5a23f62781"),
    ("CLOSE (TP FILL)", 28012607, "2026-10-19 23:38:30Z",
     "0x5d8fab861ebde05699771f60ba62e268e6fdd837d572aabb5c6464ed10fc1962"),
]


def font(path, size):
    return ImageFont.truetype(path, size)


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # header rule
    d.rectangle([0, 0, W, 6], fill=BLUE)

    d.text((64, 58), "dreamDEX perps  ·  Somnia Tokyo testnet  ·  chain 50383", font=font(MONO, 22), fill=DIM)
    d.text((64, 104), "One position, opened and closed on chain", font=font(MONO_B, 44), fill=FG)
    d.text((64, 170), "LIT-PERP long 3,052 USDso  @  3.0129   ->   TP 3.1032   ->   +89.60 USDso",
           font=font(MONO, 22), fill=DIM)

    d.line([64, 214, W - 64, 214], fill=LINE, width=2)

    y = 250
    for label, block, ts, h in TXS:
        d.text((64, y), label, font=font(MONO_B, 22), fill=BLUE)
        d.text((300, y), f"block {block:,}", font=font(MONO, 21), fill=FG)
        d.text((575, y), ts, font=font(MONO, 21), fill=DIM)
        d.text((64, y + 40), h, font=font(MONO, 22), fill=FG)
        y += 124

    d.line([64, y - 12, W - 64, y - 12], fill=LINE, width=2)

    d.text((64, y + 26), "No public explorer serves chain 50383. Verify each hash against the venue RPC:",
           font=font(MONO, 20), fill=DIM)
    d.text((64, y + 62), 'eth_getTransactionByHash  →  api.hideki2.infra.testnet.somnia.network',
           font=font(MONO, 20), fill=FG)
    d.text((64, H - 62), "CarryDesk  ·  github.com/anakbaik99/dreamdex-carry-desk", font=font(MONO, 18), fill=DIM)

    img.save(OUT)
    print(f"wrote {OUT}  {img.size[0]}x{img.size[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
