"""Inspect pinned native Wheat icons; each icon uses its own auto-fit bounds."""
import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw

directory = Path(__file__).resolve().parents[2] / '.artifacts/wheat'
output = directory / 'review.png'


def review():
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
        spec_bytes = (folder / 'asset.json').read_bytes()
        spec = json.loads(spec_bytes)
        receipt = json.loads((folder / 'render.png.receipt.json').read_text())
        ref = assets['meshes'][name]
        source = (folder / 'source.glb').read_bytes()
        assert len(source) == ref['byteLength'] and hashlib.sha256(source).hexdigest() == ref['sha256']
        assert spec['inputs']['source']['sha256'] == ref['sha256']
        assert hashlib.sha256((folder / 'render_static_glb.py').read_bytes()).hexdigest() == spec['inputs']['script']['sha256']
        assert receipt['inputs'] == spec['inputs'] and receipt['parameters'] == spec['parameters']
        assert receipt['assetId'] == spec['assetId'] == f'wheat.{name}.icon'
        assert receipt['generator']['id'] == spec['generator']['id'] == 'external.blender.script'
        assert receipt['generator']['version'] == spec['generator']['version'] == '1'
        assert spec_bytes.endswith(b'\n') and receipt['spec']['sha256'] == hashlib.sha256(spec_bytes[:-1]).hexdigest()
        assert receipt['output']['path'] == spec['output']['path'] == 'render.png'
        encoded = (folder / 'render.png').read_bytes()
        pin = assets['icons'][name]
        assert len(encoded) == pin['byteLength'] and hashlib.sha256(encoded).hexdigest() == pin['sha256'] == receipt['output']['sha256']
        if parameters is None:
            parameters = spec['parameters']
        else:
            assert parameters == spec['parameters']
        image = Image.open(io.BytesIO(encoded)).convert('RGBA')
        assert image.size == (256, 384) and image.getchannel('A').getbbox() is not None
        image = Image.alpha_composite(Image.new('RGBA', image.size, '#f5f4f0'), image).convert('RGB')
        sheet.paste(image, (column * 256, 62))
        draw.text((column * 256 + 10, 12), name, fill='#18232f')
        draw.text((column * 256 + 10, 32), 'own bounds / auto-fit icon', fill='#18232f')
    encoded = io.BytesIO()
    sheet.save(encoded, format='PNG')
    data = encoded.getvalue()
    if not output.exists() or output.read_bytes() != data:
        handle, temporary = tempfile.mkstemp(prefix='.review-', dir=directory)
        try:
            with os.fdopen(handle, 'wb') as target:
                target.write(data)
            os.replace(temporary, output)
        finally:
            Path(temporary).unlink(missing_ok=True)
    print(json.dumps({'nativeRenders': len(names), 'framing': evidence['framing'], 'review': str(output)}))


if __name__ == '__main__':
    try:
        review()
    except Exception:
        output.unlink(missing_ok=True)
        raise
