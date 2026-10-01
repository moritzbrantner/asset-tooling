"""Inspect current hash-pinned source/state renders under identical framing."""
import hashlib
import io
import json
from pathlib import Path
from PIL import Image, ImageDraw

directory=Path(__file__).resolve().parents[2]/'.artifacts/tree-appearances'
output=directory/'review.png'

def review():
    evidence=json.loads((directory/'evidence.json').read_text())
    expected={'source':evidence['full']['family']['source']}
    expected.update({s['id']:s['output'] for s in evidence['full']['states']})
    renders=[]
    parameters=None
    for name in ['source','summer','autumn','winter']:
        folder=directory/name
        spec_bytes=(folder/'asset.json').read_bytes()
        spec=json.loads(spec_bytes)
        receipt=json.loads((folder/'render.png.receipt.json').read_text())
        source=(folder/'source.glb').read_bytes()
        ref=expected[name]
        assert len(source)==ref['byteLength'] and hashlib.sha256(source).hexdigest()==ref['sha256']
        assert spec['inputs']['source']['sha256']==ref['sha256']
        script=(folder/'render_static_glb.py').read_bytes()
        assert hashlib.sha256(script).hexdigest()==spec['inputs']['script']['sha256']
        assert receipt['inputs']==spec['inputs'] and receipt['parameters']==spec['parameters']
        assert receipt['assetId']==spec['assetId']==f'tree-appearance.{name}'
        assert spec['generator']=={'id':'external.blender.script','version':'1'}
        assert receipt['generator']['id']==spec['generator']['id'] and receipt['generator']['version']==spec['generator']['version']
        assert spec_bytes.endswith(b'\n')
        assert receipt['spec']['sha256']==hashlib.sha256(spec_bytes[:-1]).hexdigest()
        assert receipt['output']['path']==spec['output']['path']
        encoded=(folder/receipt['output']['path']).read_bytes()
        assert hashlib.sha256(encoded).hexdigest()==receipt['output']['sha256']
        if parameters is None:
            parameters=spec['parameters']
        else:
            assert parameters==spec['parameters'], 'camera, light, framing and samples must match'
        image=Image.open(io.BytesIO(encoded)).convert('RGB')
        assert image.size==(384,512)
        renders.append((name,image))
    sheet=Image.new('RGB',(1536,548),'#f5f4f0')
    draw=ImageDraw.Draw(sheet)
    for column,(name,image) in enumerate(renders):
        sheet.paste(image,(column*384,36));draw.text((column*384+12,12),name,fill='#18232f')
    encoded=io.BytesIO();sheet.save(encoded,format='PNG');data=encoded.getvalue()
    if not output.exists() or output.read_bytes()!=data:
        output.write_bytes(data)
    print(json.dumps({'nativeRenders':4,'sameGeometryAndFraming':True,'review':str(output)}))

if __name__=='__main__':
    try:
        review()
    except Exception:
        output.unlink(missing_ok=True)
        raise
