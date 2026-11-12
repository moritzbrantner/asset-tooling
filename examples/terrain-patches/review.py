"""Stitch each patch's height and mask PNGs into one board: python examples/terrain-patches/review.py <outDir> <board.jpg>."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

root, target = Path(sys.argv[1]), Path(sys.argv[2])
manifest = json.loads((root / "manifest.json").read_text())
patches = manifest["patches"]
maps = ["height.png", "slope.png", "exclusion.png"] + sorted(n for n in patches[0]["files"] if n.startswith("paint-"))
xs = sorted({p["patch"][0] for p in patches})
zs = sorted({p["patch"][1] for p in patches})
w, d = manifest["samples"]
scale, gap = 3, 24
board = Image.new("RGB", (len(maps) * (len(xs) * w * scale + gap) + gap, len(zs) * d * scale + 2 * gap), (32, 32, 32))
draw = ImageDraw.Draw(board)
for m, name in enumerate(maps):
    left = gap + m * (len(xs) * w * scale + gap)
    draw.text((left, 6), name, fill=(230, 230, 230))
    for p in patches:
        image = Image.open(root / f"patch_{p['patch'][0]}_{p['patch'][1]}" / name)
        if image.mode.startswith("I"):  # 16-bit height steps: stretch the declared range to 8 bits
            image = image.convert("I").point(lambda v: v / 256).convert("L")
        image = image.convert("RGB").resize((w * scale, d * scale), Image.NEAREST)
        board.paste(image, (left + xs.index(p["patch"][0]) * w * scale, gap + zs.index(p["patch"][1]) * d * scale))
board.save(target, quality=85)
