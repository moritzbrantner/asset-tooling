"""Verify actual PNG pixels independently and compose disposable inspection evidence."""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw

directory = (Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else
             Path(__file__).resolve().parents[2] / ".artifacts" / "wood-surfaces")
evidence = json.loads((directory / "evidence.json").read_text())
assert evidence["schemaVersion"] == 1 and len(evidence["variants"]) == 3
channels = ["color", "recolored", "height", "normal", "roughness"]
sheet = Image.new("RGB", (1520, 1020), "#f5f4f0")
draw = ImageDraw.Draw(sheet)
draw.text((16, 12), "Actual 2 x 2 repeats: long, short and crosswise grain; palette edit preserves data channels", fill="#18232f")
for row, variant in enumerate(evidence["variants"]):
    name = variant["id"]
    for column, channel in enumerate(channels):
        stem = directory / f"{name}-{channel}"
        png = stem.with_suffix(".png").read_bytes()
        raw = stem.with_suffix(".rgba.json").read_bytes()
        canonical = json.loads(raw)
        image_ref = (variant["partial"]["outputs"]["color"] if channel == "recolored" else
                     variant["result"]["outputs"][channel])
        png_ref = variant["recolored"] if channel == "recolored" else variant["pngs"][channel]
        for payload, ref in [(raw, image_ref), (png, png_ref)]:
            assert len(payload) == ref["byteLength"]
            assert hashlib.sha256(payload).hexdigest() == ref["sha256"]
        pixels = base64.b64decode(canonical["pixelsBase64"], validate=True)
        image = Image.open(io.BytesIO(png)).convert("RGBA")
        assert image.size == (canonical["width"], canonical["height"])
        assert image.tobytes() == pixels
        tiled = Image.new("RGBA", (image.width * 2, image.height * 2))
        for y in range(2):
            for x in range(2):
                tiled.paste(image, (x * image.width, y * image.height))
        tiled = tiled.resize((280, 280), Image.Resampling.NEAREST)
        position = (16 + column * 302, 50 + row * 320)
        sheet.paste(tiled, position)
        draw.text((position[0], position[1] + 285), f"{name}: {channel}", fill="#18232f")

def reconcile(image, output):
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    data = encoded.getvalue()
    if not output.exists() or output.read_bytes() != data:
        output.write_bytes(data)

reconcile(sheet, directory / "review.png")
renders = [directory / "renders" / variant["id"] / "render.png" for variant in evidence["variants"]]
if all(render.exists() for render in renders):
    native = Image.new("RGB", (1568, 554), "#f5f4f0")
    labels = ImageDraw.Draw(native)
    for index, (render, variant) in enumerate(zip(renders, evidence["variants"])):
        image = Image.open(render).convert("RGBA")
        assert image.size == (512, 512)
        native.paste(image, (8 + index * 520, 28), image)
        labels.text((8 + index * 520, 8), variant["id"], fill="#18232f")
    reconcile(native, directory / "native-review.png")
print(json.dumps({"pngsIndependentlyMatched": 15, "review": str(directory / "review.png"), "nativeRenders": sum(p.exists() for p in renders)}))
