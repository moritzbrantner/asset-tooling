"""Compare native PNG pixels with pinned canonical images in a 2D text fixture."""
import base64
import hashlib
import io
import json
import runpy
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[2]
directory = root / '.artifacts/paper-grain'
helpers = runpy.run_path(root / 'examples/render_review.py')


def review():
    outputs = json.loads((directory / 'outputs.json').read_text())['outputs']
    evidence = json.loads((directory / 'evidence.json').read_text())
    assert evidence['coldReplayMatches'] and evidence['packageOnlyMatches']
    assert evidence['channels'] == ['color'] and evidence['geometryStagesExecuted'] == 0
    assert evidence['normalStagesExecuted'] == evidence['roughnessStagesExecuted'] == 0
    assert len(outputs) == 6 and len({o['id'] for o in outputs}) == 6
    sheet = Image.new('RGB', (960, 1020), '#ffffff')
    heading = ImageDraw.Draw(sheet)
    heading.text((18, 12), 'Actual repeated paper PNGs: warm / cool. Producer text fixture, not a product theme.', fill='#202c39')
    font = ImageFont.truetype('DejaVuSans.ttf', 22)
    for index, output in enumerate(outputs):
        name, ref = output['id'], output['image']
        source = ref['metadata']['source']
        raw = (directory / f'{name}.rgba.json').read_bytes()
        png = (directory / f'{name}.png').read_bytes()
        for payload, pin in [(raw, source), (png, ref)]:
            assert len(payload) == pin['byteLength'] and hashlib.sha256(payload).hexdigest() == pin['sha256']
        canonical = json.loads(raw)
        pixels = base64.b64decode(canonical['pixelsBase64'], validate=True)
        image = Image.open(io.BytesIO(png)).convert('RGBA')
        assert image.size == (canonical['width'], canonical['height']) == (256, 256)
        assert image.tobytes() == pixels and all(alpha == 255 for alpha in pixels[3::4])
        surface = ref['metadata']['surface']
        assert surface['outputs'] == {'color': source}
        assert surface['recipe']['low'] == ([220, 228, 235] if name.endswith('-cool') else [231, 226, 215])
        assert surface['recipe']['high'] == ([238, 244, 249] if name.endswith('-cool') else [247, 244, 237])
        assert ref['metadata']['encoding']['inputs']['source'] == source
        tile = Image.new('RGBA', (480, 320))
        for y in range(0, 320, image.height):
            for x in range(0, 480, image.width):
                tile.paste(image, (x, y))
        draw = ImageDraw.Draw(tile)
        draw.text((20, 20), name, fill='#202c39', font=font)
        draw.text((20, 86), 'Quiet texture behind readable text', fill='#202c39', font=font)
        draw.text((20, 146), '01  02  03     Source stays editable', fill='#202c39', font=font)
        draw.text((20, 214), 'Color only / fixed seed / tiled PNG', fill='#202c39', font=font)
        sheet.paste(tile.convert('RGB'), ((index % 2) * 480, 52 + (index // 2) * 320))
    helpers['reconcile_review'](directory / 'review.png', sheet)
    print(json.dumps({'nativePngsIndependentlyMatched': 6, 'review': str(directory / 'review.png')}))


try:
    review()
except Exception:
    (directory / 'review.png').unlink(missing_ok=True)
    raise
