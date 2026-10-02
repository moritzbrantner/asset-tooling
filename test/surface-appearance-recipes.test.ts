import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,rm,readdir,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {assetObjectPortablePath,resolveAssetObject} from "../src/asset-store.js";
import {parseRgba8Image} from "../src/image-rgba8.js";
import {SURFACE_TEXTURE_PRESETS} from "../src/surface-texture-recipes.js";
import {executeSurfaceAppearanceFamily,executeSurfaceAppearanceState,normalizeSurfaceAppearanceFamily,
 SURFACE_APPEARANCE_PRESETS} from "../src/surface-appearance-recipes.js";

const base={...SURFACE_TEXTURE_PRESETS["soil-fine"],width:17,height:13,gridX:4,gridY:3,detailGridX:12,detailGridY:10};
const dry={id:"dry",low:[58,38,22],high:[168,128,82],roughnessMin:200,roughnessMax:250};
const wet={id:"wet",low:[22,13,7],high:[96,64,36],roughnessMin:50,roughnessMax:120};
const family={schemaVersion:1,id:"fixture.soil",base,states:[wet,dry]};

async function workspace(run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(tmpdir(),"surface-appearance-"));
 try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}
async function inventory(root:string) {
 return Promise.all((await readdir(root,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(async e=>{
  const p=path.join(e.parentPath,e.name),s=await stat(p);return [path.relative(root,p),s.size,s.mtimeMs] as const;
 })).then(v=>v.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
}
// Independent reference for the documented ramp: round((low*(255-h)+high*h)/255).
const ramp=(low:number,high:number,h:number)=>Math.round((low*(255-h)+high*h)/255);

test("states share exact height/normal objects and ramp only their own palette and roughness",{timeout:60000},()=>workspace(async root=>{
 const result=await executeSurfaceAppearanceFamily(root,family);
 assert.deepEqual(result.states.map(s=>s.id),["dry","wet"],"states are ordered by ID");
 assert.deepEqual(result.invariants,{shared:["height","normal"],varying:["color","roughness"]});
 const height=parseRgba8Image(await resolveAssetObject(root,result.shared.height.output));
 for(const [index,declared] of [dry,wet].entries()) {
  const s=result.states[index]!;
  assert.deepEqual(s.execution,{executedOperations:2,reusedOperations:4});
  assert.deepEqual(s.steps.map(x=>x.build.inputs.source),[result.shared.height.output,result.shared.height.output]);
  const color=parseRgba8Image(await resolveAssetObject(root,s.outputs.color)),rough=parseRgba8Image(await resolveAssetObject(root,s.outputs.roughness));
  for(let i=0;i<height.pixels.length;i+=4) {
   const h=height.pixels[i]!;
   assert.deepEqual([...color.pixels.subarray(i,i+4)],[ramp(declared.low[0]!,declared.high[0]!,h),ramp(declared.low[1]!,declared.high[1]!,h),ramp(declared.low[2]!,declared.high[2]!,h),255]);
   assert.equal(rough.pixels[i],ramp(declared.roughnessMin,declared.roughnessMax,h));
  }
 }
 assert.notEqual(result.states[0]!.outputs.color.sha256,result.states[1]!.outputs.color.sha256);
}));

test("identity, invariants and every state validate before any object is written",()=>workspace(async root=>{
 const invalid=[
  {...family,schemaVersion:2},{...family,id:"Bad/Id"},{...family,states:[]},{...family,states:Array.from({length:9},(_,i)=>({...dry,id:`s${i}`}))},
  {...family,states:[dry,{...wet,id:"dry"}]},{...family,states:[{...dry,id:undefined}]},{...family,states:[{...dry,normalStrength:9}]},
  {...family,states:[{...dry,heightMax:10}]},{...family,states:[{...dry,roughnessMin:251}]},{...family,states:[{...dry,low:[0,0]}]},
  {...family,states:[{...dry,roughnessMax:256}]},{...family,base:{...base,seamMode:"clamp"}},{...family,extra:1},
 ];
 for(const value of invalid) {
  assert.throws(()=>normalizeSurfaceAppearanceFamily(value));
  await assert.rejects(executeSurfaceAppearanceFamily(root,value));
  await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
 }
 await assert.rejects(executeSurfaceAppearanceState(root,family,"flooded"),/unknown surface appearance state/);
 await assert.rejects(executeSurfaceAppearanceFamily("relative",family),/absolute/);
 await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
}));

test("reorder, add, single-state edit and undo keep sibling and shared objects; replay is idempotent",{timeout:60000},()=>workspace(async root=>{
 const first=await executeSurfaceAppearanceFamily(root,family),before=await inventory(root);
 assert.deepEqual(await executeSurfaceAppearanceFamily(root,family),first);assert.deepEqual(await inventory(root),before);
 await workspace(async cold=>{assert.deepEqual(await executeSurfaceAppearanceFamily(cold,family),first);});
 const reordered=await executeSurfaceAppearanceFamily(root,{...family,states:[dry,wet]});
 assert.deepEqual(reordered,first);
 const damp={id:"damp",low:[38,23,12],high:[145,102,58],roughnessMin:150,roughnessMax:210};
 const added=await executeSurfaceAppearanceFamily(root,{...family,states:[wet,damp,dry]});
 assert.deepEqual(added.shared,first.shared);
 assert.deepEqual(added.states.filter(s=>s.id!=="damp"),first.states);
 const editedFamily={...family,states:[{...wet,high:[90,60,30]},dry]};
 const edited=await executeSurfaceAppearanceState(root,editedFamily,"wet",{shared:first.shared});
 assert.deepEqual(edited.shared,first.shared);
 assert.deepEqual(edited.state.execution,{executedOperations:2,reusedOperations:4});
 assert.notEqual(edited.state.outputs.color.sha256,first.states[1]!.outputs.color.sha256);
 assert.equal(edited.state.outputs.roughness.sha256,first.states[1]!.outputs.roughness.sha256);
 const full=await executeSurfaceAppearanceFamily(root,editedFamily);
 assert.deepEqual(full.states[1],edited.state);assert.deepEqual(full.states[0],first.states[0]);
 assert.deepEqual(await executeSurfaceAppearanceFamily(root,family),first);
}));

test("accepted shared locks fail closed on a changed base and on corrupt bytes",{timeout:60000},()=>workspace(async root=>{
 const first=await executeSurfaceAppearanceFamily(root,family);
 await assert.rejects(executeSurfaceAppearanceState(root,{...family,base:{...base,seed:"7"}},"dry",{shared:first.shared}));
 await assert.rejects(executeSurfaceAppearanceState(root,{...family,base:{...base,normalStrength:5}},"dry",{shared:first.shared}));
 await assert.rejects(executeSurfaceAppearanceState(root,family,"dry",{shared:{height:first.shared.height} as never}));
 await writeFile(path.join(root,assetObjectPortablePath(first.shared.normal.output)),Buffer.from("corrupt"));
 await assert.rejects(executeSurfaceAppearanceState(root,family,"dry",{shared:first.shared}));
}));

test("a single-state edit against accepted shared steps runs no noise generator",{timeout:60000},()=>workspace(async root=>{
 const first=await executeSurfaceAppearanceFamily(root,family),snapshot=path.join(root,"snapshot.json");
 await writeFile(snapshot,JSON.stringify({family:{...family,states:[{...wet,low:[30,20,10]},dry]},shared:first.shared}));
 const child=spawnSync(process.execPath,["--eval",`
  import {mock} from "bun:test";
  import {readFile} from "node:fs/promises";
  const operations=await import("./src/procedural-texture-operations.ts");
  mock.module("./src/procedural-texture-operations.ts",()=>({...operations,executeTileableHeightOperation(){throw new Error("shared noise must not execute");}}));
  const {executeSurfaceAppearanceState,executeSurfaceAppearanceFamily}=await import("./src/surface-appearance-recipes.ts");
  const {family,shared}=JSON.parse(await readFile(process.argv[2],"utf8"));
  const result=await executeSurfaceAppearanceState(process.argv[1],family,"wet",{shared});
  if(result.state.execution.executedOperations!==2) throw new Error("unexpected generation count");
  let blocked=false;
  try {await executeSurfaceAppearanceFamily(process.argv[1],family);}
  catch(error){if(error.message!=="shared noise must not execute") throw error;blocked=true;}
  if(!blocked) throw new Error("noise spy did not intercept full generation");
 `,root,snapshot],{cwd:path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),encoding:"utf8",timeout:30000});
 assert.equal(child.status,0,child.error?.message??child.stderr);
}));

test("cancellation stops before generation and keeps accepted objects intact",{timeout:60000},()=>workspace(async root=>{
 const controller=new AbortController();controller.abort(new Error("cancelled"));
 await assert.rejects(executeSurfaceAppearanceFamily(root,family,{signal:controller.signal}),/cancelled/);
 await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
 await executeSurfaceAppearanceFamily(root,family);const before=await inventory(root);
 await assert.rejects(executeSurfaceAppearanceState(root,family,"dry",{signal:controller.signal}),/cancelled/);
 assert.deepEqual(await inventory(root),before);
}));

test("frozen soil moisture preset darkens and smooths from dry to wet over one relief",{timeout:60000},()=>workspace(async root=>{
 assert.ok(Object.isFrozen(SURFACE_APPEARANCE_PRESETS.soilMoisture.states[0]!.low));
 const preset={...SURFACE_APPEARANCE_PRESETS.soilMoisture,base:{...SURFACE_APPEARANCE_PRESETS.soilMoisture.base,width:32,height:32,detailGridX:16,detailGridY:16}};
 const result=await executeSurfaceAppearanceFamily(root,preset);
 assert.deepEqual(result.states.map(s=>s.id),["damp","dry","wet"]);
 const mean=async(ref:{sha256:string}&Parameters<typeof resolveAssetObject>[1])=>{const img=parseRgba8Image(await resolveAssetObject(root,ref));let sum=0;for(let i=0;i<img.pixels.length;i+=4) sum+=img.pixels[i]!;return sum/(img.pixels.length/4);};
 const byId=Object.fromEntries(result.states.map(s=>[s.id,s]));
 const brightness=[await mean(byId.dry!.outputs.color),await mean(byId.damp!.outputs.color),await mean(byId.wet!.outputs.color)];
 const roughness=[await mean(byId.dry!.outputs.roughness),await mean(byId.damp!.outputs.roughness),await mean(byId.wet!.outputs.roughness)];
 assert.ok(brightness[0]!>brightness[1]! && brightness[1]!>brightness[2]!);
 assert.ok(roughness[0]!>roughness[1]! && roughness[1]!>roughness[2]!);
}));
