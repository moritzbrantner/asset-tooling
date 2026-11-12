"""Before/after board for a partial terrain rebuild (#139).

python examples/terrain-patches/partial-review.py <beforeDir> <afterDir> <board.jpg>

Rows are the two builds; columns are the stitched height, the meadow paint mask with flower detail and the exclusion mask with grass detail.
Each column title says whether its files and detail instances are identical between the two builds.
"""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

before, after, target = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
SCALE, GAP = 3, 28
COLORS = {"grass": (120, 200, 90), "flowers": (250, 210, 60), "stones": (190, 190, 200)}


def load(root):
    manifest = json.loads((root / "manifest.json").read_text())
    return manifest, manifest["patches"]


def patch_dir(root, p):
    return root / f"patch_{p['patch'][0]}_{p['patch'][1]}"


def same(name):
    """Whether a file (or `layer:<id>` detail instances) is identical in both builds."""
    found = []
    for root in (before, after):
        _, patches = load(root)
        if name.startswith("layer:"):
            found.append([[i for i in json.loads((patch_dir(root, p) / "detail.json").read_text())["instances"] if i["layer"] == name[6:]] for p in patches])
        else:
            found.append([hashlib.sha256((patch_dir(root, p) / name).read_bytes()).hexdigest() for p in patches])
    return found[0] == found[1]


def panel(root, image_name, layers):
    manifest, patches = load(root)
    w, d = manifest["samples"]
    xs, zs = sorted({p["patch"][0] for p in patches}), sorted({p["patch"][1] for p in patches})
    width, depth = len(xs) * (w - 1) + 1, len(zs) * (d - 1) + 1
    out, stretch = Image.new("RGB", (width * SCALE, depth * SCALE)), False
    for p in patches:
        image = Image.open(patch_dir(root, p) / image_name)
        if image.mode.startswith("I"):  # 16-bit height steps
            image, stretch = image.convert("I").point(lambda v: v / 256).convert("L"), True
        image = image.convert("RGB").resize((w * SCALE, d * SCALE), Image.NEAREST)
        out.paste(image, (xs.index(p["patch"][0]) * (w - 1) * SCALE, zs.index(p["patch"][1]) * (d - 1) * SCALE))
    if stretch:  # the same heights stretch the same way in both rows
        out = ImageOps.autocontrast(out)
    draw = ImageDraw.Draw(out)
    x0, z0 = min(p["origin"][0] for p in patches), min(p["origin"][1] for p in patches)
    spacing = manifest["sampleSpacing"]
    for p in patches:
        for inst in json.loads((patch_dir(root, p) / "detail.json").read_text())["instances"]:
            if inst["layer"] in layers:
                x, z = (inst["position"][0] - x0) / spacing * SCALE, (inst["position"][2] - z0) / spacing * SCALE
                draw.ellipse((x - 1.5, z - 1.5, x + 1.5, z + 1.5), fill=COLORS.get(inst["layer"], (255, 255, 255)))
    return out


columns = [
    ("height", "height.png", [], ["height.png", "mesh.glb"]),
    ("meadow mask + flowers", "paint-meadow.png", ["flowers"], ["paint-meadow.png", "layer:flowers"]),
    ("exclusion mask + grass", "exclusion.png", ["grass"], ["exclusion.png", "layer:grass"]),
]
panels = [[panel(root, image, layers) for _, image, layers, _ in columns] for root in (before, after)]
pw, ph = panels[0][0].size
board = Image.new("RGB", (GAP * 4 + len(columns) * (pw + GAP), 2 * (ph + GAP) + GAP), (32, 32, 32))
draw = ImageDraw.Draw(board)
for c, (title, _, _, files) in enumerate(columns):
    left = GAP * 4 + c * (pw + GAP)
    note = "" if not files else ("  (identical)" if all(same(f) for f in files) else "  (changed)")
    draw.text((left, 8), title + note, fill=(230, 230, 230))
    for r, label in enumerate(("before", "after")):
        board.paste(panels[r][c], (left, GAP + r * (ph + GAP)))
        if c == 0:
            draw.text((6, GAP + r * (ph + GAP) + ph // 2), label, fill=(230, 230, 230))
board.save(target, quality=85)
