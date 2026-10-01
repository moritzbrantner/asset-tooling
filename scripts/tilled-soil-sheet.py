"""Compose actual tiled channel PNGs and native PBR renders for artifact inspection."""
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / ".artifacts" / "tilled-soil"
names = ("soil-tilled-shallow", "soil-tilled-deep", "soil-tilled-crosswise")
channels = ("color", "height", "normal", "roughness")
sheet = Image.new("RGB", (1500, 1060), "#f5f4f0")
draw = ImageDraw.Draw(sheet)
draw.text((15, 10), "Actual tilled-soil channels (2x2 tiles) and complete PBR review quads (two UV repeats)", fill="#18232f")
for row, name in enumerate(names):
    y = 50 + row * 330
    draw.text((15, y), name, fill="#18232f")
    for column, channel in enumerate(channels):
        with Image.open(root / f"{name}-{channel}.png") as source:
            image = source.convert("RGB")
        tiled = Image.new("RGB", (image.width * 2, image.height * 2))
        for tile_y in range(2):
            for tile_x in range(2):
                tiled.paste(image, (tile_x * image.width, tile_y * image.height))
        x = 15 + column * 270
        sheet.paste(tiled.resize((256, 256)), (x, y + 22))
        draw.text((x, y + 282), channel, fill="#18232f")
    with Image.open(root / f"{name}-preview.png") as source:
        sheet.paste(source.convert("RGB").resize((320, 320)), (1110, y - 5))
sheet.save(root / "review.png")
print(root / "review.png")
