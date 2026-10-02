import {test} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {NodeIO} from "@gltf-transform/core";
import {createFenceAssetSpec,evaluateFenceLayout,fencePortAnchor,fencePortsAfterRotation,normalizeFenceParameters,readFenceRecipeSource,
 FENCE_PRESETS,type FenceDirection,type FencePiece} from "../src/fence-kit-recipes.js";
import {storeAssetObject} from "../src/asset-store.js";
import {executeGltfImportOperation} from "../src/gltf-import-operations.js";

const {generateAsset,verifyAsset}:{generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{observations:{script:{ports:string[];triangleCount:number;origin:string;unit:string;axes:string}}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>}=await import(new URL("../src/core.js",import.meta.url).href);
const source=await readFenceRecipeSource();
const spec=(parameters:unknown)=>createFenceAssetSpec({assetId:"fence.fixture",parameters,scriptSha256:source.sha256,blenderVersion:source.blenderVersion});

// Independently authored: counter-clockwise quarter turns seen from above, listed east, north, west, south.
const EXPECTED:Record<FencePiece,FenceDirection[][]>={
 end:[["east"],["north"],["west"],["south"]],
 straight:[["east","west"],["north","south"],["east","west"],["north","south"]],
 corner:[["east","north"],["north","west"],["west","south"],["east","south"]],
 tee:[["east","north","west"],["north","west","south"],["east","west","south"],["east","north","south"]],
};
const STEP:Record<FenceDirection,[number,number]>={east:[1,0],north:[0,-1],west:[-1,0],south:[0,1]};
const OPPOSITE:Record<FenceDirection,FenceDirection>={east:"west",west:"east",north:"south",south:"north"};

test("rotated ports match the authored table and anchors sit on cell-edge midpoints",()=>{
 for(const [piece,rows] of Object.entries(EXPECTED) as [FencePiece,FenceDirection[][]][]) for(const [turns,ports] of rows.entries()) {
  assert.deepEqual(fencePortsAfterRotation(piece,turns),ports,`${piece}@${turns}`);
 }
 assert.deepEqual(fencePortAnchor("east",2),[1,0,0]);assert.deepEqual(fencePortAnchor("north",2),[0,0,-1]);
 assert.deepEqual(fencePortAnchor("west",3),[-1.5,0,0]);assert.deepEqual(fencePortAnchor("south",3),[0,0,1.5]);
 for(const turns of [-1,4,1.5,NaN]) assert.throws(()=>fencePortsAfterRotation("end",turns));
 assert.throws(()=>fencePortsAfterRotation("gate" as FencePiece,0));
});

test("every ordered piece/rotation/adjacency pair evaluates as the authored table predicts",()=>{
 let checked=0;
 for(const a of Object.keys(EXPECTED) as FencePiece[]) for(const b of Object.keys(EXPECTED) as FencePiece[])
 for(let ra=0;ra<4;ra++) for(let rb=0;rb<4;rb++) for(const direction of Object.keys(STEP) as FenceDirection[]) {
  const report=evaluateFenceLayout([{id:"a",piece:a,cell:[0,0],quarterTurns:ra},{id:"b",piece:b,cell:STEP[direction],quarterTurns:rb}]);
  const aPort=EXPECTED[a][ra]!.includes(direction),bPort=EXPECTED[b][rb]!.includes(OPPOSITE[direction]);
  assert.equal(report.connections.length,aPort && bPort?1:0);
  assert.equal(report.mismatches.length,Number(aPort!==bPort));
  const openA=EXPECTED[a][ra]!.length-Number(aPort),openB=EXPECTED[b][rb]!.length-Number(bPort);
  assert.equal(report.openEnds.length,openA+openB);
  checked++;
 }
 assert.equal(checked,4*4*4*4*4);
});

test("a closed pen with a tee branch has no mismatches; invalid layouts are rejected",()=>{
 // 3x2 pen; the middle top cell is a tee whose branch leads north to an end piece.
 const pen=[
  {id:"nw",piece:"corner",cell:[0,0],quarterTurns:3},{id:"n",piece:"tee",cell:[1,0],quarterTurns:0},{id:"ne",piece:"corner",cell:[2,0],quarterTurns:2},
  {id:"sw",piece:"corner",cell:[0,1],quarterTurns:0},{id:"s",piece:"straight",cell:[1,1],quarterTurns:0},{id:"se",piece:"corner",cell:[2,1],quarterTurns:1},
  {id:"post",piece:"end",cell:[1,-1],quarterTurns:3},
 ] as const;
 const placements=pen.map(p=>({...p,cell:[...p.cell] as [number,number]}));
 const report=evaluateFenceLayout(placements);
 assert.deepEqual(report.mismatches,[]);assert.deepEqual(report.openEnds,[]);
 assert.equal(report.connections.length,7);
 const turned=evaluateFenceLayout(placements.map(p=>p.id==="s"?{...p,quarterTurns:1}:p));
 assert.deepEqual(turned.mismatches.map(m=>m.id).sort(),["s","se","sw"]);
 assert.deepEqual(turned.openEnds,[{id:"s",direction:"south"}]);
 for(const bad of [[...placements,{...placements[0]!,id:"dup"}],[...placements,{...placements[0]!,cell:[9,9] as [number,number]}],
  [{...placements[0]!,cell:[0.5,0] as [number,number]}],[{...placements[0]!,quarterTurns:4}],[{...placements[0]!,id:"Bad"}]]) {
  assert.throws(()=>evaluateFenceLayout(bad));
 }
});

test("fence controls and asset specs are bounded and pinned",()=>{
 for(const p of Object.values(FENCE_PRESETS)) {
  const s=spec(p);assert.deepEqual(s.parameters.arguments,p);assert.equal(s.reproducibility.expected,"exact");
  assert.deepEqual(s.inputs,{script:{path:"fence.py",sha256:source.sha256}});
 }
 assert.equal(Reflect.set(FENCE_PRESETS.end,"railCount",3),false);
 for(const change of [{piece:"gate"},{cellSize:.4},{cellSize:Infinity},{postWidth:1.1},{postHeight:3.5},{railCount:0},{railCount:1.5},
  {railDepth:.2},{railCount:3,railHeight:.2},{maxTriangles:11},{schemaVersion:2},{extra:1}]) {
  assert.throws(()=>normalizeFenceParameters({...FENCE_PRESETS.straight,...change}));
 }
});

const blender=process.env.ASSET_TOOLING_BLENDER;
test("Fence Python and TypeScript reject the same controls before scene mutation",{skip:!blender,timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"fence-controls-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const cases=[...Object.values(FENCE_PRESETS),...[{piece:"gate"},{railCount:true},{railCount:0},{railDepth:.2},{railCount:3,railHeight:.2},{extra:1}].map(c=>({...FENCE_PRESETS.straight,...c}))];
 const expected=cases.map(p=>{try{normalizeFenceParameters(p);return "accepted";}catch{return "rejected";}});
 const controls=path.join(root,"controls.json");await writeFile(controls,JSON.stringify(cases));
 const program=`import bpy,json,runpy,sys
recipe=runpy.run_path(sys.argv[-2]);before=set(bpy.data.objects);results=[]
for p in json.load(open(sys.argv[-1])):
 try: recipe['validate'](p,{});results.append('accepted')
 except (ValueError,TypeError):
  try: recipe['generate']('must-not-write.glb',p,{})
  except (ValueError,TypeError): pass
  else: raise AssertionError('invalid controls reached authoring')
  assert set(bpy.data.objects)==before
  results.append('rejected')
print('[fence-controls]'+json.dumps(results))`;
 const run=spawnSync(blender!,["--background","--factory-startup","--threads","1","--python-exit-code","1","--python-expr",program,"--",
  fileURLToPath(new URL("../adapters/blender/fence.py",import.meta.url)),controls],{encoding:"utf8",timeout:25000,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
 assert.equal(run.status,0,run.error?.message ?? run.stderr);
 const line=run.stdout.split("\n").find(l=>l.startsWith("[fence-controls]"));assert.ok(line,run.stdout);
 assert.deepEqual(JSON.parse(line.slice("[fence-controls]".length)),expected);
});

test("native fence pieces put rail ends exactly on declared port edges and replay exactly",{skip:!blender,timeout:240000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"fence-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,"fence.py"),source.bytes);
 const file=path.join(root,"asset.json"),output=path.join(root,"fence.glb");
 for(const p of Object.values(FENCE_PRESETS)) {
  await writeFile(file,JSON.stringify(spec(p)));
  const generated=await generateAsset(file),bytes=await readFile(output),mtime=(await stat(output)).mtimeMs;
  assert.equal((await verifyAsset(file)).status,"exact");assert.equal((await generateAsset(file)).cache.status,"hit");assert.equal((await stat(output)).mtimeMs,mtime);
  const ports=EXPECTED[p.piece][0]!,evidence=generated.receipt.observations.script;
  assert.deepEqual(evidence.ports,ports);assert.equal(evidence.origin,"cell-center-ground");assert.equal(evidence.unit,"meter");assert.equal(evidence.axes,"right-handed-y-up");
  const scene=(await new NodeIO().setAllowNetwork(false).readBinary(bytes)).getRoot();
  assert.equal(scene.listMeshes().length,1);assert.equal(scene.listMaterials().map(m=>m.getName()).join(),"fence-wood");
  const half=p.cellSize/2,eps=1e-5,edge:Record<FenceDirection,Set<string>>={east:new Set(),north:new Set(),west:new Set(),south:new Set()};
  let triangles=0,minY=Infinity,maxY=-Infinity;
  for(const node of scene.listNodes()) {
   assert.deepEqual(node.getTranslation(),[0,0,0]);assert.deepEqual(node.getScale(),[1,1,1]);
   for(const primitive of node.getMesh()!.listPrimitives()) {
    const position=primitive.getAttribute("POSITION")!,indices=primitive.getIndices()!;triangles+=indices.getCount()/3;
    for(let i=0;i<position.getCount();i++) {
     const point:number[]=[];position.getElement(i,point);const [x=NaN,y=NaN,z=NaN]=point;
     assert.ok(Math.abs(x)<=half+eps && Math.abs(z)<=half+eps,"geometry stays inside its cell");
     minY=Math.min(minY,y);maxY=Math.max(maxY,y);
     const key=(a:number,b:number)=>`${a.toFixed(4)},${b.toFixed(4)}`;
     if(Math.abs(x-half)<eps) edge.east.add(key(y,z));if(Math.abs(x+half)<eps) edge.west.add(key(y,-z));
     if(Math.abs(z+half)<eps) edge.north.add(key(y,x));if(Math.abs(z-half)<eps) edge.south.add(key(y,-x));
    }
   }
  }
  assert.equal(triangles,12*(1+ports.length*p.railCount));assert.ok(triangles<=p.maxTriangles);
  assert.ok(Math.abs(minY)<eps && Math.abs(maxY-p.postHeight)<eps);
  // Independently expected rail end-face corners on every port edge, none elsewhere.
  const expectedFace=new Set<string>();
  for(let i=0;i<p.railCount;i++) {
   const centre=p.postHeight*(i+1)/(p.railCount+1);
   for(const y of [centre-p.railHeight/2,centre+p.railHeight/2]) for(const lateral of [-p.railDepth/2,p.railDepth/2]) expectedFace.add(`${y.toFixed(4)},${lateral.toFixed(4)}`);
  }
  for(const direction of Object.keys(edge) as FenceDirection[]) {
   assert.deepEqual([...edge[direction]].sort(),ports.includes(direction)?[...expectedFace].sort():[],`${p.piece} ${direction}`);
  }
  await executeGltfImportOperation(root,{parameters:{},inputs:{source:(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset}});
 }
 const previous=await readFile(output);
 await writeFile(file,JSON.stringify(spec({...FENCE_PRESETS.tee,maxTriangles:12})));await assert.rejects(generateAsset(file),/maxTriangles/);
 assert.deepEqual(await readFile(output),previous);
});
