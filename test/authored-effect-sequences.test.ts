import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,rm,readdir,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {resolveAssetObject} from "../src/asset-store.js";
import {createAssetRef} from "../src/operations.js";
import {parseRgba8Image} from "../src/image-rgba8.js";
import {executeAuthoredEffectSequenceRecipe,AUTHORED_EFFECT_SEQUENCE_PRESETS,normalizeAuthoredEffectSequenceRecipe} from "../src/authored-effect-sequences.js";
import type {SpriteAtlasManifest} from "../src/sprite-atlas-operations.js";

const artwork={shape:"puff",width:11,height:13,centerX:5,centerY:6,radius:2,softness:1,color:[31,129,240],opacity:180} as const;
const recipe={schemaVersion:1,sequence:"fixture.puff",loop:false,atlas:{columns:2,padding:1,extrusion:1,trim:false},frames:[
 {index:0,timeMs:0,durationMs:3,artwork},
 {index:1,timeMs:3,durationMs:7,artwork:{...artwork,opacity:90}},
 {index:2,timeMs:10,durationMs:5,artwork:{...artwork,opacity:0}},
]};

test("explicit authored times and non-square pixels survive the existing atlas",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"authored-effects-"));
 try {
  const result=await executeAuthoredEffectSequenceRecipe(root,recipe);
  const atlas=parseRgba8Image(await resolveAssetObject(root,createAssetRef(result.atlas.result.outputs.image)));
  assert.deepEqual([atlas.width,atlas.height],[30,34]);
  const raw=JSON.parse((await resolveAssetObject(root,createAssetRef(result.atlas.result.outputs.manifest))).toString());
  assert.deepEqual(raw.sprites.map((s:{frame:unknown})=>s.frame),recipe.frames.map(({index,timeMs,durationMs})=>({sequence:"fixture.puff",index,timeMs,durationMs,loop:false})));
  for(const [index,alpha] of [180,90,0].entries()) {
   const image=parseRgba8Image(await resolveAssetObject(root,result.frames[index]!.image));
   assert.deepEqual([...image.pixels.subarray((6*11+5)*4,(6*11+5)*4+4)],[31,129,240,alpha]);
   const x=index===1?17:2,y=index===2?19:2;
   assert.deepEqual([...atlas.pixels.subarray(((y+6)*30+x+5)*4,((y+6)*30+x+5)*4+4)],[31,129,240,alpha]);
  }
  assert.equal(result.durationMs,15);
 } finally {await rm(root,{recursive:true,force:true});}
});

async function workspace(run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(tmpdir(),"authored-effects-check-"));
 try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}
async function inventory(root:string) {
 return Promise.all((await readdir(root,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(async e=>{
  const p=path.join(e.parentPath,e.name),s=await stat(p);return [path.relative(root,p),s.size,s.mtimeMs] as const;
 })).then(v=>v.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
}

test("all poses, explicit times and conservative budgets validate before generation",()=>workspace(async root=>{
 const invalidFrames=[
  {...recipe.frames[1],index:0},{...recipe.frames[1],timeMs:4},{...recipe.frames[1],timeMs:2},
  {...recipe.frames[1],durationMs:0},{...recipe.frames[1],durationMs:Infinity},
  {...recipe.frames[1],artwork:{...artwork,width:12}},
  {...recipe.frames[1],artwork:{...artwork,centerX:6}},
  {...recipe.frames[1],artwork:{...artwork,radius:128}},
 ];
 const invalid=[...invalidFrames.map(f=>({...recipe,frames:[recipe.frames[0],f,recipe.frames[2]]})),
  {...recipe,frames:[recipe.frames[0]]},{...recipe,frames:[]},{...recipe,loop:true},{...recipe,sequence:"unsafe/path"},
  {...recipe,frames:[...recipe.frames.slice(0,2),{...recipe.frames[2],artwork}]},
  {...recipe,frames:[{artwork,index:0,durationMs:3},...recipe.frames.slice(1)]},
  {...recipe,atlas:{...recipe.atlas,columns:0}},{...recipe,atlas:{...recipe.atlas,trim:"yes"}},
  {...recipe,atlas:{...recipe.atlas,rotation:true}},{...recipe,evaluatorCode:"forbidden"},
  {...recipe,frames:Array.from({length:33},(_,index)=>({artwork:{...artwork,opacity:0},index,timeMs:index,durationMs:1}))},
  {...recipe,frames:Array.from({length:7},(_,index)=>({artwork:{...artwork,opacity:0},index,timeMs:index*10000,durationMs:10000}))},
  {...recipe,atlas:{...recipe.atlas,columns:1},frames:Array.from({length:32},(_,index)=>({artwork:{...artwork,width:256,height:256,opacity:0},index,timeMs:index,durationMs:1}))},
 ];
 for(const value of invalid) {
  await assert.rejects(executeAuthoredEffectSequenceRecipe(root,value));
  await assert.rejects(stat(path.join(root,".asset-tooling")),{code:"ENOENT"});
 }
 await assert.rejects(executeAuthoredEffectSequenceRecipe("relative",recipe),/absolute/);
}));

test("cold/full/repacked frames preserve authored identity and reconcile original objects",()=>workspace(async root=>{
 const first=await executeAuthoredEffectSequenceRecipe(root,recipe),before=await inventory(root);
 assert.deepEqual(await executeAuthoredEffectSequenceRecipe(root,recipe),first);assert.deepEqual(await inventory(root),before);
 await workspace(async cold=>{assert.deepEqual(await executeAuthoredEffectSequenceRecipe(cold,recipe),first);});
 const repacked=await executeAuthoredEffectSequenceRecipe(root,{...recipe,atlas:{columns:1,padding:0,extrusion:2,trim:true}});
 assert.deepEqual(repacked.frames,first.frames);
 assert.notEqual(repacked.recipeSha256,first.recipeSha256);
 const retimed=await executeAuthoredEffectSequenceRecipe(root,{...recipe,frames:[recipe.frames[0],{...recipe.frames[1],durationMs:8},{...recipe.frames[2],timeMs:11}]});
 assert.deepEqual(retimed.frames.map(f=>f.image),first.frames.map(f=>f.image));
 assert.equal(createAssetRef(retimed.atlas.result.outputs.image).sha256,createAssetRef(first.atlas.result.outputs.image).sha256);
 assert.notEqual(createAssetRef(retimed.atlas.result.outputs.manifest).sha256,createAssetRef(first.atlas.result.outputs.manifest).sha256);
 assert.notDeepEqual(retimed.atlas.build,first.atlas.build);
 const changed=await executeAuthoredEffectSequenceRecipe(root,{...recipe,frames:[recipe.frames[0],{...recipe.frames[1],artwork:{...artwork,color:[1,2,3],opacity:90}},recipe.frames[2]]});
 assert.deepEqual(changed.frames[0],first.frames[0]);assert.deepEqual(changed.frames[2],first.frames[2]);
 assert.notEqual(changed.frames[1]!.image.sha256,first.frames[1]!.image.sha256);
 assert.deepEqual(await executeAuthoredEffectSequenceRecipe(root,recipe),first);
}));

test("subtle/strong/off authored presets round-trip visible pixels, pivots and final blank frames",()=>workspace(async root=>{
 assert.ok(Object.isFrozen(AUTHORED_EFFECT_SEQUENCE_PRESETS.ring.strong.frames[0]!.artwork.color));
 for(const shape of ["ring","puff"] as const) for(const intensity of ["subtle","strong","off"] as const) {
  const p=AUTHORED_EFFECT_SEQUENCE_PRESETS[shape][intensity],result=await executeAuthoredEffectSequenceRecipe(root,p);
  const manifest:SpriteAtlasManifest=JSON.parse((await resolveAssetObject(root,createAssetRef(result.atlas.result.outputs.manifest))).toString());
  const atlas=parseRgba8Image(await resolveAssetObject(root,manifest.image));
  assert.equal(result.durationMs,shape==="ring"?420:600);
  for(const entry of manifest.sprites) {
   const source=parseRgba8Image(await resolveAssetObject(root,entry.source));
   assert.deepEqual(entry.pivot,{x:p.frames[0]!.artwork.centerX,y:p.frames[0]!.artwork.centerY});
   assert.equal(entry.frame!.timeMs,p.frames[entry.frame!.index]!.timeMs);
   for(let y=0;y<source.height;y++) for(let x=0;x<source.width;x++) {
    const expected=[...source.pixels.subarray((y*source.width+x)*4,(y*source.width+x)*4+4)];
    const ax=x-entry.trimOffset.x,ay=y-entry.trimOffset.y;
    const actual=entry.empty || ax<0 || ay<0 || ax>=entry.rect.width || ay>=entry.rect.height?[0,0,0,0]:
     [...atlas.pixels.subarray(((entry.rect.y+ay)*atlas.width+entry.rect.x+ax)*4,((entry.rect.y+ay)*atlas.width+entry.rect.x+ax)*4+4)];
    assert.equal(actual[3],expected[3]);if(expected[3]!>0) assert.deepEqual(actual,expected);
    if(intensity==="off" || entry.frame!.index===5) assert.equal(expected[3],0);
   }
  }
 }
}));

test("pre-abort and cancellation between stages leave accepted atlas evidence intact",()=>workspace(async root=>{
 const accepted=await executeAuthoredEffectSequenceRecipe(root,recipe),manifest=createAssetRef(accepted.atlas.result.outputs.manifest),bytes=await resolveAssetObject(root,manifest),before=await inventory(root);
 const controller=new AbortController();controller.abort(new Error("cancelled"));
 await assert.rejects(executeAuthoredEffectSequenceRecipe(root,recipe,{signal:controller.signal}),/cancelled/);assert.deepEqual(await inventory(root),before);
 const saved=path.join(root,"recipe.json");await writeFile(saved,JSON.stringify(recipe));
 const child=spawnSync(process.execPath,["--eval",`
  import {mock} from "bun:test";
  import {readFile} from "node:fs/promises";
  const controller=new AbortController(),effects=await import("./src/effect-artwork-recipes.ts");const prepare=effects.createEffectArtworkBuildIdentity;let prepared=0,packed=0;
  mock.module("./src/effect-artwork-recipes.ts",()=>({...effects,async createEffectArtworkBuildIdentity(...args){const result=await prepare(...args);if(++prepared===2) controller.abort(new Error("cancelled between frames"));return result;}}));
  const atlas=await import("./src/sprite-atlas-operations.ts");
  mock.module("./src/sprite-atlas-operations.ts",()=>({...atlas,async executeSpriteAtlasOperation(){packed++;throw new Error("packing forbidden after abort");}}));
  const {executeAuthoredEffectSequenceRecipe}=await import("./src/authored-effect-sequences.ts");
  let cancelled=false;
  try {await executeAuthoredEffectSequenceRecipe(process.argv[1],JSON.parse(await readFile(process.argv[2],"utf8")),{signal:controller.signal});}
  catch(e){if(e.message!=="cancelled between frames") throw e;cancelled=true;}
  if(!cancelled || packed!==0 || prepared!==2) throw new Error("cancellation guard missed");
 `,root,saved],{cwd:path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),encoding:"utf8",timeout:30000});
 assert.equal(child.status,0,child.error?.message??child.stderr);
 assert.deepEqual(await resolveAssetObject(root,manifest),bytes);
 await rm(saved);assert.deepEqual(await inventory(root),before);
 assert.deepEqual(normalizeAuthoredEffectSequenceRecipe(recipe),recipe);
}));
