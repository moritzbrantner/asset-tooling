"""Compose actual recipe PNGs for offline inspection; Pillow is only an inspection dependency."""
from pathlib import Path
from PIL import Image, ImageDraw

directory = Path(__file__).resolve().parent.parent / ".artifacts" / "surface-preservation"
names = ["accepted-color", "recolored-color", "accepted-height", "accepted-roughness", "accepted-normal", "normal-edited-normal"]
sheet = Image.new("RGB", (1080, 760), "#f5f4f0")
draw = ImageDraw.Draw(sheet)
draw.text((20, 10), "Actual tiled surface outputs: palette edit preserves height/normal/roughness; normal edit preserves palette/height", fill="#18232f")
for index, name in enumerate(names):
    source = Image.open(directory / f"{name}.png").convert("RGBA")
    tiled = Image.new("RGBA", (source.width * 2, source.height * 2))
    for y in range(2):
        for x in range(2):
            tiled.paste(source, (x * source.width, y * source.height))
    tiled.thumbnail((320, 320))
    x, y = 20 + (index % 3) * 360, 45 + (index // 3) * 355
    sheet.paste(tiled, (x, y), tiled)
    draw.text((x, y + 324), name, fill="#18232f")
output = directory / "review.png"
sheet.save(output)
print(output)
