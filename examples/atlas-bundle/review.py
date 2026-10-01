"""Inspect a pinned package using only packaged files and independent Pillow decoding."""
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw

directory = (Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else
             Path(__file__).resolve().parents[2] / ".artifacts" / "atlas-bundle")
output = directory / "review.png"

def review():
    package = directory / "package"
    expected = json.loads((directory / "package.ref.json").read_text())
    def pinned(ref, relative):
        file = package / relative
        assert not file.is_symlink() and not file.parent.is_symlink()
        data = file.read_bytes()
        assert len(data) == ref["byteLength"] and hashlib.sha256(data).hexdigest() == ref["sha256"]
        return data
    manifest = json.loads(pinned(expected, "manifest.json"))
    assert manifest["schemaVersion"] == 2 and manifest["profile"] == "sprite-atlas-png-v1"
    assert len(manifest["assets"]) == 6
    def resource(ref, extension):
        path = f"assets/{ref['sha256']}.{extension}"
        assert len(ref["sha256"]) == 64 and all(c in "0123456789abcdef" for c in ref["sha256"])
        return pinned(ref, path)
    def rgba(ref):
        assert ref["kind"] == "image" and ref["mediaType"] == "application/vnd.moritzbrantner.rgba8+json"
        assert any(r["source"] == ref and r["path"] == f"assets/{ref['sha256']}.rgba.json" for r in manifest["resources"])
        raw = json.loads(resource(ref, "rgba.json"))
        assert raw["schemaVersion"] == 1 and raw["alphaMode"] == "straight" and raw["colorSpace"] == "srgb"
        pixels = base64.b64decode(raw["pixelsBase64"], validate=True)
        assert len(pixels) == raw["width"] * raw["height"] * 4
        return Image.frombytes("RGBA", (raw["width"], raw["height"]), pixels)
    sheet = Image.new("RGB", (1210, 920), "#f5f4f0")
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 8), "Package-only consumer proof: each source frame (left) and PNG-atlas reconstruction (right)", fill="#18232f")
    frames = 0
    for row, entry in enumerate(manifest["assets"]):
        assert entry["path"] == f"assets/{entry['source']['sha256']}.atlas.json"
        atlas = json.loads(resource(entry["source"], "atlas.json"))
        encoded = entry["image"]
        assert encoded["path"] == f"assets/{encoded['source']['sha256']}.png"
        png = Image.open(io.BytesIO(resource(encoded["source"], "png"))).convert("RGBA")
        assert png.size == (atlas["width"], atlas["height"])
        assert png.tobytes() == rgba(atlas["image"]).tobytes()
        assert encoded["source"]["metadata"]["sourceSha256"] == atlas["image"]["sha256"]
        sprites = sorted(atlas["sprites"], key=lambda sprite: sprite["frame"]["index"])
        assert len(sprites) == 6 and all(not s["frame"]["loop"] for s in sprites)
        draw.text((12, 35 + row * 145), f"{entry['key']}/{entry['variant']}: explicit authored one-shot times", fill="#18232f")
        for column, sprite in enumerate(sprites):
            source = rgba(sprite["source"])
            assert source.size == (sprite["sourceSize"]["width"], sprite["sourceSize"]["height"])
            rect, offset = sprite["rect"], sprite["trimOffset"]
            logical = Image.new("RGBA", source.size)
            logical.paste(png.crop((rect["x"], rect["y"], rect["x"] + rect["width"], rect["y"] + rect["height"])), (offset["x"], offset["y"]))
            actual, original = logical.tobytes(), source.tobytes()
            for pixel in range(0, len(original), 4):
                assert actual[pixel + 3] == original[pixel + 3]
                if original[pixel + 3] > 0:
                    assert actual[pixel:pixel + 3] == original[pixel:pixel + 3]
            for side, image in enumerate([source, logical]):
                preview = image.resize((96, round(96 * image.height / image.width)), Image.Resampling.NEAREST)
                x, y = 12 + column * 198 + side * 98, 55 + row * 145
                sheet.paste(preview, (x, y), preview)
            frame = sprite["frame"]
            draw.text((12 + column * 198, 154 + row * 145), f"{frame['index']}: {frame['timeMs']} + {frame['durationMs']} ms", fill="#18232f")
            frames += 1
    encoded = io.BytesIO()
    sheet.save(encoded, format="PNG")
    data = encoded.getvalue()
    if not output.exists() or output.read_bytes() != data:
        output.write_bytes(data)
    print(json.dumps({"packageOnly": True, "atlasesDecoded": 6, "framesReconstructed": frames, "review": str(output)}))

if __name__ == "__main__":
    try:
        review()
    except Exception:
        output.unlink(missing_ok=True)
        raise
