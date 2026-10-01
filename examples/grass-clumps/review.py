"""Inspect pinned native grass renders at one world scale and ground pivot."""
import json
import runpy
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
directory = root / '.artifacts/grass-clumps'
helpers = runpy.run_path(root / 'examples/render_review.py')


def review():
    assets = json.loads((directory / 'assets.json').read_text())
    evidence = json.loads((directory / 'evidence.json').read_text())
    assert evidence['packageOnlyMatches']
    assert evidence['unit'] == 'meter' and evidence['origin'] == 'native-root-ground-anchor'
    assert evidence['consumerPlacementAuthority'] is False
    sheet = Image.new('RGB', (1152, 430), '#f5f4f0')
    draw = ImageDraw.Draw(sheet)
    for index, name in enumerate(['short', 'bent', 'tuft']):
        source, ref = assets['meshes'][name], assets['images'][name]
        image, spec, receipt = helpers['read_verified_render'](directory / f'{name}-render', source, ref, f'grass.{name}.render')
        assert ref['metadata']['render'] == receipt['observations']['script']
        assert spec['parameters']['arguments']['framing'] == {'type': 'shared-orthographic', 'center': [0, .22, 0], 'horizontalSpan': 1.25, 'pivot': [0, 0, 0]}
        assert image.size == (384, 384)
        render = receipt['observations']['script']
        assert render['framing']['worldUnitsPerPixel'] == 1.25 / 384
        point = render['pivot']
        assert evidence['evidence'][name]['bounds']['min'][1] >= -1e-5
        assert source['metadata']['geometry']['wind'] == 'none'
        assert source['metadata']['presetId'] == name
        left = index * 384
        draw.text((left + 10, 10), f'{name}: native authored grass clump', fill='#18232f')
        draw.text((left + 10, 26), '1.25m shared span / native ground pivot', fill='#18232f')
        sheet.paste(Image.alpha_composite(Image.new('RGBA', image.size, '#f5f4f0'), image).convert('RGB'), (left, 44))
        x, y = left + point['x'], 44 + point['y']
        draw.line((x - 5, y, x + 5, y), fill='#506a77')
        draw.line((x, y - 5, x, y + 5), fill='#506a77')
    helpers['reconcile_review'](directory / 'review.png', sheet)
    print(json.dumps({'nativeRenders': 3, 'commonWorldSpan': 1.25, 'review': str(directory / 'review.png')}))


try:
    review()
except Exception:
    (directory / 'review.png').unlink(missing_ok=True)
    raise
