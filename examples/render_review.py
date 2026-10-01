"""Read pinned native PNG evidence and reconcile disposable review images."""
import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw


def read_verified_render(folder, source, image_ref, asset_id):
    spec_bytes = (folder / 'asset.json').read_bytes()
    spec = json.loads(spec_bytes)
    receipt = json.loads((folder / 'render.png.receipt.json').read_text())
    assert spec['inputs']['source']['path'] == 'source.glb'
    assert spec['inputs']['script']['path'] == 'render_static_glb.py'
    source_bytes = (folder / 'source.glb').read_bytes()
    assert len(source_bytes) == source['byteLength'] and hashlib.sha256(source_bytes).hexdigest() == source['sha256']
    assert spec['inputs']['source']['sha256'] == source['sha256']
    assert hashlib.sha256((folder / 'render_static_glb.py').read_bytes()).hexdigest() == spec['inputs']['script']['sha256']
    assert receipt['inputs'] == spec['inputs'] and receipt['parameters'] == spec['parameters']
    assert receipt['assetId'] == spec['assetId'] == asset_id
    assert receipt['generator']['id'] == spec['generator']['id'] == 'external.blender.script'
    assert receipt['generator']['version'] == spec['generator']['version'] == '1'
    assert spec_bytes.endswith(b'\n') and receipt['spec']['sha256'] == hashlib.sha256(spec_bytes[:-1]).hexdigest()
    assert image_ref['metadata']['source'] == source
    assert image_ref['metadata']['sourceSpecSha256'] == receipt['spec']['sha256']
    assert image_ref['metadata']['rendererScriptSha256'] == spec['inputs']['script']['sha256']
    assert receipt['output']['path'] == spec['output']['path'] == 'render.png'
    encoded = (folder / 'render.png').read_bytes()
    assert len(encoded) == image_ref['byteLength'] and hashlib.sha256(encoded).hexdigest() == image_ref['sha256'] == receipt['output']['sha256']
    image = Image.open(io.BytesIO(encoded)).convert('RGBA')
    controls = spec['parameters']['arguments']
    assert image.size == (controls['width'], controls['height']) and image.getchannel('A').getbbox() is not None
    return image, spec, receipt


def reconcile_review(output, image):
    encoded = io.BytesIO()
    image.save(encoded, format='PNG')
    data = encoded.getvalue()
    if output.exists() and output.read_bytes() == data:
        return
    handle, temporary = tempfile.mkstemp(prefix='.review-', dir=output.parent)
    try:
        with os.fdopen(handle, 'wb') as target:
            target.write(data)
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)


def review_native_vegetation(directory, assets, evidence, names, prefix, framing, image_size, label):
    """Common pinned ground/scale comparison for the shrub and grass examples."""
    assert evidence['packageOnlyMatches']
    assert evidence['unit'] == 'meter' and evidence['origin'] == 'native-root-ground-anchor'
    assert evidence['consumerPlacementAuthority'] is False
    width, height = image_size
    sheet = Image.new('RGB', (width * len(names), height + 46), '#f5f4f0')
    draw = ImageDraw.Draw(sheet)
    for index, name in enumerate(names):
        source, ref = assets['meshes'][name], assets['images'][name]
        image, spec, receipt = read_verified_render(directory / f'{name}-render', source, ref, f'{prefix}.{name}.render')
        assert ref['metadata']['render'] == receipt['observations']['script']
        assert spec['parameters']['arguments']['framing'] == framing
        assert image.size == image_size
        render = receipt['observations']['script']
        assert render['framing']['worldUnitsPerPixel'] == framing['horizontalSpan'] / width
        assert evidence['evidence'][name]['bounds']['min'][1] >= -1e-5
        left = index * width
        draw.text((left + 10, 10), f'{name}: {label}', fill='#18232f')
        draw.text((left + 10, 26), f"{framing['horizontalSpan']}m shared span / native ground pivot", fill='#18232f')
        sheet.paste(Image.alpha_composite(Image.new('RGBA', image.size, '#f5f4f0'), image).convert('RGB'), (left, 44))
        point = render['pivot']
        x, y = left + point['x'], 44 + point['y']
        draw.line((x - 5, y, x + 5, y), fill='#506a77')
        draw.line((x, y - 5, x, y + 5), fill='#506a77')
    reconcile_review(directory / 'review.png', sheet)
    return {'nativeRenders': len(names), 'commonWorldSpan': framing['horizontalSpan'], 'review': str(directory / 'review.png')}
