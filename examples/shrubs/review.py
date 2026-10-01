"""Inspect pinned native shrub renders at one world scale and ground pivot."""
import json
import runpy
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
directory = root / '.artifacts/shrubs'
helpers = runpy.run_path(root / 'examples/render_review.py')


def review():
    assets = json.loads((directory / 'assets.json').read_text())
    evidence = json.loads((directory / 'evidence.json').read_text())
    assert evidence['packageOnlyMatches'] and evidence['componentGeometryMatches']
    assert evidence['unit'] == 'meter' and evidence['origin'] == 'native-root-ground-anchor'
    assert evidence['consumerPlacementAuthority'] is False
    sheet = Image.new('RGB', (960, 430), '#f5f4f0')
    draw = ImageDraw.Draw(sheet)
    for index, name in enumerate(['compact', 'upright', 'loose']):
        source, ref = assets['meshes'][name], assets['images'][name]
        image, spec, receipt = helpers['read_verified_render'](directory / f'{name}-render', source, ref, f'shrub.{name}.render')
        assert ref['metadata']['render'] == receipt['observations']['script']
        assert spec['parameters']['arguments']['framing'] == {'type': 'shared-orthographic', 'center': [0, .65, 0], 'horizontalSpan': 2.2, 'pivot': [0, 0, 0]}
        assert image.size == (320, 384)
        render = receipt['observations']['script']
        assert render['framing']['worldUnitsPerPixel'] == 2.2 / 320
        point = render['pivot']
        assert evidence['evidence'][name]['bounds']['min'][1] >= -1e-5
        assert source['metadata']['geometry']['parameters']['family'] == 'broadleaf'
        left = index * 320
        draw.text((left + 10, 10), f'{name}: native Sapling broadleaf shrub', fill='#18232f')
        draw.text((left + 10, 26), '2.2m shared span / native ground pivot', fill='#18232f')
        sheet.paste(Image.alpha_composite(Image.new('RGBA', image.size, '#f5f4f0'), image).convert('RGB'), (left, 44))
        x, y = left + point['x'], 44 + point['y']
        draw.line((x - 5, y, x + 5, y), fill='#506a77')
        draw.line((x, y - 5, x, y + 5), fill='#506a77')
    helpers['reconcile_review'](directory / 'review.png', sheet)
    print(json.dumps({'nativeRenders': 3, 'commonWorldSpan': 2.2, 'review': str(directory / 'review.png')}))


try:
    review()
except Exception:
    (directory / 'review.png').unlink(missing_ok=True)
    raise
