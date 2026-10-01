"""Overlay saved candidate coordinates/masks beside actual native scenery renders."""
from io import BytesIO
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw
root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / ".artifacts/instance-exclusion"
candidates = json.loads((root / "candidates.json").read_text())["instances"]
board = Image.new("RGB", (1576, 880), "#20252b")
draw = ImageDraw.Draw(board)
draw.text((20, 12), "Saved exclusion guides / original candidate IDs and positions / actual native GLBs", fill="white")
for column, name in enumerate(["path", "edited"]):
    x = 10 + 788 * column
    selected = json.loads((root / f"{name}.instances.json").read_text())["instances"]
    ids = {i["id"] for i in selected}
    with Image.open(root / f"{name}.mask.png") as mask:
        sx, sy = (mask.width - 1) / 539, (mask.height - 1) / 299
        preview = mask.convert("RGB").transform((540, 300), Image.Transform.AFFINE, (sx, 0, .5 - sx / 2, 0, sy, .5 - sy / 2), resample=Image.Resampling.NEAREST)
    overlay = ImageDraw.Draw(preview)
    for instance in candidates:
        px, _, pz = instance["positionMicro"]
        sx = (px + 6000000) * 539 / 11999999
        sy = (pz + 4000000) * 299 / 7999999
        color = "#45e98c" if instance["id"] in ids else "#fb5266"
        overlay.ellipse((sx - 3, sy - 3, sx + 3, sy + 3), fill=color)
    board.paste(preview, (x + 114, 52))
    draw.text((x + 114, 32), f"{name}: {len(selected)}/48 kept / green kept; red excluded", fill="white")
    with Image.open(root / name / "render.png") as source:
        rgba = source.convert("RGBA")
    background = Image.new("RGB", rgba.size, "#30383f")
    background.paste(rgba, (0, 0), rgba)
    board.paste(background, (x, 368))
draw.text((20, 860), "Five localized removals; all surviving XYZ/IDs unchanged. Flat cosmetic review; no navigation, collision or consumer approval.", fill="white")
buffer = BytesIO()
board.save(buffer, format="PNG")
output = root / "review.png"
if not output.exists() or output.read_bytes() != buffer.getvalue():
    output.write_bytes(buffer.getvalue())
print(output)
