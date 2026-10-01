"""Inspect pinned native shrub renders at one world scale and ground pivot."""
import json
import runpy
from pathlib import Path

root = Path(__file__).resolve().parents[2]
directory = root / '.artifacts/shrubs'
helpers = runpy.run_path(root / 'examples/render_review.py')


def review():
    assets = json.loads((directory / 'assets.json').read_text())
    evidence = json.loads((directory / 'evidence.json').read_text())
    assert evidence['componentGeometryMatches']
    names = ['compact', 'upright', 'loose']
    for name in names:
        assert assets['meshes'][name]['metadata']['geometry']['parameters']['family'] == 'broadleaf'
    framing = {'type': 'shared-orthographic', 'center': [0, 0.65, 0], 'horizontalSpan': 2.2, 'pivot': [0, 0, 0]}
    print(json.dumps(helpers['review_native_vegetation'](directory, assets, evidence, names, 'shrub', framing, (320, 384), 'native Sapling broadleaf shrub')))


try:
    review()
except Exception:
    (directory / 'review.png').unlink(missing_ok=True)
    raise
