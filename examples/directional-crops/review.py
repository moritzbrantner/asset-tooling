"""Inspect actual pinned sprites at one declared world scale and ground anchor."""
import hashlib
import io
import json
import runpy
from pathlib import Path
from PIL import Image, ImageDraw

directory = Path(__file__).resolve().parents[2] / '.artifacts/directional-crops'
helpers = runpy.run_path(Path(__file__).resolve().parents[1] / 'render_review.py')


def review():
    outputs = json.loads((directory / 'outputs.json').read_text())['outputs']
    evidence = json.loads((directory / 'evidence.json').read_text())
    assert evidence['packageOnlyMatches'] and evidence['coldAtlasMatches']
    controls = evidence['parameters']
    assert controls['framing']['type'] == 'shared-orthographic'
    directions = {d['id']: d['viewDirection'] for d in evidence['directions']}
    atlas_bytes = (directory / 'atlas.json').read_bytes()
    atlas_ref = evidence['atlas']['result']['outputs']['manifest']
    assert len(atlas_bytes) == atlas_ref['byteLength'] and hashlib.sha256(atlas_bytes).hexdigest() == atlas_ref['sha256']
    atlas = json.loads(atlas_bytes)
    atlas_png = (directory / 'atlas.png').read_bytes()
    png_ref = evidence['atlas']['png']
    assert len(atlas_png) == png_ref['byteLength'] and hashlib.sha256(atlas_png).hexdigest() == png_ref['sha256']
    atlas_image = Image.open(io.BytesIO(atlas_png)).convert('RGBA')
    assert atlas_image.size == (atlas['width'], atlas['height'])
    sheet = Image.new('RGB', (1024, 1284), '#f5f4f0')
    draw = ImageDraw.Draw(sheet)
    states, views = ['early', 'mature-straw', 'harvested'], ['front', 'right', 'back', 'left']
    for row, state in enumerate(states):
        for column, direction in enumerate(views):
            name = f'{state}.{direction}'
            matches = [o for o in outputs if o['id'] == name]
            assert len(matches) == 1
            ref = matches[0]['image']
            assert ref['metadata']['state'] == state and ref['metadata']['directionId'] == direction
            image, spec, receipt = helpers['read_verified_render'](directory / name, ref['metadata']['source'], ref, f'corn.{state}.sprite.{direction}')
            assert spec['parameters']['arguments'] == {**controls, 'viewDirection': directions[direction]}
            render = receipt['observations']['script']
            assert ref['metadata']['render'] == render
            assert render['framing']['worldUnitsPerPixel'] == 1.5 / 256
            assert render['framing']['pivot'] == [0, 0, 0]
            assert image.size == (256, 384)
            entries = [entry for entry in atlas['sprites'] if entry['id'] == name]
            assert len(entries) == 1
            entry = entries[0]
            assert entry['source']['metadata']['originalSource'] == ref
            assert entry['pivot'] == render['pivot'] and entry['sourceSize'] == {'width': 256, 'height': 384}
            rect, offset = entry['rect'], entry['trimOffset']
            reconstructed = Image.new('RGBA', image.size)
            reconstructed.paste(atlas_image.crop((rect['x'], rect['y'], rect['x'] + rect['width'], rect['y'] + rect['height'])), (offset['x'], offset['y']))
            original_pixels = image.tobytes()
            rebuilt_pixels = reconstructed.tobytes()
            assert original_pixels[3::4] == rebuilt_pixels[3::4], 'atlas must preserve every alpha value'
            for index in range(0, len(original_pixels), 4):
                if original_pixels[index + 3]:
                    assert original_pixels[index:index + 4] == rebuilt_pixels[index:index + 4], 'atlas must preserve every visible pixel'
            # Trimming intentionally drops invisible RGB outside the alpha bounds.
            # Original PNG/canonical-frame bytes remain pinned in their packages.
            left, top = column * 256, row * 428
            draw.text((left + 10, top + 10), name, fill='#18232f')
            draw.text((left + 10, top + 26), '1.5m span / common ground pivot', fill='#18232f')
            sheet.paste(Image.alpha_composite(Image.new('RGBA', image.size, '#f5f4f0'), image).convert('RGB'), (left, top + 44))
            x, y = left + render['pivot']['x'], top + 44 + render['pivot']['y']
            draw.line((x - 5, y, x + 5, y), fill='#506a77')
            draw.line((x, y - 5, x, y + 5), fill='#506a77')
    helpers['reconcile_review'](directory / 'review.png', sheet)
    print(json.dumps({'nativeRenders': 12, 'commonWorldSpan': 1.5, 'review': str(directory / 'review.png')}))


try:
    review()
except Exception:
    (directory / 'review.png').unlink(missing_ok=True)
    raise
