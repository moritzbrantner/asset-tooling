"""Inspect actual example PNG atlas using its logical trim metadata. Pillow is preview-only."""
import json
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / ".artifacts/sprite-atlas"
manifest = json.loads((DIRECTORY / "atlas.json").read_text())
atlas = Image.open(DIRECTORY / "atlas.png").convert("RGBA")
sprites = {}
for entry in manifest["sprites"]:
    rect, size, offset = entry["rect"], entry["sourceSize"], entry["trimOffset"]
    logical = Image.new("RGBA", (size["width"], size["height"]))
    if not entry["empty"]:
        crop = atlas.crop((rect["x"], rect["y"], rect["x"] + rect["width"], rect["y"] + rect["height"]))
        logical.paste(crop, (offset["x"], offset["y"]))
    standalone = Image.open(DIRECTORY / (entry["id"] + ".png")).convert("RGBA")
    # Alpha and visible color must round-trip; trimming intentionally discards fully hidden RGB.
    original_bytes, restored_bytes = standalone.tobytes(), logical.tobytes()
    for offset in range(0, len(original_bytes), 4):
        original, restored = original_bytes[offset:offset + 4], restored_bytes[offset:offset + 4]
        assert original[3] == restored[3] and (original[3] == 0 or original == restored)
    sprites[entry["id"]] = logical

board = ["#####", "#@ .#", "# $ #", "#   #", "#####"]
review = Image.new("RGB", (780, 590), "#f7f4ee")
draw = ImageDraw.Draw(review)
draw.text((20, 16), "Actual PNG atlas: logical reconstruction, broad and narrow sizes", fill="#253540")
draw.text((20, 42), "Square crate / filled player / ring target retain non-color cues", fill="#253540")
for scale, origin, label in [(64, (20, 85), "64 px tiles / 2x output"), (32, (380, 85), "32 px tiles / narrow output")]:
    layer = Image.new("RGBA", (5 * 64, 5 * 64))
    for y, row in enumerate(board):
        for x, char in enumerate(row):
            layer.alpha_composite(sprites["wall" if char == "#" else "floor"], (x * 64, y * 64))
            if char in "@$.":
                layer.alpha_composite(sprites[{"@": "player", "$": "crate", ".": "target"}[char]], (x * 64, y * 64))
    scaled = layer.resize((5 * scale, 5 * scale), Image.Resampling.LANCZOS)
    review.paste(scaled, origin, scaled)
    draw.text((origin[0], origin[1] + 5 * scale + 10), label, fill="#253540")
draw.text((20, 454), "Standalone player token on light and dark backgrounds", fill="#253540")
for x, background in [(20, "#ffffff"), (110, "#182331")]:
    tile = Image.new("RGBA", (64, 64), background)
    tile.alpha_composite(sprites["player"])
    review.paste(tile, (x, 480))
review.save(DIRECTORY / "review.png")
print(DIRECTORY / "review.png")
