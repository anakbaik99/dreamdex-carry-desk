#!/usr/bin/env python3
"""
Build the soundtrack for demo/carrydesk-demo.mp4 and mux it in.

Narration is synthesized locally with Piper (en_US-amy-medium), one clip per scene, fitted to that
scene's window from demo/timeline.json. A quiet keyboard bed plays while each command is typed, so
the recording sounds like a terminal without drowning the voice.

Nothing about the picture changes here: the video stream is copied.
"""
import json
import math
import re
import random
import struct
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
VO = ROOT / "vo"
TIMELINE = ROOT / "timeline.json"
VIDEO = ROOT / "carrydesk-demo.mp4"
OUT = ROOT / "carrydesk-demo-vo.mp4"
MIX = ROOT / "mix.wav"

PIPER = "/tmp/ttsenv/bin/piper"
MODEL = "/tmp/voices/en_US-amy-medium.onnx"
SR = 44100

# Narration is built from the same capture the picture comes from, so the spoken numbers and the
# screen can never disagree. A hardcoded percentage drifts the moment the market moves.
def scene_facts():
    scan = (RAW / "scan.txt").read_text()
    status = (RAW / "status.txt").read_text()
    top = re.search(r"^\s+([A-Z0-9]+-PERP)\s+\w+\s+[\d.]+\s+([\d.]+)%", scan, re.M)
    gross = re.search(r"\((\d+)% of equity\)", status)
    shorts = len(re.findall(r"^\s+[A-Z0-9]+-PERP\s+short\s", status, re.M))
    return {
        "pair": top.group(1).split("-")[0] if top else "the top market",
        "carry": round(float(top.group(2))) if top else None,
        "gross_x": round(float(gross.group(1)) / 100) if gross else None,
        "shorts": shorts,
    }


def build_narration():
    f = scene_facts()
    carry = f"{f['carry']} percent annualised" if f["carry"] else "the top rate"
    gross = f"around {f['gross_x']} times equity" if f["gross_x"] else "well above equity"
    return {
        "title": "CarryDesk. Funding-ranked perps.",
        "node src/cli.mjs doctor": "Doctor checks the chain, the indexer, and twenty one perp markets.",
        "node src/cli.mjs scan": f"Scan ranks by settled funding. {f['pair']} pays about {carry}; the tool holds the paid side.",
        "node src/cli.mjs status": f"Status shows the book this account already carries: {f['shorts']} shorts, gross {gross}.",
        "node src/cli.mjs plan": "Plan is pure. Keep what pays, close what lost its edge, open nothing below the floor.",
        "node src/cli.mjs run": "Run repeats it as a dry run. No order is sent in this recording.",
        "end": "The orders behind this tool, and the trigger that closed one, are on chain.",
    }


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def duration(path):
    r = run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ]
    )
    return float(r.stdout.strip())


def synth(text, out):
    run([PIPER, "-m", MODEL, "-f", str(out)], input=text)
    return out


def fit(src, dst, window):
    """Speed the clip up only as far as it needs, and report the raw length too."""
    d = duration(src)
    limit = max(0.8, window - 0.15)
    tempo = d / limit
    if tempo <= 1.02:
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ar", str(SR), "-ac", "1", str(dst)])
        return d, 1.0
    tempo = min(tempo, 1.30)  # beyond this the voice sounds clipped
    run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
            "-filter:a", f"atempo={tempo:.4f}", "-ar", str(SR), "-ac", "1", str(dst),
        ]
    )
    return d, tempo


def read_wav_mono(path):
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, f"unexpected wav format: {path}"
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    if rate != SR:
        raise SystemExit(f"{path}: expected {SR} Hz after conversion, got {rate}")
    return list(struct.unpack("<%dh" % (len(frames) // 2), frames))


def write_wav_mono(path, samples):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(struct.pack("<%dh" % len(samples), *samples))


def main():
    NARRATION = build_narration()
    tl = json.loads(TIMELINE.read_text())
    total = tl["duration"]
    n = int(total * SR) + SR // 10
    buf = [0.0] * n

    def add(samples, at_sec, gain=1.0):
        start = int(at_sec * SR)
        for i, s in enumerate(samples):
            j = start + i
            if 0 <= j < n:
                buf[j] += s * gain

    VO.mkdir(exist_ok=True)
    report = []
    for idx, sc in enumerate(tl["scenes"]):
        key = sc["kind"] if sc["kind"] in ("title", "end") else sc["cmd"]
        text = NARRATION.get(key)
        if not text:
            continue
        raw = VO / f"{idx:02d}-raw.wav"
        timed = VO / f"{idx:02d}.wav"
        synth(text, raw)
        window = sc["end"] - sc["start"]
        raw_d, tempo = fit(raw, timed, window)
        start_at = sc["start"] + 0.12
        add(read_wav_mono(timed), start_at)
        report.append((key, round(raw_d, 2), round(window, 2), round(tempo, 3), round(duration(timed), 2)))

    # Keyboard bed: soft clicks while each command is typed.
    random.seed(7)
    for sc in tl["scenes"]:
        if sc["kind"] != "scene" or not sc["type_seconds"]:
            continue
        t = sc["start"] + 0.02
        while t < sc["start"] + sc["type_seconds"]:
            click_len = int(0.006 * SR)
            burst = []
            for i in range(click_len):
                env = math.exp(-i / (0.0018 * SR))
                burst.append(random.uniform(-1, 1) * env * 2600)
            add(burst, t, gain=0.22)
            t += random.uniform(0.048, 0.082)

    # Normalise to -3 dBFS and add a short fade at both ends.
    peak = max(abs(x) for x in buf) or 1.0
    gain = (32767 * 0.70) / peak
    fade = int(0.25 * SR)
    for i in range(n):
        g = gain
        if i < fade:
            g *= i / fade
        if i > n - fade:
            g *= max(0.0, (n - i) / fade)
        buf[i] *= g

    write_wav_mono(MIX, [int(max(-32768, min(32767, x))) for x in buf])

    run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(VIDEO), "-i", str(MIX),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
            "-shortest", "-movflags", "+faststart",
            str(OUT),
        ]
    )

    print(f"{'scene':32} {'raw':>6} {'window':>7} {'tempo':>6} {'final':>6}")
    for key, raw_d, w, t, fin in report:
        flag = "  <-- over" if fin > w - 0.05 else ""
        print(f"{key:32} {raw_d:>6.2f} {w:>7.2f} {t:>6.3f} {fin:>6.2f}{flag}")
    print(f"\nwrote {OUT}  {OUT.stat().st_size / 1e6:.2f} MB  ({duration(OUT):.2f}s)")


if __name__ == "__main__":
    main()
