import {test} from "node:test";
import assert from "node:assert/strict";
import {createWheatAssetSpec,normalizeWheatParameters,readWheatRecipeSource,WHEAT_PRESETS} from "../src/wheat-recipes.js";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {NodeIO} from "@gltf-transform/core";
import {storeAssetObject} from "../src/asset-store.js";
import {executeGltfImportOperation} from "../src/gltf-import-operations.js";

type WheatEvidence={componentCounts:Record<string,{vertices:number;triangles:number}>;componentGeometrySha256:Record<string,string>;
 unit:string;axes:string;origin:string;footprint:{width:number;depth:number};stage:string;wind:string};
const {generateAsset,verifyAsset}:{generateAsset:(specPath:string)=>Promise<{status:string;outputChanged:boolean;receiptChanged:boolean;cache:{status:string};receipt:{observations:{script:WheatEvidence}}}>;
 verifyAsset:(specPath:string)=>Promise<{status:string}>}=await import(new URL("../src/core.js",import.meta.url).href);

const source=await readWheatRecipeSource();
const spec=(parameters:unknown)=>createWheatAssetSpec({assetId:"wheat.fixture",parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});
test("Wheat appearances use the existing offline backend with complete stage controls",()=>{
 for(const [stage,p] of Object.entries(WHEAT_PRESETS)) {
  const s=spec(p);
  assert.deepEqual(s.generator,{id:"external.blender.script",version:"1"});
  assert.deepEqual(s.inputs,{script:{path:"wheat.py",sha256:source.sha256}});
  assert.deepEqual(s.parameters.arguments,p);assert.equal(p.stage,stage);
  assert.equal(s.reproducibility.expected,"approximate");
 }
 assert.equal(Reflect.set(WHEAT_PRESETS.mature,"leafCount",50),false);
 assert.notDeepEqual(spec(WHEAT_PRESETS.early),spec(WHEAT_PRESETS.mature));
 assert.notDeepEqual(spec({...WHEAT_PRESETS.mature,seed:"42"}),spec(WHEAT_PRESETS.mature));
});
test("Wheat rejects unsupported stages, malformed bounds and incompatible appearance controls",()=>{
 const bad=[{schemaVersion:2},{stage:"ready"},{seed:"-1"},{seed:"2147483648"},{seed:"01"},{seed:"1\n"},{seed:"1\u2028"},
  {stemHeight:0},{stemHeight:Infinity},{stemRadius:0},{stemRadius:.1},{leafCount:7},{leafCount:1.5},{leafLength:.5},
  {leafWidth:.2},{grainPairs:9},{earLength:.4},{curveSegments:1},{curveSegments:7},{maxTriangles:99},{maxTriangles:20001},{wind:true},
  {stage:"early"},{stage:"harvested"},{grainPairs:0},{earLength:0}];
 for(const delta of bad) {assert.throws(()=>normalizeWheatParameters({...WHEAT_PRESETS.mature,...delta}));}
 assert.throws(()=>spec({...WHEAT_PRESETS.early,grainPairs:1}),/early/);
 assert.throws(()=>spec({...WHEAT_PRESETS.harvested,leafCount:1}),/harvested/);
 assert.throws(()=>createWheatAssetSpec({assetId:"wheat",parameters:WHEAT_PRESETS.early,scriptSha256:source.sha256,blenderVersion:"current"}),/exact/);
});
test("Python and TypeScript admit identical bounded authored controls before loading Blender",()=>{
 const script=fileURLToPath(new URL("../adapters/blender/wheat.py",import.meta.url));
 const program=`import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('wheat',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nfor p in json.loads(sys.stdin.read()):\n try: m.validate(p,{});print('accepted')\n except (ValueError,TypeError): print('rejected')\n`;
 const cases:unknown[]=[...Object.values(WHEAT_PRESETS),{...WHEAT_PRESETS.mature,stemHeight:2},{...WHEAT_PRESETS.mature,leafCount:0},
  {...WHEAT_PRESETS.mature,seed:"1\n"},{...WHEAT_PRESETS.mature,stemHeight:true},{...WHEAT_PRESETS.mature,grainPairs:4},
  {...WHEAT_PRESETS.harvested,leafLength:.1},{...WHEAT_PRESETS.mature,unknown:true}];
 const expected=cases.map(p=>{try{normalizeWheatParameters(p);return "accepted";}catch(error){assert.ok(error instanceof Error);return "rejected";}});
 const run=spawnSync("python3",["-c",program,path.resolve(script)],{input:JSON.stringify(cases),encoding:"utf8",timeout:10000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
 assert.equal(run.status,0,run.stderr);assert.deepEqual(run.stdout.trim().split("\n"),expected);
});

test("actual Wheat stages are bounded rooted static GLBs with exact replay, UVs and isolated variation",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "pinned Blender is required",timeout:180000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"wheat-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const specPath=path.join(root,"asset.json"),output=path.join(root,"wheat.glb");
 await writeFile(path.join(root,"wheat.py"),source.bytes);
 const io=new NodeIO(),accepted=new Map<string,{bytes:Buffer;evidence:WheatEvidence}>();
 for(const p of Object.values(WHEAT_PRESETS)) {
  await writeFile(specPath,JSON.stringify(spec(p)));
  const result=await generateAsset(specPath),bytes=await readFile(output),before=await stat(output);
  const replay=await verifyAsset(specPath);
  assert.equal(replay.status,"exact",JSON.stringify({stage:p.stage,...replay}));
  const repeat=await generateAsset(specPath);
  assert.deepEqual(repeat.receipt,result.receipt);assert.equal(repeat.status,"unchanged");assert.equal(repeat.cache.status,"hit");
  assert.equal(repeat.outputChanged,false);assert.equal(repeat.receiptChanged,false);assert.equal((await stat(output)).mtimeMs,before.mtimeMs);
  const scene=(await io.readBinary(new Uint8Array(bytes))).getRoot();
  const wanted={early:["foliage","stem"],mature:["foliage","grain","stem"],harvested:["stem"]}[p.stage];
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
     assert.ok(Math.abs(xyz[0]!)<=.35+1e-6 && Math.abs(xyz[2]!)<=.35+1e-6);
     minY=Math.min(minY,xyz[1]!);maxY=Math.max(maxY,xyz[1]!);
    }
   }
  }
  assert.ok(Math.abs(minY)<1e-6);assert.ok(maxY<=p.stemHeight+p.earLength*1.5+p.leafLength*.5+1e-6);
  assert.ok(triangles>0 && triangles<=p.maxTriangles);
  assert.equal(triangles,{early:322,mature:1232,harvested:28}[p.stage]);
  const evidence=result.receipt.observations.script;
  assert.deepEqual(evidence.footprint,{width:.7,depth:.7});assert.equal(evidence.unit,"meter");assert.equal(evidence.axes,"right-handed-y-up");
  assert.equal(evidence.origin,"native-root-ground-anchor");assert.equal(evidence.wind,"none");assert.equal(evidence.stage,p.stage);
  const stored=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset;
  await executeGltfImportOperation(root,{parameters:{},inputs:{source:stored}});
  accepted.set(p.stage,{bytes,evidence});
 }
 await writeFile(specPath,JSON.stringify(spec({...WHEAT_PRESETS.mature,seed:"42"})));
 const changed=await generateAsset(specPath),same=accepted.get("mature")!.evidence.componentGeometrySha256;
 assert.equal(changed.receipt.observations.script.componentGeometrySha256.stem,same.stem);
 assert.equal(changed.receipt.observations.script.componentGeometrySha256.grain,same.grain);
 assert.notEqual(changed.receipt.observations.script.componentGeometrySha256.foliage,same.foliage);
 await writeFile(specPath,JSON.stringify(spec({...WHEAT_PRESETS.mature,maxTriangles:100})));
 await assert.rejects(generateAsset(specPath),/maxTriangles/);
 const cold=await mkdtemp(path.join(tmpdir(),"wheat-cold-"));t.after(()=>rm(cold,{recursive:true,force:true}));
 await writeFile(path.join(cold,"wheat.py"),source.bytes);
 await writeFile(path.join(cold,"asset.json"),JSON.stringify(spec(WHEAT_PRESETS.mature)));
 await generateAsset(path.join(cold,"asset.json"));assert.deepEqual(await readFile(path.join(cold,"wheat.glb")),accepted.get("mature")!.bytes);
});
