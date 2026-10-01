"""Inspect actual base-color and complete PBR GLBs under the existing fixed native view."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / ".artifacts"
ids = ("rounded", "angular", "flat", "boulder")
rows = (("Base-color finishing / original PBR factors", root / "rock-materials" / "gray"),
        ("Complete grainy set / declared normal + roughness / neutral AO + dielectric metallic", root / "rock-pbr" / "rock-grainy"),
        ("Complete layered set / same geometry / changed surface channels", root / "rock-pbr" / "rock-layered"))
canvas = Image.new("RGB", (1104, 980), "#eeeae4")
draw = ImageDraw.Draw(canvas)
for row, (label, directory) in enumerate(rows):
    y = 12 + row * 320
    draw.text((18, y), label, fill="#242424")
    for column, asset_id in enumerate(ids):
        with Image.open(directory / f"{asset_id}-preview.png") as opened:
            source = opened.convert("RGB")
        assert source.size == (512, 512)
        source.thumbnail((256, 256))
        x = 18 + column * 272
        canvas.paste(source, (x, y + 24))
        draw.text((x, y + 286), asset_id, fill="#242424")
output = root / "rock-pbr" / "review.png"
canvas.save(output)
print(output)
