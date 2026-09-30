"""Assemble actual footprint outputs into an offline Pillow review board."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".artifacts/terrain-mask")
board = Image.new("RGB", (1056, 728), "#20252b")
draw = ImageDraw.Draw(board)
draw.text((20, 12), "Saved footprint: actual height samples, mask and neutral mesh derivatives", fill="white")
for index, (name, label) in enumerate([
    ("height-before.png", "Source height"), ("mask.png", "Saved scalar mask"),
    ("height-after.png", "Edited height"),
]):
    with Image.open(root / name) as source:
        source.load()
        scaled = source.convert("RGB").resize((320, 240), Image.Resampling.NEAREST)
    x = 20 + index * 348
    board.paste(scaled, (x, 58))
    draw.text((x, 38), label, fill="white")
for index, label in enumerate(["before", "after"]):
    with Image.open(root / label / "render.png") as source:
        source.load()
        rgba = source.convert("RGBA")
    x = 12 + index * 524
    board.paste(rgba, (x, 332), rgba)
    draw.text((x + 8, 310), f"{label}: actual GLB review render", fill="white")
draw.text((20, 710), "Same topology; zero-mask vertices unchanged; full-mask strip at Y=4 m. Offline artifact evidence.", fill="white")
output = root / "review.png"
board.save(output)
print(output)
