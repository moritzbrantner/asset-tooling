"""Inspect pinned native Crop icons; each icon uses its own auto-fit bounds."""
import json
import runpy
from pathlib import Path
from PIL import Image, ImageDraw

helpers = runpy.run_path(Path(__file__).with_name("render_review.py"))

def review(directory, crop):
    output = directory / 'review.png'
    assets = json.loads((directory / 'assets.json').read_text())
    evidence = json.loads((directory / 'evidence.json').read_text())
    assert evidence['geometryPreserved'] and evidence['stemGrainMaterialsPreserved']
    assert evidence['framing'] == 'individually-auto-fit-icons'
    names = ['early', 'mature', 'mature-green', 'mature-straw', 'harvested']
    sheet = Image.new('RGB', (1280, 446), '#f5f4f0')
    draw = ImageDraw.Draw(sheet)
    parameters = None
    for column, name in enumerate(names):
        folder = directory / f'{name}-icon'
        image, spec, receipt = helpers['read_verified_render'](folder, assets['meshes'][name], assets['icons'][name], f'{crop}.{name}.icon')
        if parameters is None:
            parameters = spec['parameters']
        else:
            assert parameters == spec['parameters']
        assert image.size == (256, 384)
        image = Image.alpha_composite(Image.new('RGBA', image.size, '#f5f4f0'), image).convert('RGB')
        sheet.paste(image, (column * 256, 62))
        draw.text((column * 256 + 10, 12), name, fill='#18232f')
        draw.text((column * 256 + 10, 32), 'own bounds / auto-fit icon', fill='#18232f')
    helpers['reconcile_review'](output, sheet)
    print(json.dumps({'nativeRenders': len(names), 'framing': evidence['framing'], 'review': str(output)}))


def main(directory, crop):
    output = directory / 'review.png'
    try:
        review(directory, crop)
    except Exception:
        output.unlink(missing_ok=True)
        raise
