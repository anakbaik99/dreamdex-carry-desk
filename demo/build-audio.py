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
VO = ROOT / "vo"
TIMELINE = ROOT / "timeline.json"
VIDEO = ROOT / "carrydesk-demo.mp4"
OUT = ROOT / "carrydesk-demo-vo.mp4"
MIX = ROOT / "mix.wav"

PIPER = "/tmp/ttsenv/bin/piper"
MODEL = "/tmp/voices/en_US-amy-medium.onnx"
SR = 44100

# One line per scene, matched on the command (or the title / end cards).
NARRATION = {
    "title": "CarryDesk. Funding-ranked perps on dreamDEX.",
    "node src/cli.mjs doctor": "Doctor checks the chain, the indexer, and twenty one perp markets.",
    "node src/cli.mjs scan": "Scan ranks markets by settled funding. BTC pays eighty two percent, and the tool holds the paid side.",
    "node src/cli.mjs status": "Status shows the book this account already carries. Five shorts, gross at thirteen times equity, and a two and a half percent shock buffer.",
    "node src/cli.mjs plan": "Plan is pure. Keep what pays, close what lost its edge, open nothing below the floor.",
    "node src/cli.mjs run": "Run repeats it as a dry run. No order is sent in this recording.",
    "end": "The orders behind this tool, and the trigger that closed one, are on chain. Evidence is in the repo.",
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
    """Speed the clip up if it overruns its window; never stretch it."""
    d = duration(src)
    limit = max(0.8, window - 0.25)
    tempo = d / limit
    if tempo <= 1.02:
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ar", str(SR), "-ac", "1", str(dst)])
        return 1.0
    tempo = min(tempo, 1.45)  # beyond this the voice sounds clipped
    run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
            "-filter:a", f"atempo={tempo:.4f}", "-ar", str(SR), "-ac", "1", str(dst),
        ]
    )
    return tempo


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
        tempo = fit(raw, timed, window)
        start_at = sc["start"] + 0.12
        add(read_wav_mono(timed), start_at)
        report.append((key, round(duration(timed), 2), round(window, 2), round(tempo, 3)))

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
            "-c:a", "aac", "-b:a", "128k",
            "-shortest", "-movflags", "+faststart",
            str(OUT),
        ]
    )

    print(f"{'scene':32} {'vo':>6} {'window':>7} {'tempo':>6}")
    for key, d, w, t in report:
        print(f"{key:32} {d:>6.2f} {w:>7.2f} {t:>6.3f}")
    print(f"\nwrote {OUT}  {OUT.stat().st_size / 1e6:.2f} MB  ({duration(OUT):.2f}s)")


if __name__ == "__main__":
    main()
