"""Measure rendered frames: line pitch, glyph height, and margins."""
import sys

from PIL import Image

for path in sys.argv[1:]:
    im = Image.open(path).convert("L")
    w, h = im.size
    px = im.load()
    bands = []
    for y in range(54, h):
        n = sum(1 for x in range(0, w, 2) if px[x, y] > 90)
        if n:
            if bands and y == bands[-1][-1] + 1:
                bands[-1].append(y)
            else:
                bands.append([y])
    heights = [b[-1] - b[0] + 1 for b in bands]
    tops = [b[0] for b in bands]
    pitches = [t2 - t1 for t1, t2 in zip(tops, tops[1:])]
    xs = []
    for y in range(54, h, 2):
        for x in range(0, w, 2):
            if px[x, y] > 90:
                xs.append(x)
    print(f"{path.split('/')[-1]:12} size={w}x{h} bands={len(bands)} "
          f"glyph_h={max(heights) if heights else 0} pitch={max(set(pitches), key=pitches.count) if pitches else 0} "
          f"right_margin={w - max(xs) if xs else '-'} bottom_margin={h - (bands[-1][-1] if bands else h)}")
