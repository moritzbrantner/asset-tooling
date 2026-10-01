"""Review actual tree-component renders without changing the asset recipe."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw
root = Path(sys.argv[1] if len(sys.argv) > 1 else ".artifacts/trees")
board = Image.new("RGB", (1576, 1120), "#20252b")
draw = ImageDraw.Draw(board)
draw.text((20, 10), "Sapling: actual GLB component renders / pinned offline generator", fill="white")
for row, family in enumerate(["broadleaf", "conifer"]):
    for column, component in enumerate(["composed", "trunk", "branches", "foliage"]):
        x, y = 10 + 394 * column, 50 + 536 * row
        draw.text((x + 6, y - 18), f"{family}: {component}", fill="white")
        with Image.open(root / family / component / "render.png") as source:
            rgba = source.convert("RGBA")
        board.paste(rgba, (x, y), rgba)
draw.text((20, 1104), "Independent framing per component. Native branch hierarchy; shared bark material; ground root. Offline evidence.", fill="white")
board.save(root / "review.png")
print(root / "review.png")
