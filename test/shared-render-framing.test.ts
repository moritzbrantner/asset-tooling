import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {storeAssetObject} from "../src/asset-store.js";
import {type CanonicalJsonObject} from "../src/operations.js";
import {type CanonicalJsonValue} from "../src/canonical.js";
import {normalizeRenderDerivativeParameters,prepareDirectionalRenderDerivativeRecipes,readRenderDerivativeRecipeSource,RENDER_DERIVATIVE_PRESETS} from "../src/render-derivative-recipes.js";
import {quadGlb} from "./fixtures/render-quad.js";
const generationModule=new URL("../src/core.js",import.meta.url).href;
const {generateAsset,verifyAsset}:{
 generateAsset:(p:string)=>Promise<{cache:{status:string};receipt:{observations:{script:CanonicalJsonObject}}}>;
 verifyAsset:(p:string)=>Promise<{status:string}>;
}=await import(generationModule);
const renderer=await readRenderDerivativeRecipeSource();
const parameters={...RENDER_DERIVATIVE_PRESETS.icon,width:81,height:121,samples:8,padding:.06,
 framing:{type:"shared-orthographic",center:[0,1,0],horizontalSpan:2,pivot:[0,0,0]}};
const directions=[{id:"front",viewDirection:[0,0,1]},{id:"back",viewDirection:[0,0,-1]}];
const scriptPin={scriptSha256:renderer.sha256,blenderVersion:renderer.blenderVersion};
function record(value:CanonicalJsonValue|undefined):CanonicalJsonObject {
 assert.ok(value && typeof value==="object" && !Array.isArray(value));return value;
}
function number(value:CanonicalJsonValue|undefined):number {assert.equal(typeof value,"number");assert.ok(typeof value==="number");return value;}
function near(actual:number,expected:number,tolerance=1e-5) {assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);}

test("shared world framing and direction IDs are validated independently of input order",async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"shared-render-controls-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=quadGlb(),source=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset;
 const options={assetId:"fixture.directions",source,parameters,directions,...scriptPin};
 const first=await prepareDirectionalRenderDerivativeRecipes(root,options),reordered=await prepareDirectionalRenderDerivativeRecipes(root,{...options,directions:directions.toReversed()});
 assert.deepEqual(reordered,first);assert.deepEqual(first.map(r=>r.directionId),["back","front"]);
 const added=await prepareDirectionalRenderDerivativeRecipes(root,{...options,directions:[...directions,{id:"right",viewDirection:[1,0,0]}]});
 assert.deepEqual(added.filter(r=>r.directionId!=="right"),first);
 assert.deepEqual(first[0]!.source,source);assert.deepEqual(first[0]!.sourceBytes,bytes);
 for(const invalid of [[],[...directions,directions[0]],[{id:"../front",viewDirection:[0,0,1]}],[{id:"front",viewDirection:[0,1,0]}],
  [{id:"front",viewDirection:[0,0,0]}],[{id:"front",viewDirection:[0,0,1],ambient:true}],Array.from({length:17},(_,i)=>({id:`d${i}`,viewDirection:[0,0,1]}))]) {
  await assert.rejects(prepareDirectionalRenderDerivativeRecipes(root,{...options,directions:invalid}));
 }
 await assert.rejects(prepareDirectionalRenderDerivativeRecipes(root,{...options,parameters:RENDER_DERIVATIVE_PRESETS.icon}),/shared orthographic/);
 for(const framing of [null,{}, {...parameters.framing,horizontalSpan:0},{...parameters.framing,horizontalSpan:100001},
  {...parameters.framing,horizontalSpan:true},{...parameters.framing,center:[0,NaN,0]},{...parameters.framing,pivot:[0,0]},
  {...parameters.framing,type:"auto"},{...parameters.framing,hidden:true}]) {
  assert.throws(()=>normalizeRenderDerivativeParameters({...parameters,framing}));
 }
 assert.throws(()=>normalizeRenderDerivativeParameters({...parameters,projection:{type:"perspective",horizontalFovDegrees:40}}),/orthographic/);
 assert.ok(!Object.hasOwn(normalizeRenderDerivativeParameters(RENDER_DERIVATIVE_PRESETS.icon),"framing"));
 await assert.rejects(prepareDirectionalRenderDerivativeRecipes(root,{...options,source:{...source,sha256:"0".repeat(64)}}));
});

test("actual shared-frame PNGs preserve world scale and ground pivots across states and opposite directions",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "configured Blender is required",timeout:150000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"shared-render-native-"));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const height of [.5,1]) {
  // Independent quad, not a generated model: .5 units wide, grounded, with
  // analytically known world height. Opposite views retain a double-sided plane.
  const bytes=quadGlb({scenes:[{nodes:[0]}],nodes:[{name:"plane",mesh:0,translation:[0,height/2,0],scale:[.25,height,1]}]});
  const source=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset;
  const prepared=await prepareDirectionalRenderDerivativeRecipes(root,{assetId:`fixture.h${height===1?"tall":"short"}`,source,parameters,directions,...scriptPin});
  for(const render of prepared) {
   const workspace=path.join(root,`${height}-${render.directionId}`);await mkdir(workspace);
   const specPath=path.join(workspace,"asset.json"),pngPath=path.join(workspace,"render.png");
   await writeFile(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeFile(path.join(workspace,"source.glb"),render.sourceBytes);
   await writeFile(specPath,JSON.stringify(render.spec));
   const generated=await generateAsset(specPath),observed=generated.receipt.observations.script;
   const pivot=record(observed.pivot),bounds=record(observed.projectedBounds),framing=record(observed.framing);
   // Blender camera vectors use native float precision; this is < .0001 pixel.
   near(number(pivot.x),40.5,1e-4);near(number(pivot.y),101,1e-4);
   near(number(framing.worldUnitsPerPixel),2/81);assert.deepEqual(framing.trimOffset,{x:0,y:0});
   near(number(bounds.left),.375);near(number(bounds.right),.625);
   near(number(bounds.bottom),101/121);near(number(bounds.top),(101-height*81/2)/121);
   const decoded=spawnSync("ffmpeg",["-v","error","-i",pngPath,"-f","rawvideo","-pix_fmt","rgba","-"],{timeout:30000,maxBuffer:1024*1024});
   assert.equal(decoded.status,0,decoded.stderr.toString());assert.equal(decoded.stdout.length,81*121*4);
   const occupied:{x:number;y:number}[]=[];
   for(let y=0;y<121;y++) {for(let x=0;x<81;x++) {if(decoded.stdout[(y*81+x)*4+3]!>127) {occupied.push({x,y});}}}
   assert.ok(occupied.length>0);const top=Math.min(...occupied.map(p=>p.y)),bottom=Math.max(...occupied.map(p=>p.y))+1;
   assert.ok(Math.abs(bottom-101)<=1);assert.ok(Math.abs((bottom-top)-height*81/2)<=1.5);
   const accepted=await readFile(pngPath),receipt=await readFile(pngPath+".receipt.json"),mtime=(await stat(pngPath)).mtimeMs;
   assert.equal((await verifyAsset(specPath)).status,"exact");assert.equal((await generateAsset(specPath)).cache.status,"hit");
   assert.deepEqual(await readFile(pngPath),accepted);assert.equal((await stat(pngPath)).mtimeMs,mtime);
   assert.deepEqual(await readFile(path.join(workspace,"source.glb")),bytes);
   for(const framing of [{...parameters.framing,horizontalSpan:.05},{...parameters.framing,pivot:[100,0,0]}]) {
    await writeFile(specPath,JSON.stringify({...render.spec,parameters:{...render.spec.parameters,arguments:{...parameters,viewDirection:record(render.spec.parameters.arguments).viewDirection,framing}}}));
    await assert.rejects(generateAsset(specPath),/camera framing clips|logical pivot falls outside/);
    assert.deepEqual(await readFile(pngPath),accepted);assert.deepEqual(await readFile(pngPath+".receipt.json"),receipt);assert.equal((await stat(pngPath)).mtimeMs,mtime);
   }
  }
 }
});

test("shared frames retain negative-coordinate anchors, extreme aspect and distant source depth",{
 skip:!process.env.ASSET_TOOLING_BLENDER && "configured Blender is required",timeout:90000,
},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),"shared-render-depth-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const cases=[
  {id:"negative",width:121,height:21,center:[-2,.5,-3],span:8,pivot:[-2,0,-3],expectedPivot:{x:60.5,y:18.0625},
   nodes:[{name:"plane",mesh:0,translation:[-2,.5,-3],scale:[.25,1,1]}],alphaPoints:[{x:60,y:10}]},
  {id:"deep",width:81,height:121,center:[0,.5,0],span:2,pivot:[0,0,0],expectedPivot:{x:40.5,y:80.75},
   nodes:[{name:"near",mesh:0,translation:[-.5,.5,0],scale:[.25,1,1]},
    {name:"far",mesh:0,translation:[.5,.5,-1000],scale:[.25,1,1]}],alphaPoints:[{x:20,y:60},{x:60,y:60}]},
 ];
 for(const item of cases) {
  const bytes=quadGlb({scenes:[{nodes:item.nodes.map((_,i)=>i)}],nodes:item.nodes});
  const source=(await storeAssetObject(root,{bytes,kind:"mesh",mediaType:"model/gltf-binary"})).asset;
  const prepared=await prepareDirectionalRenderDerivativeRecipes(root,{assetId:`fixture.${item.id}`,source,...scriptPin,
   directions:[{id:"front",viewDirection:[0,0,1]}],parameters:{...parameters,width:item.width,height:item.height,
    framing:{type:"shared-orthographic",center:item.center,horizontalSpan:item.span,pivot:item.pivot}}});
  const workspace=path.join(root,item.id);await mkdir(workspace);const specPath=path.join(workspace,"asset.json");
  await writeFile(path.join(workspace,"render_static_glb.py"),renderer.bytes);await writeFile(path.join(workspace,"source.glb"),bytes);
  await writeFile(specPath,JSON.stringify(prepared[0]!.spec));
  const observed=(await generateAsset(specPath)).receipt.observations.script,pivot=record(observed.pivot);
  near(number(pivot.x),item.expectedPivot.x,1e-4);near(number(pivot.y),item.expectedPivot.y,1e-4);
  const decoded=spawnSync("ffmpeg",["-v","error","-i",path.join(workspace,"render.png"),"-f","rawvideo","-pix_fmt","rgba","-"],{timeout:30000,maxBuffer:1024*1024});
  assert.equal(decoded.status,0,decoded.stderr.toString());assert.equal(decoded.stdout.length,item.width*item.height*4);
  for(const point of item.alphaPoints) {assert.equal(decoded.stdout[(point.y*item.width+point.x)*4+3],255,"both near/far declared surfaces must reach the pixels");}
  assert.equal((await verifyAsset(specPath)).status,"exact");
 }
});
