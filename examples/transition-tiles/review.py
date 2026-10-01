"""Inspect actual pinned atlas pixels with Pillow; never select gameplay tiles."""
import base64
import hashlib
import io
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / ".artifacts/transition-tiles"
OUTPUT = DIRECTORY / "review.png"

# Independent authored N,E,S,W ports in NW,NE,SE,SW corner order.
PORTS = {
    "0000": ("00", "00", "00", "00"), "0001": ("00", "00", "10", "01"),
    "0010": ("00", "01", "01", "00"), "0011": ("00", "01", "11", "01"),
    "0100": ("01", "10", "00", "00"), "0101": ("01", "10", "10", "01"),
    "0110": ("01", "11", "01", "00"), "0111": ("01", "11", "11", "01"),
    "1000": ("10", "00", "00", "10"), "1001": ("10", "00", "10", "11"),
    "1010": ("10", "01", "01", "10"), "1011": ("10", "01", "11", "11"),
    "1100": ("11", "10", "00", "10"), "1101": ("11", "10", "10", "11"),
    "1110": ("11", "11", "01", "10"), "1111": ("11", "11", "11", "11"),
}


def checked_bytes(ref, paths, payload=None):
    assert re.fullmatch(r"[0-9a-f]{64}", ref["sha256"])
    assert 0 < ref["byteLength"] <= 8 * 1024 * 1024
    if payload is None:
        sha = ref["sha256"]
        declared = paths[sha]
        assert declared == f"review-inputs/{sha}.json"
        payload = (DIRECTORY / declared).read_bytes()
    assert len(payload) == ref["byteLength"]
    assert hashlib.sha256(payload).hexdigest() == ref["sha256"]
    return payload


def rgba(ref, paths):
    document = json.loads(checked_bytes(ref, paths))
    assert document["colorSpace"] == "srgb" and document["alphaMode"] == "straight"
    return Image.frombytes("RGBA", (document["width"], document["height"]),
                           base64.b64decode(document["pixelsBase64"], validate=True))


def edges(image):
    w, h = image.size
    return [image.crop(box).tobytes() for box in
            [(0, 0, w, 1), (w - 1, 0, w, h), (0, h - 1, w, h), (0, 0, 1, h)]]


def inspect_atlas(evidence, filename, expected_tiles, paths):
    atlas = json.loads(checked_bytes(evidence["manifest"], paths))
    png = checked_bytes(evidence["png"], paths, (DIRECTORY / filename).read_bytes())
    assert evidence["png"]["metadata"]["sourceSha256"] == atlas["image"]["sha256"]
    image = Image.open(io.BytesIO(png)).convert("RGBA")
    assert image.size == (atlas["width"], atlas["height"])
    assert image.tobytes() == rgba(atlas["image"], paths).tobytes()
    assert len(atlas["sprites"]) == len(expected_tiles)
    originals = {}
    for entry, tile in zip(atlas["sprites"], expected_tiles):
        assert entry["source"] == tile["image"]
        assert entry["id"] == "corners." + tile["corners"]
        assert entry["pivot"] == {"x": 0, "y": 0}
        assert entry["trimOffset"] == {"x": 0, "y": 0} and not entry["rotated"]
        original = rgba(entry["source"], paths)
        assert original.getchannel("A").getextrema() == (255, 255)
        rect = entry["rect"]
        x, y, w, h = [rect[k] for k in ("x", "y", "width", "height")]
        assert original.size == (w, h) == (65, 65)
        assert image.crop((x, y, x + w, y + h)).tobytes() == original.tobytes()
        for yy in range(-1, h + 1):
            for xx in range(-1, w + 1):
                assert image.getpixel((x + xx, y + yy)) == original.getpixel(
                    (max(0, min(w - 1, xx)), max(0, min(h - 1, yy))))
        # Transparent padding outside the one-pixel extrusion has no neighbor bleed.
        assert image.getpixel((x - 2, y - 2))[3] == 0
        c = entry["source"]["metadata"]["connection"]
        assert tuple(c["ports"][side] for side in ("north", "east", "south", "west")) == PORTS[tile["corners"]]
        originals[tile["corners"]] = original
    return originals


def review():
    evidence = json.loads((DIRECTORY / "evidence.json").read_text())
    paths = evidence["reviewInputs"]
    full = inspect_atlas(evidence["complete"], "complete.png", evidence["full"]["tiles"], paths)
    selected = inspect_atlas(evidence["packed"], "selected.png", evidence["selected"]["tiles"], paths)
    repacked = inspect_atlas(evidence["repacked"], "repacked.png", evidence["selected"]["tiles"], paths)
    assert set(full) == set(PORTS) and len(selected) == 12
    assert all(selected[k].tobytes() == repacked[k].tobytes() == full[k].tobytes() for k in selected)
    compatible = 0
    for a, first in full.items():
        for b, second in full.items():
            for side in range(4):
                expected = PORTS[a][side] == PORTS[b][(side + 2) % 4]
                assert (edges(first)[side] == edges(second)[(side + 2) % 4]) == expected
                compatible += expected
    assert compatible == 256
    board = Image.new("RGBA", (970, 670), (245, 244, 240, 255))
    draw = ImageDraw.Draw(board)
    draw.text((20, 16), "All 16 corner pieces (NW, NE, SE, SW; 0 soil, 1 grass)", fill="black")
    for index, key in enumerate(sorted(full)):
        x, y = 20 + (index % 4) * 116, 48 + (index // 4) * 140
        board.alpha_composite(full[key].resize((104, 104), Image.Resampling.NEAREST), (x, y))
        draw.text((x, y + 110), key, fill="black")
    draw.text((520, 16), "Selected 12-piece island with inner soil corner", fill="black")
    grid = evidence["grid"]
    for size, position in [(65, (520, 48)), (32, (520, 368)), (16, (720, 368))]:
        scaled = {k: im.resize((size, size), Image.Resampling.BILINEAR) for k, im in selected.items()}
        for y, row in enumerate(grid):
            for x, key in enumerate(row):
                if x < len(row) - 1:
                    assert edges(scaled[key])[1] == edges(scaled[row[x + 1]])[3]
                if y < len(grid) - 1:
                    assert edges(scaled[key])[2] == edges(scaled[grid[y + 1][x]])[0]
                board.alpha_composite(scaled[key], (position[0] + x * size, position[1] + y * size))
        draw.text((position[0], position[1] + len(grid) * size + 12), f"{size}px per tile; bilinear", fill="black")
    draw.text((520, 560), "256 native compatible directed boundaries: byte-exact", fill="black")
    draw.text((520, 580), "Atlas PNG reconstructs every source + extrusion exactly", fill="black")
    draw.text((520, 600), "Cosmetic connectivity only; no gameplay selection", fill="black")
    board.convert("RGB").save(OUTPUT)
    print(json.dumps({"compatibleBoundaries": compatible, "completeTiles": 16,
                      "selectedTiles": 12, "scales": [16, 32, 65], "output": str(OUTPUT.relative_to(ROOT))}))


if __name__ == "__main__":
    try:
        review()
    except Exception:
        OUTPUT.unlink(missing_ok=True)
        raise
