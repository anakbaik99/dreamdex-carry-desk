#!/usr/bin/env python3
"""
Render the terminal demo from the real command output captured in demo/raw/.

Nothing here invents output: every line comes from a `node src/cli.mjs ...` run. Transformations are
limited to masking 40-hex addresses, wrapping lines that are wider than the frame, and truncating the
scan table to its first rows (the omitted count is computed, not guessed).

Layout is sized for a phone feed: 1440x810, 21px mono, 28px line pitch, so the text fills the frame
instead of sitting in the top-left corner.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
FRAMES = ROOT / "frames"
OUT = ROOT / "carrydesk-demo.mp4"

W, H = 1440, 810
FPS = 30
BG = (11, 14, 20)
CHROME = (21, 26, 35)
BORDER = (48, 54, 61)
TEXT = (201, 209, 217)
DIM = (122, 130, 142)
ACCENT = (88, 166, 255)
GREEN = (63, 185, 80)
AMBER = (222, 168, 60)
RED = (248, 81, 73)
WHITE = (240, 246, 252)

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FONT = ImageFont.truetype(FONT_PATH, 21)
FONT_SM = ImageFont.truetype(FONT_PATH, 16)
FONT_CAP = ImageFont.truetype(FONT_PATH, 17)
FONT_TITLE = ImageFont.truetype(FONT_BOLD, 58)
FONT_SUB = ImageFont.truetype(FONT_PATH, 24)
FONT_STAT = ImageFont.truetype(FONT_BOLD, 44)

PAD = 30
CHROME_H = 52
TOP = 112
LH = 28
MAX_W = W - 2 * PAD
CAP_TOP = H - 96

ADDRESS_MASK = re.compile(r"0x[0-9a-fA-F]{40}")


def mask(text):
    """Mask any 40-hex address, so a captured transcript can never publish a wallet."""
    return ADDRESS_MASK.sub(lambda m: m.group(0)[:6] + "…" + m.group(0)[-3:], text)


def load(name, keep=None):
    p = RAW / f"{name}.txt"
    if not p.exists():
        sys.exit(f"missing raw output: {p}")
    lines = mask(p.read_text()).splitlines()
    if keep is not None:
        lines = lines[:keep]
    return lines


def wrap(line, font, width=MAX_W):
    """Wrap on spaces so a long line never runs off the right edge."""
    if font.getlength(line) <= width:
        return [line]
    out, cur = [], ""
    for word in line.split(" "):
        trial = (cur + " " + word).strip() if cur else word
        if font.getlength(trial) <= width:
            cur = trial
        else:
            if cur:
                out.append(cur)
            cur = " " * (len(line) - len(line.lstrip())) + word if not out else word
    if cur:
        out.append(cur)
    return out


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
    if s == "(none)":
        return DIM
    return TEXT


def chrome(draw, title):
    draw.rectangle([0, 0, W, CHROME_H], fill=CHROME)
    draw.line([0, CHROME_H, W, CHROME_H], fill=BORDER)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        x = 26 + i * 24
        draw.ellipse([x - 7, 19, x + 7, 33], fill=c)
    draw.text((126, 17), title, font=FONT_SM, fill=DIM)
    right = "Somnia Tokyo testnet · chain 50383 · no live order in this recording"
    w = draw.textlength(right, font=FONT_SM)
    draw.text((W - w - 26, 17), right, font=FONT_SM, fill=(96, 104, 116))


def caption_block(draw, lines):
    """Amber note pinned above the bottom edge, with a hairline above it."""
    if not lines:
        return
    draw.line([PAD, CAP_TOP - 12, W - PAD, CAP_TOP - 12], fill=(60, 52, 30))
    y = CAP_TOP
    for line in lines:
        for part in wrap(line, FONT_CAP):
            draw.text((PAD, y), part, font=FONT_CAP, fill=AMBER)
            y += 22


def frame_with_scene(cmd_chars, lines, caption=None, title="carrydesk — freshly cloned repo"):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, title)
    y = TOP
    if cmd_chars:
        d.text((PAD, y), "$ ", font=FONT, fill=GREEN)
        d.text((PAD + 26, y), cmd_chars, font=FONT, fill=WHITE)
        y += LH
    for line in lines:
        for part in wrap(line, FONT):
            if y > CAP_TOP - 40:
                break
            d.text((PAD, y), part, font=FONT, fill=color_for(line))
            y += LH
    caption_block(d, caption)
    return img


def market_count():
    """Read the market count from doctor's own output instead of hardcoding it."""
    for line in load("doctor"):
        m = re.search(r"perp markets\s*:\s*(\d+)", line)
        if m:
            return int(m.group(1))
    return None


def title_card(markets):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, "carrydesk")
    d.text((PAD, 210), "CarryDesk", font=FONT_TITLE, fill=WHITE)
    d.text((PAD, 292), "Funding-ranked perps on dreamDEX", font=FONT_SUB, fill=ACCENT)
    d.text((PAD, 336), "Ranks every market by the funding it actually settled, then sizes", font=FONT, fill=DIM)
    d.text((PAD, 366), "against one cross-margined account.", font=FONT, fill=DIM)
    bits = [(str(markets or "?"), "perp markets"), ("7d", "funding lookback"), ("1", "margin bank")]
    x = PAD
    for big, small in bits:
        d.text((x, 452), big, font=FONT_STAT, fill=WHITE)
        d.text((x, 508), small, font=FONT_SM, fill=DIM)
        x += 240
    d.text((PAD, 640), "github.com/anakbaik99/dreamdex-carry-desk", font=FONT, fill=DIM)
    return img


def end_card():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    chrome(d, "carrydesk")
    d.text((PAD, 216), "No order was placed here.", font=FONT_TITLE, fill=WHITE)
    d.text((PAD, 300), "run is dry unless --live is passed; live orders are logged to data/ledger.jsonl.", font=FONT, fill=DIM)
    d.text((PAD, 336), "The real orders — open, TP/SL, and the trigger that closed it — are on chain:", font=FONT, fill=DIM)
    d.text((PAD, 372), "docs/EVIDENCE.md", font=FONT, fill=ACCENT)
    d.text((PAD, 460), "github.com/anakbaik99/dreamdex-carry-desk", font=FONT_SUB, fill=WHITE)
    d.text((PAD, 506), "@DreamDEXSomnia", font=FONT_SUB, fill=GREEN)
    return img


def scan_scene_lines(rows_shown=8):
    """Header + first rows, an exact omitted-row count, then the real closing sentence."""
    lines = load("scan")
    body = [l for l in lines if re.match(r"^  [A-Z0-9]+-PERP\s", l)]
    head = lines[:4]  # blank, title, rule, column header
    summary = [l for l in lines if "markets cleared the floor" in l]
    omitted = len(body) - rows_shown
    out = head + body[:rows_shown]
    if omitted > 0:
        out.append(f"  … {omitted} more rows")
    out += [""] + summary
    return out


STATUS_CAPTION = [
    "These five shorts were opened by this account's earlier sessions — nothing here is a live order.",
    "1337% is gross notional ÷ equity on one cross-margined margin bank; funding received is negative (−68.07 USDso / 7d).",
]


def main():
    FRAMES.mkdir(exist_ok=True)
    for f in FRAMES.glob("*.png"):
        f.unlink()

    markets = market_count()

    scenes = [
        {"cmd": "node src/cli.mjs doctor", "lines": load("doctor"), "hold": 3.2, "caption": None},
        {"cmd": "node src/cli.mjs scan", "lines": scan_scene_lines(), "hold": 4.2, "caption": None},
        {"cmd": "node src/cli.mjs status", "lines": load("status"), "hold": 5.0, "caption": STATUS_CAPTION},
        {"cmd": "node src/cli.mjs plan", "lines": load("plan"), "hold": 4.0, "caption": None},
        {"cmd": "node src/cli.mjs run", "lines": load("run", keep=9), "hold": 3.4, "caption": None},
    ]

    TYPE = 0.030  # seconds per typed character
    LINE = 0.115  # seconds between revealed output lines

    timeline = []
    TITLE_F, END_F = 2.8, 4.4
    timeline.append((int(TITLE_F * FPS), "title", None))
    for sc in scenes:
        total = len(sc["cmd"]) * TYPE + len(sc["lines"]) * LINE + sc["hold"]
        timeline.append((int(total * FPS), "scene", sc))
    timeline.append((int(END_F * FPS), "end", None))

    marks = []
    at = 0.0
    for n_frames, kind, sc in timeline:
        marks.append(
            {
                "kind": kind,
                "start": round(at, 3),
                "end": round(at + n_frames / FPS, 3),
                "cmd": (sc or {}).get("cmd"),
                "type_seconds": round(len(sc["cmd"]) * TYPE, 3) if sc else None,
                "lines": len(sc["lines"]) if sc else None,
                "caption": bool((sc or {}).get("caption")),
            }
        )
        at += n_frames / FPS
    (ROOT / "timeline.json").write_text(
        json.dumps({"fps": FPS, "duration": round(at, 3), "markets": markets, "scenes": marks}, indent=2)
    )

    idx = 0
    for n_frames, kind, sc in timeline:
        for f in range(n_frames):
            t = f / FPS
            if kind == "title":
                img = title_card(markets)
            elif kind == "end":
                img = end_card()
            else:
                type_dur = len(sc["cmd"]) * TYPE
                if t < type_dur:
                    chars = sc["cmd"][: max(0, int(len(sc["cmd"]) * (t / type_dur)))]
                    img = frame_with_scene(chars + ("▌" if int(t * 3) % 2 == 0 else ""), [], sc["caption"])
                else:
                    t2 = t - type_dur
                    shown = min(len(sc["lines"]), int(t2 / LINE) + 1)
                    img = frame_with_scene(sc["cmd"], sc["lines"][:shown], sc["caption"])
            img.save(FRAMES / f"{idx:05d}.png")
            idx += 1

    print(f"frames: {idx}  duration: {idx / FPS:.1f}s  markets: {markets}")

    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(FPS), "-i", str(FRAMES / "%05d.png"),
            "-c:v", "libx264", "-preset", "slow", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(OUT),
        ],
        check=True,
    )
    print(f"wrote {OUT}  {OUT.stat().st_size / 1e6:.2f} MB")

    poster = ROOT / "carrydesk-demo-poster.png"
    frame_with_scene("node src/cli.mjs scan", scan_scene_lines()[:11]).save(poster)
    print(f"wrote {poster}")


if __name__ == "__main__":
    main()
