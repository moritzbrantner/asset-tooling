"""Inspect actual standalone PNGs and optional native tree renders; no generation."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".artifacts/leaf-artwork")
board = Image.new("RGB", (1576, 1050), "#20252b")
draw = ImageDraw.Draw(board)
draw.text((20, 12), "Leaf artwork: actual PNGs / saved alpha masks / existing GLB material finishing", fill="white")

def checker(size):
    image = Image.new("RGB", size, "#38434b")
    pen = ImageDraw.Draw(image)
    for y in range(0, size[1], 8):
        for x in range(0, size[0], 8):
            if (x // 8 + y // 8) % 2:
                pen.rectangle((x, y, x + 7, y + 7), fill="#59636a")
    return image

for row, shape in enumerate(["rounded", "slender", "broad"]):
    y = 50 + row * 128
    draw.text((20, y + 8), shape, fill="white")
    for column, variant in enumerate(["summer", "autumn", "mask"]):
        x = 160 + column * 360
        with Image.open(root / f"{shape}.{variant}.png") as source:
            rgba = source.convert("RGBA")
        for offset, size, resample in [(0, 96, Image.Resampling.NEAREST), (120, 64, Image.Resampling.NEAREST), (210, 32, Image.Resampling.LANCZOS)]:
            preview = rgba.resize((size, size), resample)
            background = checker((size, size))
            background.paste(preview, (0, 0), preview)
            board.paste(background, (x + offset, y))
        draw.text((x, y + 100), f"{variant}: 96 / 64 / 32 px", fill="white")

for column, name in enumerate(["source", "broad.summer", "broad.autumn", "slender.summer"]):
    filename = root / "tree" / name / "render.png"
    x, y = 10 + 394 * column, 502
    draw.text((x + 4, y - 22), name + " / native GLB", fill="white")
    if filename.exists():
        with Image.open(filename) as source:
            rgba = source.convert("RGBA")
        background = Image.new("RGB", rgba.size, "#30383f")
        background.paste(rgba, (0, 0), rgba)
        board.paste(background, (x, y))

draw.text((20, 1030), "Identical tree geometry and framing; palette-only alpha unchanged. Offline artwork evidence, not game approval or growth states.", fill="white")
board.save(root / "review.png")
print(root / "review.png")
