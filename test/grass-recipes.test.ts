import {test} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {NodeIO} from "@gltf-transform/core";
import {createGrassAssetSpec,normalizeGrassParameters,readGrassRecipeSource,GRASS_PRESETS} from "../src/grass-recipes.js";
import {storeAssetObject} from "../src/asset-store.js";
import {executeGltfImportOperation} from "../src/gltf-import-operations.js";
type Blade={id:string;root:number[];height:number;yawBlenderRadians:number;localGeometrySha256:string};
type Evidence={blades:Blade[];footprint:{width:number;depth:number};wind:string;origin:string;axes:string;unit:string};
const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{observations:{script:Evidence}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../src/core.js",import.meta.url).href);
const source=await readGrassRecipeSource();
const spec=(parameters:unknown)=>createGrassAssetSpec({assetId:"grass.fixture",parameters,scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,blenderVersion:source.blenderVersion});

async function triangleAttributes(bytes:Uint8Array):Promise<Map<string,number>> {
 const scene=(await new NodeIO().setAllowNetwork(false).readBinary(bytes)).getRoot();
 const result=new Map<string,number>();
 for(const mesh of scene.listMeshes()) {
  for(const primitive of mesh.listPrimitives()) {
   const indices=primitive.getIndices();assert.ok(indices);
   const attributes=["POSITION","NORMAL","TEXCOORD_0"].map(name=>{const attribute=primitive.getAttribute(name);assert.ok(attribute);return attribute;});
   for(let i=0;i<indices.getCount();i+=3) {
    const corners:string[]=[];
    for(let corner=0;corner<3;corner++) {
     const values:number[]=[];
     for(const attribute of attributes) {const element:number[]=[];attribute.getElement(indices.getScalar(i+corner),element);values.push(...element);}
     corners.push(JSON.stringify(values));
    }
    const key=JSON.stringify(corners.sort());result.set(key,(result.get(key)??0)+1);
   }
  }
 }
 return result;
}

test("Grass declares bounded native controls and both executable source pins",()=>{
 for(const p of Object.values(GRASS_PRESETS)) {
  const s=spec(p);assert.deepEqual(s.parameters.arguments,p);assert.deepEqual(s.generator,{id:"external.blender.script",version:"1"});
  assert.deepEqual(s.inputs,{script:{path:"grass.py",sha256:source.sha256},authoring:{path:"wheat.py",sha256:source.authoring.sha256}});
  assert.equal(s.reproducibility.expected,"approximate");
 }
 assert.equal(Reflect.set(GRASS_PRESETS.short,"bladeCount",100),false);
 for(const change of [{bladeCount:0},{bladeCount:33},{bladeCount:1.5},{bladeHeight:0},{bladeHeight:Infinity},{bladeWidth:0},{bladeWidth:.07},
  {spread:-1},{spread:.31},{bend:-1},{bend:.81},{curveSegments:1},{curveSegments:7},{maxTriangles:15},{maxTriangles:8001},
  {seed:"01"},{seed:"1\n"},{seed:"1\u2028"},{seed:"2147483648"},{seed:"-1"},{schemaVersion:2},{wind:true}]) {
  assert.throws(()=>normalizeGrassParameters({...GRASS_PRESETS.short,...change}));
 }
 assert.throws(()=>spec({...GRASS_PRESETS.short,bladeHeight:.08,bladeWidth:.03}),/quarter/);
 assert.throws(()=>createGrassAssetSpec({assetId:"grass",parameters:GRASS_PRESETS.short,scriptSha256:source.sha256,authoringSha256:"bad",blenderVersion:source.blenderVersion}),/sha256/);
});

test("Grass Python and TypeScript reject the same controls before native scene mutation",{skip:!process.env.ASSET_TOOLING_BLENDER,timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"grass-controls-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const cases=[...Object.values(GRASS_PRESETS),{...GRASS_PRESETS.short,bladeCount:32,bend:.8},
  ...[{bladeCount:true},{bladeCount:0},{seed:"1\n"},{bladeHeight:.08,bladeWidth:.03},{unknown:1}].map(c=>({...GRASS_PRESETS.short,...c}))];
 const expected=cases.map(p=>{try{normalizeGrassParameters(p);return "accepted";}catch{return "rejected";}});
 const controls=path.join(root,"controls.json");await writeFile(controls,JSON.stringify(cases));
 const program=`import bpy,json,runpy,sys
assert '.'.join(map(str,bpy.app.version)) == ${JSON.stringify(source.blenderVersion)}
recipe=runpy.run_path(sys.argv[-2]);before=set(bpy.data.objects);results=[]
for p in json.load(open(sys.argv[-1])):
 try: recipe['validate'](p,{'authoring':'must-not-read.py'});results.append('accepted')
 except (ValueError,TypeError):
  try: recipe['generate']('must-not-write.glb',p,{'authoring':'must-not-read.py'})
  except (ValueError,TypeError): pass
  else: raise AssertionError('invalid controls reached authoring')
  assert set(bpy.data.objects)==before
  results.append('rejected')
print('[grass-controls]'+json.dumps(results))`;
 const blender=process.env.ASSET_TOOLING_BLENDER;assert.ok(blender);
 const run=spawnSync(blender,["--background","--factory-startup","--threads","1","--python-exit-code","1","--python-expr",program,"--",
  fileURLToPath(new URL("../adapters/blender/grass.py",import.meta.url)),controls],{encoding:"utf8",timeout:25000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
 assert.equal(run.status,0,run.error?.message ?? run.stderr);
 const line=run.stdout.split("\n").find(l=>l.startsWith("[grass-controls]"));assert.ok(line,run.stdout);
 assert.deepEqual(JSON.parse(line.slice("[grass-controls]".length)),expected);
});

test("native Grass GLBs preserve grounding, analytic straight-blade geometry, density prefix and exact replay",{skip:!process.env.ASSET_TOOLING_BLENDER,timeout:150000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"grass-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,"grass.py"),source.bytes);await writeFile(path.join(root,"wheat.py"),source.authoring.bytes);
 const file=path.join(root,"asset.json"),output=path.join(root,"grass.glb");
 const straight={...GRASS_PRESETS.short,seed:"0",bladeCount:1,bladeHeight:.4,bladeWidth:.02,spread:0,bend:0};
 const changedSeed={...GRASS_PRESETS.short,seed:"134"};
 const cases=[straight,...Object.values(GRASS_PRESETS),changedSeed];let accepted:Evidence|undefined,acceptedTriangles:Map<string,number>|undefined;
 for(const p of cases) {
  await writeFile(file,JSON.stringify(spec(p)));const generated=await generateAsset(file),bytes=await readFile(output),mtime=(await stat(output)).mtimeMs;
  assert.equal((await verifyAsset(file)).status,"exact");assert.equal((await generateAsset(file)).cache.status,"hit");assert.equal((await stat(output)).mtimeMs,mtime);
  const scene=(await new NodeIO().setAllowNetwork(false).readBinary(bytes)).getRoot();assert.equal(scene.listMeshes().length,1);assert.equal(scene.listSkins().length,0);assert.equal(scene.listAnimations().length,0);
  let minimum=Infinity,maximum=-Infinity,triangles=0;const groundRadii:number[]=[];
  for(const node of scene.listNodes()) {
   assert.deepEqual(node.getTranslation(),[0,0,0]);assert.deepEqual(node.getScale(),[1,1,1]);assert.deepEqual(node.getRotation(),[0,0,0,1]);
   const mesh=node.getMesh();assert.ok(mesh);
   for(const primitive of mesh.listPrimitives()) {
    const position=primitive.getAttribute("POSITION"),normal=primitive.getAttribute("NORMAL"),uv=primitive.getAttribute("TEXCOORD_0"),indices=primitive.getIndices();assert.ok(position && normal && uv && indices);
    assert.equal(normal.getCount(),position.getCount());assert.equal(uv.getCount(),position.getCount());triangles+=indices.getCount()/3;
    for(let i=0;i<indices.getCount();i++) {assert.ok(indices.getScalar(i)<position.getCount());}
    for(let i=0;i<position.getCount();i++) {
     const point:number[]=[],n:number[]=[],tex:number[]=[];position.getElement(i,point);normal.getElement(i,n);uv.getElement(i,tex);
     assert.ok([...point,...n,...tex].every(Number.isFinite));assert.ok(Math.abs(n.reduce((sum,v)=>sum+v*v,0)-1)<1e-4);
     minimum=Math.min(minimum,point[1]!);maximum=Math.max(maximum,point[1]!);
     const half=p.spread+p.bladeHeight*p.bend+p.bladeWidth;assert.ok(Math.abs(point[0]!)<=half+1e-6 && Math.abs(point[2]!)<=half+1e-6);
     if(Math.abs(point[1]!)<1e-7) {groundRadii.push(Math.hypot(point[0]!,point[2]!));}
    }
   }
  }
  assert.ok(Math.abs(minimum)<1e-6 && maximum<=p.bladeHeight+1e-6);assert.ok(triangles>0 && triangles<=p.maxTriangles);
  if(p===straight) {
   // Independent seed-0 first draw 0.8444218515250481 and authored rectangular root cross-section.
   assert.ok(Math.abs(maximum-.3906653110915029)<1e-7);assert.equal(triangles,98);
   assert.ok(groundRadii.length>0 && groundRadii.every(r=>Math.abs(r-Math.hypot(.0025,.000125))<1e-7));
  }
  const evidence=generated.receipt.observations.script;assert.equal(evidence.unit,"meter");assert.equal(evidence.axes,"right-handed-y-up");assert.equal(evidence.origin,"native-root-ground-anchor");assert.equal(evidence.wind,"none");assert.equal(evidence.blades.length,p.bladeCount);
  await executeGltfImportOperation(root,{parameters:{},inputs:{source:(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset}});
  if(p===GRASS_PRESETS.short) {accepted=evidence;acceptedTriangles=await triangleAttributes(bytes);}
  if(p===changedSeed) {assert.ok(accepted);assert.notDeepEqual(evidence.blades,accepted.blades);assert.notDeepEqual(await triangleAttributes(bytes),acceptedTriangles);}
 }
 assert.ok(accepted);
 await writeFile(file,JSON.stringify(spec({...GRASS_PRESETS.short,bladeCount:24})));const denser=await generateAsset(file);
 assert.deepEqual(denser.receipt.observations.script.blades.slice(0,12),accepted.blades);
 assert.ok(acceptedTriangles);const denseTriangles=await triangleAttributes(await readFile(output));
 for(const [triangle,count] of acceptedTriangles) {assert.ok((denseTriangles.get(triangle)??0)>=count,"density edit changed an existing triangle's actual attributes");}
 const previous=await readFile(output),mtime=(await stat(output)).mtimeMs;
 await writeFile(file,JSON.stringify(spec({...GRASS_PRESETS.short,maxTriangles:16})));await assert.rejects(generateAsset(file),/maxTriangles/);
 await writeFile(path.join(root,"wheat.py"),"corrupt helper");await assert.rejects(generateAsset(file),/hash mismatch/);assert.equal((await verifyAsset(file)).status,"broken");
 assert.deepEqual(await readFile(output),previous);assert.equal((await stat(output)).mtimeMs,mtime);
});
