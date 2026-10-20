#!/usr/bin/env python3
"""
Render a terminal-style demo video from the real command output captured in demo/raw/.

Nothing here invents output: every line comes from a `node src/cli.mjs ...` run recorded by
demo/capture.sh (or the equivalent shell loop). The only transformation is masking the smart
wallet address and truncating the scan table to its first rows.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
FRAMES = ROOT / "frames"
OUT = ROOT / "carrydesk-demo.mp4"

W, H = 1280, 720
FPS = 30
BG = (11, 14, 20)
CHROME = (21, 26, 35)
BORDER = (48, 54, 61)
TEXT = (201, 209, 217)
DIM = (110, 118, 129)
ACCENT = (88, 166, 255)
GREEN = (63, 185, 80)
AMBER = (210, 153, 34)
RED = (248, 81, 73)
WHITE = (240, 246, 252)

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FONT = ImageFont.truetype(FONT_PATH, 16)
FONT_SM = ImageFont.truetype(FONT_PATH, 13)
FONT_TITLE = ImageFont.truetype(FONT_BOLD, 44)
FONT_SUB = ImageFont.truetype(FONT_PATH, 19)
LH = 22
PAD = 26
TOP = 96

ADDRESS = "0xf428a46db589878bedebbb4b8a1dbb0854e92f26"
MASKED = "0xf428…f26"


def load(name, keep=None):
    p = RAW / f"{name}.txt"
    if not p.exists():
        sys.exit(f"missing raw output: {p}")
    lines = p.read_text().replace(ADDRESS, MASKED).replace(ADDRESS.upper(), MASKED).splitlines()
    if keep is not None:
        lines = lines[:keep]
    return lines


def color_for(line):
    s = line.strip()
    if not s:
        return DIM
    if re.fullmatch(r"-{5,}", s):
        return BORDER
    if s.startswith("$"):
        return GREEN
    if s.lower().startswith("dry run"):
        return AMBER
    if re.match(r"^(scan|status|plan|doctor|positions|open|keep|close)\b", s):
        return ACCENT
    if s.startswith("PAIR") or s.startswith("SIDE"):
        return DIM
    if "FAIL" in line:
        return RED
    if s in ("(none)",):
        return DIM
    return TEXT


def chrome(draw, title):
    draw.rectangle([0, 0, W, 44], fill=CHROME)
    draw.line([0, 44, W, 44], fill=BORDER)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        x = 22 + i * 22
        draw.ellipse([x - 6, 16, x + 6, 28], fill=c)
    draw.text((104, 14), title, font=FONT_SM, fill=DIM)
    right = "Somnia Tokyo testnet · chain 50383 · dry run"
    w = draw.textlength(right, font=FONT_SM)
    draw.text((W - w - 22, 14), right, font=FONT_SM, fill=(90, 98, 110))


def frame_with_scene(cmd_chars, lines, title="carrydesk — ~/dreamdex-carry-desk"):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, title)
    y = TOP
    if cmd_chars:
        d.text((PAD, y), "$ ", font=FONT, fill=GREEN)
        d.text((PAD + 18, y), cmd_chars, font=FONT, fill=WHITE)
        y += LH
    for line in lines:
        d.text((PAD, y), line, font=FONT, fill=color_for(line))
        y += LH
        if y > H - 40:
            break
    return img


def title_card(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, "carrydesk")
    d.text((PAD, 208), "CarryDesk", font=FONT_TITLE, fill=WHITE)
    d.text((PAD, 268), "Funding-ranked perps positions on dreamDEX", font=FONT_SUB, fill=ACCENT)
    d.text((PAD, 300), "Every market ranked by the funding it actually settled, then sized", font=FONT_SM, fill=DIM)
    d.text((PAD, 320), "against one cross-margined account.", font=FONT_SM, fill=DIM)
    bits = [
        ("21", "perp markets"),
        ("7d", "funding lookback"),
        ("1", "margin bank"),
    ]
    x = PAD
    for big, small in bits:
        d.text((x, 400), big, font=ImageFont.truetype(FONT_BOLD, 40), fill=WHITE)
        d.text((x, 450), small, font=FONT_SM, fill=DIM)
        x += 210
    d.text((PAD, 560), "github.com/anakbaik99/dreamdex-carry-desk", font=FONT, fill=DIM)
    return img


def end_card(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, "carrydesk")
    d.text((PAD, 214), "No order was placed in this recording.", font=FONT_TITLE, fill=WHITE)
    d.text((PAD, 282), "run is dry unless --live is passed; every live order is logged to data/ledger.jsonl.",
           font=FONT_SM, fill=DIM)
    d.text((PAD, 310), "The live evidence — open, TP/SL and the trigger that closed it — is in docs/EVIDENCE.md.",
           font=FONT_SM, fill=DIM)
    d.text((PAD, 388), "github.com/anakbaik99/dreamdex-carry-desk", font=FONT_SUB, fill=ACCENT)
    d.text((PAD, 430), "@DreamDEXSomnia", font=FONT_SUB, fill=GREEN)
    return img


def main():
    FRAMES.mkdir(exist_ok=True)
    for f in FRAMES.glob("*.png"):
        f.unlink()

    scan_all = load("scan")
    # keep the header, the first eight rows, then say how many were ranked
    scan_cut = scan_all[:4] + scan_all[4:12] + [f"  … {len(scan_all) - 4} markets ranked, floor 4%/yr"]

    scenes = [
        {"cmd": "node src/cli.mjs doctor", "lines": load("doctor"), "hold": 3.0},
        {"cmd": "node src/cli.mjs scan", "lines": scan_cut, "hold": 4.0},
        {"cmd": "node src/cli.mjs status", "lines": load("status"), "hold": 4.5},
        {"cmd": "node src/cli.mjs plan", "lines": load("plan"), "hold": 4.0},
        {"cmd": "node src/cli.mjs run", "lines": load("run", keep=9), "hold": 3.2},
    ]

    TYPE = 0.030  # seconds per typed character
    LINE = 0.115  # seconds between revealed output lines

    timeline = []  # (frames, kind, payload)
    TITLE_F, END_F = 2.8, 4.2
    timeline.append((int(TITLE_F * FPS), "title", None))

    for sc in scenes:
        total = len(sc["cmd"]) * TYPE + len(sc["lines"]) * LINE + sc["hold"]
        timeline.append((int(total * FPS), "scene", sc))

    timeline.append((int(END_F * FPS), "end", None))

    idx = 0
    for n_frames, kind, sc in timeline:
        for f in range(n_frames):
            t = f / FPS
            if kind == "title":
                img = title_card(t)
            elif kind == "end":
                img = end_card(t)
            else:
                type_dur = len(sc["cmd"]) * TYPE
                if t < type_dur:
                    chars = sc["cmd"][: max(0, int(len(sc["cmd"]) * (t / type_dur)))]
                    img = frame_with_scene(chars + ("▌" if int(t * 3) % 2 == 0 else ""), [])
                else:
                    t2 = t - type_dur
                    shown = min(len(sc["lines"]), int(t2 / LINE) + 1)
                    img = frame_with_scene(sc["cmd"], sc["lines"][:shown])
            img.save(FRAMES / f"{idx:05d}.png")
            idx += 1

    print(f"frames: {idx}  duration: {idx / FPS:.1f}s")

    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(FPS),
            "-i", str(FRAMES / "%05d.png"),
            "-c:v", "libx264", "-preset", "slow", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(OUT),
        ],
        check=True,
    )
    print(f"wrote {OUT}  {OUT.stat().st_size / 1e6:.2f} MB")

    # a poster frame for the README
    poster = ROOT / "carrydesk-demo-poster.png"
    frame_with_scene("node src/cli.mjs scan", scan_cut[:9]).save(poster)
    print(f"wrote {poster}")


if __name__ == "__main__":
    main()
