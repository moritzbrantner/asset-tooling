"""Inspect pinned native grass renders at one world scale and ground pivot."""
import json
import runpy
from pathlib import Path

root = Path(__file__).resolve().parents[2]
directory = root / '.artifacts/grass-clumps'
helpers = runpy.run_path(root / 'examples/render_review.py')


def review():
    assets = json.loads((directory / 'assets.json').read_text())
    evidence = json.loads((directory / 'evidence.json').read_text())
    names = ['short', 'bent', 'tuft']
    for name in names:
        assert assets['meshes'][name]['metadata']['geometry']['wind'] == 'none'
        assert assets['meshes'][name]['metadata']['presetId'] == name
    framing = {'type': 'shared-orthographic', 'center': [0, 0.22, 0], 'horizontalSpan': 1.25, 'pivot': [0, 0, 0]}
    print(json.dumps(helpers['review_native_vegetation'](directory, assets, evidence, names, 'grass', framing, (384, 384), 'native authored grass clump')))


try:
    review()
except Exception:
    (directory / 'review.png').unlink(missing_ok=True)
    raise
