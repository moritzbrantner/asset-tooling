import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { generateAsset, verifyAsset } from "../src/core.js";
import { storeAssetObject, createAssetRefFromBytes } from "../src/asset-store.js";
import { createRockAssetSpec, readRockRecipeSource, ROCK_PRESETS, createRockVariantManifest } from "../src/rock-recipes.js";

async function withRoot(run: (root: string) => Promise<void>) {
  const root=await mkdtemp(path.join(os.tmpdir(),'asset-rock-'));
  try { await run(root); } finally { await rm(root,{recursive:true,force:true}); }
}
const source=await readRockRecipeSource();
function spec(parameters: unknown=ROCK_PRESETS.rounded) {
  return createRockAssetSpec({assetId:'test.rock',parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
}

test('rock specs pin the existing backend, declared source and geometry controls',()=>{
  const actual=spec();
  assert.deepEqual(actual.generator,{id:'external.blender.script',version:'1'});
  assert.deepEqual(actual.inputs.script,{path:'rock.py',sha256:source.sha256});
  assert.equal(actual.parameters.blenderVersion,source.blenderVersion);
  assert.notDeepEqual(spec({...ROCK_PRESETS.rounded,seed:'43'}),actual);
  assert.deepEqual(actual.randomness,{mode:'none'});
  assert.equal(Reflect.set(ROCK_PRESETS.rounded,'seed','99'),false);
});

test('rock controls reject invalid dimensions, budgets and undeclared fields',()=>{
  for (const change of [{width:0},{height:Infinity},{depth:100001},{subdivisions:0},{subdivisions:6},{angularity:1.1},{flattening:-1},{irregularity:1},{seed:'-1'},{unexpected:true}]) {
    assert.throws(()=>spec({...ROCK_PRESETS.rounded,...change}));
  }
});

test('variant material selection preserves master mesh identity and stable logical IDs',()=>{
  const mesh=createAssetRefFromBytes(Buffer.from('fixture'),{kind:'mesh',mediaType:'model/gltf-binary'});
  const firstMaterial=createAssetRefFromBytes(Buffer.from('first'),{kind:'material',mediaType:'application/vnd.asset-tooling.pbr-material+json'});
  const secondMaterial=createAssetRefFromBytes(Buffer.from('second'),{kind:'material',mediaType:'application/vnd.asset-tooling.pbr-material+json'});
  const first=createRockVariantManifest([{id:'rounded',mesh,material:firstMaterial}]);
  const second=createRockVariantManifest([{id:'rounded',mesh,material:secondMaterial}]);
  assert.deepEqual(first.variants[0]?.mesh,second.variants[0]?.mesh);
  assert.notDeepEqual(first.variants[0]?.material,second.variants[0]?.material);
  assert.throws(()=>createRockVariantManifest([{id:'same',mesh},{id:'same',mesh}]),/duplicate/);
});

test('authoritative rock output has finite grounded geometry, closed winding, UVs and exact replay',{
  skip:!process.env.ASSET_TOOLING_BLENDER && 'ASSET_TOOLING_BLENDER is not set', timeout:120000,
},()=>withRoot(async root=>{
  const specPath=path.join(root,'asset.json');
  await writeFile(path.join(root,'rock.py'),source.bytes);
  await writeFile(specPath,JSON.stringify(spec({...ROCK_PRESETS.angular,width:2,height:1,depth:1.5,subdivisions:2})));
  const first=await generateAsset(specPath);
  const bytes=await readFile(path.join(root,'rock.glb'));
  const document=await new NodeIO().readBinary(new Uint8Array(bytes));
  assert.equal(document.getRoot().listMeshes().length,1);
  const primitive=document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  const positions=primitive.getAttribute('POSITION')!,normals=primitive.getAttribute('NORMAL')!,uvs=primitive.getAttribute('TEXCOORD_0')!;
  assert.ok(normals && uvs);
  assert.equal(uvs.getCount(),positions.getCount());
  const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity];
  const point: number[]=[];
  for(let i=0;i<positions.getCount();i++) {
    positions.getElement(i,point);
    const normal: number[]=[];
    normals.getElement(i,normal);
    assert.ok(normal.every(Number.isFinite));
    assert.ok(Math.abs(normal.reduce((sum,v)=>sum+v*v,0)-1)<1e-4);
    for(let c=0;c<3;c++) { assert.ok(Number.isFinite(point[c]));minimum[c]=Math.min(minimum[c]!,point[c]!);maximum[c]=Math.max(maximum[c]!,point[c]!); }
  }
  assert.ok(Math.abs(minimum[1]!)<1e-6,'ground contact is Y=0');
  for(const [c,size] of [[0,2],[1,1],[2,1.5]] as const) assert.ok(Math.abs(maximum[c]!-minimum[c]!-size)<1e-5);
  const indices=primitive.getIndices()!;
  assert.equal(indices.getCount(),80*3);
  const welded=new Map<string,number>(),edges=new Map<string,number>();
  function weld(index:number) {
    positions.getElement(index,point);
    const key=point.join(',');
    if(!welded.has(key)) welded.set(key,welded.size);
    return welded.get(key)!;
  }
  for(let i=0;i<indices.getCount();i+=3) {
    const triangle=[weld(indices.getScalar(i)),weld(indices.getScalar(i+1)),weld(indices.getScalar(i+2))];
    assert.equal(new Set(triangle).size,3);
    for(let e=0;e<3;e++) {const a=triangle[e]!,b=triangle[(e+1)%3]!;const key=`${Math.min(a,b)},${Math.max(a,b)}`;edges.set(key,(edges.get(key)??0)+(a<b?1:-1));}
  }
  assert.ok([...edges.values()].every(balance=>balance===0),'shared edge orientations cancel');
  assert.equal(welded.size-edges.size+indices.getCount()/3,2,'sphere topology Euler characteristic');
  const stored=await storeAssetObject(root,{kind:'mesh',mediaType:'model/gltf-binary',bytes});
  assert.equal(stored.asset.sha256,first.outputSha256);
  const second=await generateAsset(specPath);
  assert.equal(second.cache.status,'hit');
  assert.equal(second.status,'unchanged');
  assert.equal((await verifyAsset(specPath)).status,'exact');
  await writeFile(path.join(root,'rock.py'),'changed');
  await assert.rejects(()=>generateAsset(specPath),/sha256|hash|changed/i);
}));

test('unperturbed base matches an independent normalized icosahedron ellipsoid reference',{
  skip:!process.env.ASSET_TOOLING_BLENDER && 'ASSET_TOOLING_BLENDER is not set',timeout:120000,
},()=>withRoot(async root=>{
  await writeFile(path.join(root,'rock.py'),source.bytes);
  const specPath=path.join(root,'asset.json');
  const p={...ROCK_PRESETS.rounded,width:2,height:2,depth:2,subdivisions:1,angularity:0,flattening:0,irregularity:0};
  await writeFile(specPath,JSON.stringify(spec(p)));
  await generateAsset(specPath);
  const document=await new NodeIO().readBinary(new Uint8Array(await readFile(path.join(root,'rock.glb'))));
  const primitive=document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  assert.equal(primitive.getIndices()!.getCount(),60);
  // A pole-oriented unit icosahedron has z extrema ±1, x extrema ±sqrt(4/5),
  // and y extrema ±sqrt((5+sqrt(5))/10). The recipe scales each measured span to 2m.
  const radiusX=1/Math.sqrt(4/5),radiusZ=1/Math.sqrt((5+Math.sqrt(5))/10);
  const positions=primitive.getAttribute('POSITION')!,point: number[]=[];
  for(let i=0;i<positions.getCount();i++) {
    positions.getElement(i,point);
    const radiusSquared=(point[0]!/radiusX)**2+(point[1]!-1)**2+(point[2]!/radiusZ)**2;
    assert.ok(Math.abs(radiusSquared-1)<1e-4,`unperturbed ellipsoid error ${radiusSquared-1}`);
  }
}));
