"""Offline review of the example's actual PNG derivatives; Pillow is not the asset renderer."""
from pathlib import Path
import json
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / ".artifacts/render-derivatives"
atlas = Image.open(root / "icons.png").convert("RGBA")
manifest = json.loads((root / "icons-atlas.json").read_text())
for entry in manifest["sprites"]:
    rect, offset, size = entry["rect"], entry["trimOffset"], entry["sourceSize"]
    logical = Image.new("RGBA", (size["width"], size["height"]))
    cropped = atlas.crop((rect["x"], rect["y"], rect["x"] + rect["width"], rect["y"] + rect["height"]))
    logical.paste(cropped, (offset["x"], offset["y"]))
    source = Image.open(root / entry["id"] / "render.png").convert("RGBA")
    original, restored = source.tobytes(), logical.tobytes()
    for index in range(0, len(original), 4):
        assert original[index + 3] == restored[index + 3]
        assert original[index + 3] == 0 or original[index:index + 4] == restored[index:index + 4]
review = Image.new("RGB", (900, 680), "#f5f3ef")
draw = ImageDraw.Draw(review)
draw.text((20, 15), "Actual source-derived PNGs: fixed source framing, Standard sRGB, pinned Cycles CPU", fill="#263341")
for row, source in enumerate(("avocado", "rock")):
    for column, preset in enumerate(("icon", "thumbnail", "perspective")):
        x, y = 20 + column * 295, 50 + row * 310
        image = Image.open(root / (source + "-" + preset) / "render.png").convert("RGBA")
        original_size = image.size
        image.thumbnail((270, 255), Image.Resampling.LANCZOS)
        background = Image.new("RGBA", (270, 255), "#ece9e2")
        tile_draw = ImageDraw.Draw(background)
        for ty in range(0, 255, 16):
            for tx in range(0, 270, 16):
                if (ty // 16 + tx // 16) % 2:
                    tile_draw.rectangle((tx, ty, tx + 15, ty + 15), fill="#dcd8cf")
        background.alpha_composite(image, ((270 - image.width) // 2, (255 - image.height) // 2))
        review.paste(background, (x, y))
        draw.text((x, y + 267), f"{source} / {preset} / {original_size[0]}x{original_size[1]}", fill="#263341")
review.save(root / "review.png")
print(root / "review.png")
