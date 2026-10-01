import {test} from "node:test";
import assert from "node:assert/strict";
import {createCornAssetSpec,normalizeCornParameters,readCornRecipeSource,CORN_PRESETS} from "../src/corn-recipes.js";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO} from "@gltf-transform/core";
import {storeAssetObject} from "../src/asset-store.js";
import {executeGltfImportOperation} from "../src/gltf-import-operations.js";

type CornEvidence={componentCounts:Record<string,{vertices:number;triangles:number}>;componentGeometrySha256:Record<string,string>;
 unit:string;axes:string;origin:string;footprint:{width:number;depth:number};stage:string;wind:string};
const {generateAsset,verifyAsset}:{generateAsset:(specPath:string)=>Promise<{status:string;outputChanged:boolean;receiptChanged:boolean;cache:{status:string};receipt:{observations:{script:CornEvidence}}}>;
 verifyAsset:(specPath:string)=>Promise<{status:string;error?:string}>}=await import(new URL("../src/core.js",import.meta.url).href);

const source=await readCornRecipeSource();
const spec=(parameters:unknown)=>createCornAssetSpec({assetId:"corn.fixture",parameters,scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,blenderVersion:source.blenderVersion});
test("Corn appearances use the existing offline backend with complete stage controls",()=>{
 for(const [stage,p] of Object.entries(CORN_PRESETS)) {
  const s=spec(p);
  assert.deepEqual(s.generator,{id:"external.blender.script",version:"1"});
  assert.deepEqual(s.inputs,{script:{path:"corn.py",sha256:source.sha256},authoring:{path:"wheat.py",sha256:source.authoring.sha256}});
  assert.deepEqual(s.parameters.arguments,p);assert.equal(p.stage,stage);
  assert.equal(s.reproducibility.expected,"approximate");
 }
 assert.equal(Reflect.set(CORN_PRESETS.mature,"leafCount",50),false);
 assert.notDeepEqual(spec(CORN_PRESETS.early),spec(CORN_PRESETS.mature));
 assert.notDeepEqual(spec({...CORN_PRESETS.mature,seed:"42"}),spec(CORN_PRESETS.mature));
 assert.throws(()=>createCornAssetSpec({assetId:"corn",parameters:CORN_PRESETS.early,scriptSha256:source.sha256,authoringSha256:"bad",blenderVersion:source.blenderVersion}),/sha256/);
});
test("Corn rejects unsupported stages, malformed bounds and incompatible appearance controls",()=>{
 const bad=[{schemaVersion:2},{stage:"ready"},{seed:"-1"},{seed:"2147483648"},{seed:"01"},{seed:"1\n"},{seed:"1\u2028"},
  {stemHeight:0},{stemHeight:Infinity},{stemRadius:0},{stemRadius:.1},{leafCount:9},{leafCount:1.5},{leafLength:.6},
  {leafWidth:.2},{kernelRows:9},{earLength:.4},{curveSegments:1},{curveSegments:7},{maxTriangles:99},{maxTriangles:12001},{wind:true},
  {stage:"early"},{stage:"harvested"},{kernelRows:0},{earLength:0}];
 for(const delta of bad) {assert.throws(()=>normalizeCornParameters({...CORN_PRESETS.mature,...delta}));}
 assert.throws(()=>spec({...CORN_PRESETS.early,kernelRows:1}),/early/);
 assert.throws(()=>spec({...CORN_PRESETS.harvested,leafCount:1}),/harvested/);
 assert.throws(()=>spec({...CORN_PRESETS.early,stemHeight:.1,leafLength:.45}),/early/);
 assert.throws(()=>createCornAssetSpec({assetId:"corn",parameters:CORN_PRESETS.early,scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,blenderVersion:"current"}),/exact/);
});
test("pinned Blender and TypeScript admit identical authored controls before scene mutation",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "pinned Blender is required",timeout:30000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"corn-controls-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const script=fileURLToPath(new URL("../adapters/blender/corn.py",import.meta.url)),controls=path.join(root,"controls.json");
 const cases:unknown[]=[...Object.values(CORN_PRESETS),{...CORN_PRESETS.mature,stemHeight:2},{...CORN_PRESETS.mature,leafCount:0},
  {...CORN_PRESETS.mature,seed:"1\n"},{...CORN_PRESETS.mature,stemHeight:true},{...CORN_PRESETS.mature,kernelRows:4},
  {...CORN_PRESETS.harvested,leafLength:.1},{...CORN_PRESETS.mature,unknown:true}];
 const expected=cases.map(p=>{try{normalizeCornParameters(p);return "accepted";}catch(error){assert.ok(error instanceof Error);return "rejected";}});
 await writeFile(controls,JSON.stringify(cases));
 const blender=process.env.ASSET_TOOLING_BLENDER;assert.ok(blender);
 const program=`import bpy,json,runpy,sys
assert ".".join(map(str,bpy.app.version)) == ${JSON.stringify(source.blenderVersion)}
recipe=runpy.run_path(sys.argv[-2]);results=[];before=set(bpy.data.objects)
for p in json.load(open(sys.argv[-1])):
 try:
  recipe['validate'](p,{'authoring':'must-not-read.py'})
  results.append('accepted')
 except (ValueError,TypeError):
  try: recipe['generate']('must-not-write.glb',p,{'authoring':'must-not-read.py'})
  except (ValueError,TypeError): pass
  else: raise AssertionError('invalid controls reached authoring')
  assert set(bpy.data.objects)==before,'invalid controls mutated the scene'
  results.append('rejected')
print('[corn-validation]'+json.dumps(results))
`;
 const run=spawnSync(blender,["--background","--factory-startup","--threads","1","--python-exit-code","1","--python-expr",program,"--",script,controls],{
  encoding:"utf8",timeout:25000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},
 });
 assert.equal(run.status,0,run.error?.message ?? run.stderr);
 const line=run.stdout.split("\n").find(value=>value.startsWith("[corn-validation]"));assert.ok(line,run.stdout);
 assert.deepEqual(JSON.parse(line.slice("[corn-validation]".length)),expected);
});

test("actual Corn stages are bounded rooted static GLBs with exact replay, UVs and isolated variation",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "pinned Blender is required",timeout:180000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"corn-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const specPath=path.join(root,"asset.json"),output=path.join(root,"corn.glb");
 await writeFile(path.join(root,"corn.py"),source.bytes);
 await writeFile(path.join(root,"wheat.py"),source.authoring.bytes);
 const io=new NodeIO(),accepted=new Map<string,{bytes:Buffer;evidence:CornEvidence}>();
 for(const p of Object.values(CORN_PRESETS)) {
  await writeFile(specPath,JSON.stringify(spec(p)));
  const result=await generateAsset(specPath),bytes=await readFile(output),before=await stat(output);
  const replay=await verifyAsset(specPath);
  assert.equal(replay.status,"exact",JSON.stringify({stage:p.stage,...replay}));
  const repeat=await generateAsset(specPath);
  assert.deepEqual(repeat.receipt,result.receipt);assert.equal(repeat.status,"unchanged");assert.equal(repeat.cache.status,"hit");
  assert.equal(repeat.outputChanged,false);assert.equal(repeat.receiptChanged,false);assert.equal((await stat(output)).mtimeMs,before.mtimeMs);
  const scene=(await io.readBinary(new Uint8Array(bytes))).getRoot();
  const wanted={early:["foliage","stem"],mature:["foliage","grain","stem","tassel"],harvested:["stem"]}[p.stage];
  assert.deepEqual(scene.listNodes().map(n=>n.getName()).sort(),wanted);
  assert.equal(scene.listSkins().length,0);assert.equal(scene.listAnimations().length,0);
  let triangles=0,minY=Infinity,maxY=-Infinity;
  for(const node of scene.listNodes()) {
   assert.deepEqual(node.getTranslation(),[0,0,0]);assert.deepEqual(node.getRotation(),[0,0,0,1]);assert.deepEqual(node.getScale(),[1,1,1]);
   const mesh=node.getMesh();assert.ok(mesh);
   for(const primitive of mesh.listPrimitives()) {
    const position=primitive.getAttribute("POSITION"),normal=primitive.getAttribute("NORMAL"),uv=primitive.getAttribute("TEXCOORD_0"),indices=primitive.getIndices();
    assert.ok(position && normal && uv && indices);
    assert.equal(uv.getCount(),position.getCount());assert.equal(normal.getCount(),position.getCount());
    triangles+=indices.getCount()/3;
    for(let i=0;i<indices.getCount();i++) {assert.ok(indices.getScalar(i)<position.getCount());}
    for(let i=0;i<position.getCount();i++) {
     const xyz:number[]=[],n:number[]=[],tex:number[]=[];position.getElement(i,xyz);normal.getElement(i,n);uv.getElement(i,tex);
     assert.ok([...xyz,...n,...tex].every(Number.isFinite));
     assert.ok(Math.abs(n.reduce((sum,v)=>sum+v*v,0)-1)<1e-4);
     assert.ok(Math.abs(xyz[0]!)<=.55+1e-6 && Math.abs(xyz[2]!)<=.55+1e-6);
     minY=Math.min(minY,xyz[1]!);maxY=Math.max(maxY,xyz[1]!);
    }
   }
  }
  assert.ok(Math.abs(minY)<1e-6);assert.ok(maxY<=p.stemHeight+.12+p.leafLength*.5+1e-6);
  assert.ok(triangles>0 && triangles<=p.maxTriangles);
  assert.equal(triangles,{early:322,mature:3194,harvested:28}[p.stage]);
  const evidence=result.receipt.observations.script;
  assert.deepEqual(evidence.footprint,{width:1.1,depth:1.1});assert.equal(evidence.unit,"meter");assert.equal(evidence.axes,"right-handed-y-up");
  assert.equal(evidence.origin,"native-root-ground-anchor");assert.equal(evidence.wind,"none");assert.equal(evidence.stage,p.stage);
  const stored=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset;
  await executeGltfImportOperation(root,{parameters:{},inputs:{source:stored}});
  accepted.set(p.stage,{bytes,evidence});
 }
 await writeFile(specPath,JSON.stringify(spec({...CORN_PRESETS.mature,seed:"42"})));
 const changed=await generateAsset(specPath),same=accepted.get("mature")!.evidence.componentGeometrySha256;
 assert.equal(changed.receipt.observations.script.componentGeometrySha256.stem,same.stem);
 assert.equal(changed.receipt.observations.script.componentGeometrySha256.grain,same.grain);
 assert.equal(changed.receipt.observations.script.componentGeometrySha256.tassel,same.tassel);
 assert.notEqual(changed.receipt.observations.script.componentGeometrySha256.foliage,same.foliage);
 const beforeTamper=await readFile(output),tamperMtime=(await stat(output)).mtimeMs;
 await writeFile(path.join(root,"wheat.py"),Buffer.from("corrupt authoring source"));
 await assert.rejects(generateAsset(specPath),/hash mismatch/);
 const broken=await verifyAsset(specPath);assert.equal(broken.status,"broken");assert.match(broken.error ?? "",/hash mismatch/);
 assert.deepEqual(await readFile(output),beforeTamper);assert.equal((await stat(output)).mtimeMs,tamperMtime);
 await writeFile(path.join(root,"wheat.py"),source.authoring.bytes);
 await writeFile(specPath,JSON.stringify(spec({...CORN_PRESETS.mature,maxTriangles:100})));
 await assert.rejects(generateAsset(specPath),/maxTriangles/);
 const cold=await mkdtemp(path.join(tmpdir(),"corn-cold-"));t.after(()=>rm(cold,{recursive:true,force:true}));
 await writeFile(path.join(cold,"corn.py"),source.bytes);
 await writeFile(path.join(cold,"wheat.py"),source.authoring.bytes);
 await writeFile(path.join(cold,"asset.json"),JSON.stringify(spec(CORN_PRESETS.mature)));
 await generateAsset(path.join(cold,"asset.json"));assert.deepEqual(await readFile(path.join(cold,"corn.glb")),accepted.get("mature")!.bytes);
});
