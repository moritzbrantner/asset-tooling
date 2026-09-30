"""Compose actual gray/warm rock-family renders into artifact inspection evidence."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / ".artifacts" / "rock-materials"
ids = ("rounded", "angular", "flat", "boulder")
canvas = Image.new("RGB", (1104, 628), "#eeeae4")
draw = ImageDraw.Draw(canvas)
draw.text((18, 12), "Actual GLBs: shared gray / warm PNG colors, unchanged master geometry. One fixed camera and light.", fill="#242424")
for row, palette in enumerate(("gray", "warm")):
    for column, asset_id in enumerate(ids):
        source = Image.open(root / palette / f"{asset_id}-preview.png").convert("RGB")
        assert source.size == (512, 512)
        source.thumbnail((256, 256))
        x, y = 18 + column * 272, 38 + row * 292
        canvas.paste(source, (x, y))
        draw.text((x, y + 262), f"{asset_id} / {palette}", fill="#242424")
output = root / "review.png"
canvas.save(output)
print(output)
