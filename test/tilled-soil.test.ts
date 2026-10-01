import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { createAssetRef } from "../src/operations.js";
import { parseRgba8Image, encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { executeSurfaceHeightOperation, executeSurfaceTextureRecipe, executePreservedSurfaceTextureRecipe,
  SURFACE_TEXTURE_PRESETS, type SurfaceChannel } from "../src/surface-texture-recipes.js";
import { executeNormalFromHeightOperation } from "../src/procedural-texture-operations.js";
const height={seed:"42",width:16,height:1,gridX:1,gridY:1,detailGridX:1,detailGridY:1,detailWeight:0,heightMin:0,heightMax:255};
test("tilled furrows have an independent periodic square/softened cross-section",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"tilled-soil-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [softness,reference] of [
    [0,[0,0,0,0,0,0,0,0,255,255,255,255,255,255,255,255]],
    [1,[85,28,0,0,0,0,28,85,170,227,255,255,255,255,227,170]],
  ] as const) {
    const result=await executeSurfaceHeightOperation(root,{parameters:{...height,furrows:{axis:"x",count:1,depth:255,softness}}});
    const image=parseRgba8Image(await resolveAssetObject(root,createAssetRef(result.outputs.output)));
    assert.deepEqual(image.pixels,Buffer.from(reference.flatMap(v=>[v,v,v,255])));
  }
});
test("tilled depth mixes pinned constant grain before the declared height range",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"tilled-soil-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await executeSurfaceHeightOperation(root,{parameters:{...height,heightMin:20,heightMax:200,furrows:{axis:"x",count:1,depth:128,softness:0}}});
  const image=parseRgba8Image(await resolveAssetObject(root,createAssetRef(result.outputs.output)));
  assert.deepEqual(image.pixels,Buffer.from([...Array<number>(8).fill(38),...Array<number>(8).fill(128)].flatMap(v=>[v,v,v,255])));
});
test("odd dimensions sample a full periodic profile and both axes orient the same cross-section",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"tilled-soil-"));t.after(()=>rm(root,{recursive:true,force:true}));
  // Pixel-center sampling selects [1,3,5,8,10,12,14] in the 16-texel profile.
  const expected=[0,0,0,255,255,255,255];
  for(const axis of ["x","y"] as const) {
    const result=await executeSurfaceHeightOperation(root,{parameters:{...height,width:axis==="x"?7:3,height:axis==="x"?3:7,
      furrows:{axis,count:1,depth:255,softness:0}}});
    const image=parseRgba8Image(await resolveAssetObject(root,createAssetRef(result.outputs.output)));
    for(let y=0;y<image.height;y++) for(let x=0;x<image.width;x++) assert.deepEqual([...image.pixels.subarray((y*image.width+x)*4,(y*image.width+x+1)*4)],
      [expected[axis==="x"?x:y],expected[axis==="x"?x:y],expected[axis==="x"?x:y],255]);
  }
});
test("furrow controls fail before generation when malformed or undersampled",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"tilled-soil-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const furrows of [null,{}, {axis:"z",count:1,depth:255,softness:0}, {axis:"x",count:0,depth:255,softness:0},
    {axis:"x",count:9,depth:255,softness:0},{axis:"x",count:1,depth:256,softness:0},{axis:"x",count:1,depth:255,softness:4},
    {axis:"y",count:1,depth:255,softness:0},{axis:"x",count:1,depth:255,softness:0,unknown:true}]) {
    await assert.rejects(executeSurfaceHeightOperation(root,{parameters:{...height,furrows}}));
    assert.deepEqual(await readdir(root),[]);
  }
});
test("furrow edits retain grain component identities and zero depth retains original pixels",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"tilled-soil-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const plain=await executeSurfaceHeightOperation(root,{parameters:height});
  const off=await executeSurfaceHeightOperation(root,{parameters:{...height,furrows:{axis:"x",count:1,depth:0,softness:3}}});
  assert.deepEqual(off.outputs,plain.outputs);assert.deepEqual(off.observations.components,plain.observations.components);
  const shaped=await executeSurfaceHeightOperation(root,{parameters:{...height,furrows:{axis:"x",count:2,depth:200,softness:3}}});
  assert.deepEqual(shaped.observations.components,plain.observations.components);
  assert.notEqual(createAssetRef(shaped.outputs.output).sha256,createAssetRef(plain.outputs.output).sha256);
});
test("tilled channels cold-replay and recolor preserves accepted furrow structure",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"tilled-soil-")),cold=await mkdtemp(path.join(tmpdir(),"tilled-soil-cold-"));
  t.after(()=>Promise.all([rm(root,{recursive:true,force:true}),rm(cold,{recursive:true,force:true})]));
  const recipe={...SURFACE_TEXTURE_PRESETS["soil-tilled-deep"],width:17,height:13,gridX:3,gridY:2,detailGridX:8,detailGridY:6};
  const accepted=await executeSurfaceTextureRecipe(root,recipe);
  assert.deepEqual(await executeSurfaceTextureRecipe(root,recipe),accepted);
  assert.deepEqual(await executeSurfaceTextureRecipe(cold,recipe),accepted);
  const step=(channel:SurfaceChannel)=>accepted.steps.find(s=>s.output.sha256===accepted.outputs[channel]!.sha256)!;
  const recolor={...recipe,low:[60,30,10],high:[200,150,100]};
  const partial=await executePreservedSurfaceTextureRecipe(root,recolor,{preserve:{height:step("height"),normal:step("normal"),roughness:step("roughness")}});
  const {execution,...canonical}=partial;
  assert.equal(execution.executedOperations,1);assert.equal(execution.reusedOperations,5);
  assert.deepEqual(canonical,await executeSurfaceTextureRecipe(cold,recolor));
  for(const channel of ["height","normal","roughness"] as const) assert.deepEqual(partial.outputs[channel],accepted.outputs[channel]);
  assert.notEqual(partial.outputs.color!.sha256,accepted.outputs.color!.sha256);
  await assert.rejects(executePreservedSurfaceTextureRecipe(root,{...recipe,furrows:{...recipe.furrows,depth:100}},
    {preserve:{height:step("height")}}),/build does not match/);
});
test("tilled normal seams match the interior of an independently tiled heightfield",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"tilled-soil-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const axis of ["x","y"] as const) {
    const result=await executeSurfaceTextureRecipe(root,{...SURFACE_TEXTURE_PRESETS["soil-tilled-deep"],width:17,height:13,
      gridX:3,gridY:2,detailGridX:8,detailGridY:6,furrows:{axis,count:2,depth:220,softness:3}},{channels:["height","normal"]});
    const h=parseRgba8Image(await resolveAssetObject(root,result.outputs.height!)),n=parseRgba8Image(await resolveAssetObject(root,result.outputs.normal!));
    const width=h.width*3,repeatHeight=h.height*3,pixels=Buffer.alloc(width*repeatHeight*4);
    for(let y=0;y<repeatHeight;y++) for(let x=0;x<width;x++) h.pixels.copy(pixels,(y*width+x)*4,((y%h.height)*h.width+x%h.width)*4,((y%h.height)*h.width+x%h.width)*4+4);
    const source=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width,height:repeatHeight,pixels})})).asset;
    const reference=await executeNormalFromHeightOperation(root,{inputs:{source},parameters:{strength:4,wrap:false}});
    const repeated=parseRgba8Image(await resolveAssetObject(root,createAssetRef(reference.outputs.output)));
    for(let y=0;y<h.height;y++) for(let x=0;x<h.width;x++) {
      const from=((y+h.height)*width+x+h.width)*4,to=(y*h.width+x)*4;
      assert.deepEqual(n.pixels.subarray(to,to+4),repeated.pixels.subarray(from,from+4));
    }
  }
});
