"""Compare actual source PNGs with independently reconstructed packed frames."""
import base64
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / ".artifacts/authored-effect-sequences"
evidence = json.loads((root / "evidence.json").read_text())
board = Image.new("RGB", (1510, 930), "#20252b")
draw = ImageDraw.Draw(board)
draw.text((16, 12), "Explicit authored poses / original PNG (left) versus packed reconstruction (right) / fixed source pixel pivot", fill="white")

def reconcile(filename, data):
    if not filename.exists() or filename.read_bytes() != data:
        filename.write_bytes(data)

def image_from_files(directory, name, ref):
    data = (directory / f"{name}.rgba.json").read_bytes()
    assert sha256(data).hexdigest() == ref["sha256"] and len(data) == ref["byteLength"]
    source = json.loads(data)
    with Image.open(directory / f"{name}.png") as png:
        actual = png.convert("RGBA")
    assert actual.size == (source["width"], source["height"])
    assert actual.tobytes() == base64.b64decode(source["pixelsBase64"], validate=True)
    return actual

def preview(image):
    backdrop = Image.new("RGB", (96, 96), "#454b53")
    pattern = ImageDraw.Draw(backdrop)
    for y in range(0, 96, 12):
        for x in range(0, 96, 12):
            if (x // 12 + y // 12) % 2:
                pattern.rectangle((x, y, x + 11, y + 11), fill="#2e343b")
    ratio = min(96 / image.width, 96 / image.height)
    scaled = image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.NEAREST)
    backdrop.paste(scaled, ((96 - scaled.width) // 2, (96 - scaled.height) // 2), scaled)
    return backdrop

checked = 0
for row, sequence in enumerate(evidence["sequences"]):
    result = sequence["result"]
    name = result["recipe"]["sequence"]
    directory = root / name
    manifest_bytes = (directory / "atlas.json").read_bytes()
    manifest_ref = result["atlas"]["result"]["outputs"]["manifest"]
    assert sha256(manifest_bytes).hexdigest() == manifest_ref["sha256"] and len(manifest_bytes) == manifest_ref["byteLength"]
    manifest = json.loads(manifest_bytes)
    atlas = image_from_files(directory, "atlas", manifest["image"])
    checked += 1
    top = 45 + row * 142
    draw.text((16, top + 36), name, fill="white")
    draw.text((16, top + 54), f'{result["durationMs"]}ms / one shot', fill="#aab4c0")
    animation = []
    durations = []
    for column, entry in enumerate(manifest["sprites"]):
        source = image_from_files(directory, entry["id"], entry["source"])
        checked += 1
        packed = Image.new("RGBA", source.size)
        rect, offset = entry["rect"], entry["trimOffset"]
        if not entry["empty"]:
            cropped = atlas.crop((rect["x"], rect["y"], rect["x"] + rect["width"], rect["y"] + rect["height"]))
            packed.paste(cropped, (offset["x"], offset["y"]))
        assert packed.getchannel("A").tobytes() == source.getchannel("A").tobytes()
        source_bytes, packed_bytes = source.tobytes(), packed.tobytes()
        for index in range(0, len(source_bytes), 4):
            if source_bytes[index + 3]:
                assert source_bytes[index:index + 4] == packed_bytes[index:index + 4]
        assert entry["frame"]["loop"] is False
        x = 164 + column * 220
        left, right = preview(source), preview(packed)
        board.paste(left, (x, top)); board.paste(right, (x + 100, top))
        draw.text((x, top + 101), f'{entry["frame"]["index"]}: {entry["frame"]["timeMs"]}ms +{entry["frame"]["durationMs"]}ms', fill="white")
        frame = Image.new("RGB", (216, 132), "#20252b")
        frame.paste(left, (8, 8)); frame.paste(right, (112, 8))
        ImageDraw.Draw(frame).text((8, 111), f'{name} / {entry["frame"]["timeMs"]}ms', fill="white")
        animation.append(frame); durations.append(entry["frame"]["durationMs"])
    assert not any(source.getchannel("A").tobytes())
    buffer = BytesIO()
    animation[0].save(buffer, format="WEBP", save_all=True, append_images=animation[1:], duration=durations, loop=1, lossless=True)
    reconcile(directory / "review.webp", buffer.getvalue())
draw.text((16, 910), "All42 PNGs match canonical bytes; visible pixels/alpha reconstruct exactly. Off remains blank. Playback and accessibility stay with runtime owners.", fill="white")
buffer = BytesIO(); board.save(buffer, format="PNG")
reconcile(root / "review.png", buffer.getvalue())
print(json.dumps({"checkedPngs": checked, "review": str(root / "review.png")}))
