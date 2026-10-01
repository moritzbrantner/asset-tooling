import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolveAssetObject} from "../src/asset-store.js";
import {parseRgba8Image} from "../src/image-rgba8.js";
import {SURFACE_TEXTURE_PRESETS,executeSurfaceTextureRecipe,executePreservedSurfaceTextureRecipe} from "../src/surface-texture-recipes.js";

async function workspace(run:(root:string,cold:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(tmpdir(),"paper-grain-"));
 const cold=await mkdtemp(path.join(tmpdir(),"paper-grain-cold-"));
 try {await run(root,cold);} finally {await rm(root,{recursive:true,force:true});await rm(cold,{recursive:true,force:true});}
}

test("paper color-only composition matches independent periodic scalar and RGB fixture",()=>workspace(async(root,cold)=>{
 const recipe={...SURFACE_TEXTURE_PRESETS["paper-fine"],width:4,height:3,gridX:2,gridY:1,detailGridX:1,detailGridY:1,detailWeight:0};
 const result=await executeSurfaceTextureRecipe(root,recipe,{channels:["color"]});
 // Seed 42's independently pinned scalar row is [50,64,78,64].
 // Paper's endpoint ramp rounds each RGB channel independently; alpha stays opaque.
 const row=[234,230,219,255,235,231,221,255,236,232,222,255,235,231,221,255];
 const image=parseRgba8Image(await resolveAssetObject(root,result.outputs.color!));
 assert.deepEqual([...image.pixels],[...row,...row,...row]);
 assert.deepEqual(Object.keys(result.outputs),["color"]);
 assert.deepEqual(result.steps.map(s=>s.operation.id),["image.procedural.height.surface","image.scalar.color-ramp"]);
 assert.deepEqual(await executeSurfaceTextureRecipe(cold,recipe,{channels:["color"]}),result);
}));

test("paper frequency controls preserve restrained opaque color and independently replay a locked-height recolor",()=>workspace(async(root,cold)=>{
 const hashes=new Set<string>();
 for(const name of ["paper-fine","paper-coarse","paper-fibers"] as const) {
  const recipe={...SURFACE_TEXTURE_PRESETS[name],width:129,height:131};
  const accepted=await executeSurfaceTextureRecipe(root,recipe,{channels:["color"]});
  assert.deepEqual(await executeSurfaceTextureRecipe(cold,recipe,{channels:["color"]}),accepted);
  hashes.add(accepted.outputs.color!.sha256);
  const image=parseRgba8Image(await resolveAssetObject(root,accepted.outputs.color!));
  for(let index=0;index<image.pixels.length;index+=4) {
   assert.equal(image.pixels[index+3],255);
   for(let channel=0;channel<3;channel++) {
    const value=image.pixels[index+channel]!;
    assert.ok(value>=recipe.low[channel]! && value<=recipe.high[channel]!);
   }
  }
  assert.ok(Object.isFrozen(SURFACE_TEXTURE_PRESETS[name].low));
  const height=accepted.steps.find(s=>s.output.metadata.field==="height");assert.ok(height);
  const edited={...recipe,low:[220,228,235],high:[238,244,249]};
  const partial=await executePreservedSurfaceTextureRecipe(root,edited,{channels:["color"],preserve:{height}});
  assert.equal(partial.execution.executedOperations,1);assert.equal(partial.execution.reusedOperations,3);
  assert.deepEqual(partial.steps[0],height);
  assert.notEqual(partial.outputs.color!.sha256,accepted.outputs.color!.sha256);
  const {execution:_execution,...canonical}=partial;
  assert.deepEqual(await executeSurfaceTextureRecipe(cold,edited,{channels:["color"]}),canonical);
  await assert.rejects(executePreservedSurfaceTextureRecipe(root,{...edited,seed:"43"},{channels:["color"],preserve:{height}}),/height/);
 }
 assert.equal(hashes.size,3,"frequency edits at the same seed and palette must change the actual artwork");
}));
