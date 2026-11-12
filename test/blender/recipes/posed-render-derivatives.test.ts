import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {storeAssetObject} from "../../../src/asset-store.js";
import {type CanonicalJsonObject} from "../../../src/operations.js";
import {type CanonicalJsonValue} from "../../../src/canonical.js";
import {normalizeRenderDerivativeParameters,prepareDirectionalRenderDerivativeRecipes,prepareRenderDerivativeRecipe,
 readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "../../../src/render-derivative-recipes.js";
import {quadGlb} from "../../fixtures/render-quad.js";
import {rigidGlb,skinnedGlb} from "../../fixtures/render-posed.js";
const generationModule=new URL("../../../src/core.js",import.meta.url).href;
const {generateAsset,verifyAsset}:{
 generateAsset:(p:string)=>Promise<{receipt:{observations:{script:CanonicalJsonObject}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>;
}=await import(generationModule);
const renderer=await readRenderDerivativeRecipeSource();
const pin={scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion};
const framing={type:"shared-orthographic",center:[0,1,0],horizontalSpan:4,pivot:[0,0,0]};
const parameters={...RENDER_DERIVATIVE_PRESETS.icon,width:64,height:64,samples:4,padding:.05,viewDirection:[0,0,1],framing};
const directions=[{id:"front",viewDirection:[0,0,1]},{id:"back",viewDirection:[0,0,-1]}];
function record(value:CanonicalJsonValue|undefined):CanonicalJsonObject {assert.ok(value && typeof value==="object" && !Array.isArray(value));return value;}
function near(actual:CanonicalJsonValue|undefined,expected:number,tolerance=1e-4) {assert.ok(typeof actual==="number" && Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);}

test("pose, sequence and crop controls are explicit and validated before Blender",async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"posed-render-controls-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const skinned=(await storeAssetObject(root,{bytes:skinnedGlb(),kind:"mesh",mediaType:"model/gltf-binary"})).asset;
 const staticQuad=(await storeAssetObject(root,{bytes:quadGlb(),kind:"mesh",mediaType:"model/gltf-binary"})).asset;
 const options={assetId:"fixture.posed",source:skinned,...pin};
 // Absent pose/overflow keep existing static identities.
 assert.ok(!Object.hasOwn(normalizeRenderDerivativeParameters(parameters),"pose"));
 assert.ok(!Object.hasOwn(normalizeRenderDerivativeParameters(parameters).framing!,"overflow"));
 for(const pose of [null,{clip:"lift"},{clip:"",timeSeconds:0},{clip:"lift",timeSeconds:-1},{clip:"lift",timeSeconds:NaN},{clip:"lift",timeSeconds:0,frame:1}]) {
  assert.throws(()=>normalizeRenderDerivativeParameters({...parameters,pose}));
 }
 assert.throws(()=>normalizeRenderDerivativeParameters({...parameters,framing:{...framing,overflow:"shrink"}}),/overflow/);
 const prepared=await prepareRenderDerivativeRecipe(root,{...options,parameters:{...parameters,pose:{clip:"lift",timeSeconds:.5}}});
 assert.deepEqual(prepared.clip,{name:"lift",durationSeconds:1});
 await assert.rejects(prepareRenderDerivativeRecipe(root,{...options,parameters}),/skins or animations/);
 await assert.rejects(prepareRenderDerivativeRecipe(root,{...options,parameters:{...parameters,pose:{clip:"walk",timeSeconds:0}}}),/exactly one source animation/);
 await assert.rejects(prepareRenderDerivativeRecipe(root,{...options,parameters:{...parameters,pose:{clip:"lift",timeSeconds:1.5}}}),/duration/);
 await assert.rejects(prepareRenderDerivativeRecipe(root,{...options,source:staticQuad,parameters:{...parameters,pose:{clip:"lift",timeSeconds:0}}}),/exactly one source animation/);

 const sequence=await prepareDirectionalRenderDerivativeRecipes(root,{...options,parameters,directions,sequence:{clip:"lift",frames:4}});
 assert.deepEqual(sequence.map(r=>[r.directionId,"sampleId" in r ? r.sampleId : "",r.spec.parameters.arguments.pose]),
  ["back","front"].flatMap(d=>[0,.25,.5,.75].map((timeSeconds,i)=>[d,`f00${i}`,{clip:"lift",timeSeconds}])));
 assert.deepEqual(await prepareDirectionalRenderDerivativeRecipes(root,{...options,parameters,directions:directions.toReversed(),sequence:{clip:"lift",frames:4}}),sequence);
 // Declared times, not IDs or caller order, order samples.
 const declared=await prepareDirectionalRenderDerivativeRecipes(root,{...options,parameters,directions:[directions[0]!],
  sequence:{clip:"lift",samples:[{id:"apex",timeSeconds:1},{id:"start",timeSeconds:0},{id:"mid",timeSeconds:.5}]}});
 assert.deepEqual(declared.map(r=>"sampleId" in r ? r.sampleId : ""),["start","mid","apex"]);
 assert.deepEqual(declared.map(r=>r.spec.assetId),["fixture.posed.front.start","fixture.posed.front.mid","fixture.posed.front.apex"]);
 for(const invalid of [{clip:"lift"},{clip:"lift",frames:0},{clip:"lift",frames:65},{clip:"lift",frames:2,samples:[{id:"a",timeSeconds:0}]},
  {clip:"lift",samples:[]},{clip:"lift",samples:[{id:"A",timeSeconds:0}]},{clip:"lift",samples:[{id:"a",timeSeconds:0},{id:"a",timeSeconds:1}]},
  {clip:"lift",samples:[{id:"a",timeSeconds:2}]},{clip:"walk",frames:2},{clip:"lift",frames:2,loop:true}]) {
  await assert.rejects(prepareDirectionalRenderDerivativeRecipes(root,{...options,parameters,directions,sequence:invalid}));
 }
 await assert.rejects(prepareDirectionalRenderDerivativeRecipes(root,{...options,parameters:{...parameters,pose:{clip:"lift",timeSeconds:0}},directions,sequence:{clip:"lift",frames:2}}),/omit parameters.pose/);
});

async function render(root:string,id:string,bytes:Buffer,kind:"mesh"|"animation",values:unknown) {
 const source=(await storeAssetObject(root,{bytes,kind,mediaType:"model/gltf-binary"})).asset;
 const prepared=await prepareRenderDerivativeRecipe(root,{assetId:`fixture.${id}`,source,parameters:values,...pin});
 const workspace=path.join(root,id);await mkdir(workspace);
 await writeFile(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeFile(path.join(workspace,"source.glb"),prepared.sourceBytes);
 const specPath=path.join(workspace,"asset.json");await writeFile(specPath,JSON.stringify(prepared.spec));
 return {specPath,pngPath:path.join(workspace,"render.png"),run:()=>generateAsset(specPath)};
}
function occupiedRows(pngPath:string,width:number,height:number) {
 const decoded=spawnSync("ffmpeg",["-v","error","-i",pngPath,"-f","rawvideo","-pix_fmt","rgba","-"],{timeout:30000,maxBuffer:1024*1024});
 assert.equal(decoded.status,0,decoded.stderr.toString());assert.equal(decoded.stdout.length,width*height*4);
 const rows:number[]=[];
 for(let y=0;y<height;y++) {for(let x=0;x<width;x++) {if(decoded.stdout[(y*width+x)*4+3]!>127) {rows.push(y);break;}}}
 return rows.length ? {top:rows[0]!,bottom:rows.at(-1)!+1} : undefined;
}

test("actual skinned and rigid clip times move the evaluated geometry inside one shared frame",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "configured Blender is required",timeout:240000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"posed-render-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 // 16 px per world unit; world y=1 is row 32 and the ground pivot is row 48.
 for(const [timeSeconds,top,bottom] of [[0,.5,.75],[.5,.375,.625],[1,.25,.5]] as const) {
  const job=await render(root,`lift-${timeSeconds}`,skinnedGlb(),"animation",{...parameters,pose:{clip:"lift",timeSeconds}});
  const observed=(await job.run()).receipt.observations.script,bounds=record(observed.projectedBounds);
  near(bounds.top,top);near(bounds.bottom,bottom);near(bounds.left,.375);near(bounds.right,.625);
  assert.deepEqual(record(observed.pose),{clip:"lift",timeSeconds,frame:timeSeconds*24,framesPerSecond:24});
  near(record(observed.pivot).y,48);
  const rows=occupiedRows(job.pngPath,64,64);assert.ok(rows);
  assert.ok(Math.abs(rows.top-top*64)<=1 && Math.abs(rows.bottom-bottom*64)<=1,JSON.stringify(rows));
  assert.equal((await verifyAsset(job.specPath)).status,"exact");
 }
 const slide=await render(root,"slide",rigidGlb(),"mesh",{...parameters,pose:{clip:"slide",timeSeconds:1}});
 const slid=record((await slide.run()).receipt.observations.script.projectedBounds);
 near(slid.left,.625);near(slid.right,.875);near(slid.top,.5);near(slid.bottom,.75);
 // Only the declared clip is evaluated: "drop" leaves the frame and is diagnosed without output.
 const drop=await render(root,"drop",skinnedGlb(),"animation",{...parameters,pose:{clip:"drop",timeSeconds:0}});
 await assert.rejects(drop.run(),/clips the declared padded bounds/);
 await assert.rejects(readFile(drop.pngPath),/ENOENT/);
 // A declared crop renders the overflowing bust and records that it cropped.
 const bust={...framing,center:[0,1,0],horizontalSpan:.5};
 const rejected=await render(root,"bust-reject",skinnedGlb(),"animation",{...parameters,framing:bust,pose:{clip:"lift",timeSeconds:.5}});
 await assert.rejects(rejected.run(),/clips the declared padded bounds|logical pivot/);
 const cropped=await render(root,"bust-crop",skinnedGlb(),"animation",{...parameters,framing:{...bust,pivot:[0,1,0],overflow:"crop"},pose:{clip:"lift",timeSeconds:.5}});
 const croppedObserved=(await cropped.run()).receipt.observations.script;
 assert.equal(record(croppedObserved.framing).cropped,true);
 assert.deepEqual(occupiedRows(cropped.pngPath,64,64),{top:0,bottom:64});
});
