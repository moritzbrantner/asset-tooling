import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolveAssetObject,storeAssetObject} from "../src/asset-store.js";
import {parseRgba8Image,encodeRgba8Image,RGBA8_IMAGE_MEDIA_TYPE} from "../src/image-rgba8.js";
import {SURFACE_TEXTURE_PRESETS,executeSurfaceTextureRecipe,executePreservedSurfaceTextureRecipe,type SurfaceTexturePreservation} from "../src/surface-texture-recipes.js";
import {executeNormalFromHeightOperation} from "../src/procedural-texture-operations.js";
import {createAssetRef} from "../src/operations.js";

test("directional wood composes the existing independent one-dimensional grain fixture",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"wood-surfaces-"));
 try {
  const p=SURFACE_TEXTURE_PRESETS["wood-long-grain"];
  const result=await executeSurfaceTextureRecipe(root,{...p,width:4,height:3,gridX:2,gridY:1,detailGridX:1,detailGridY:1,detailWeight:0},{channels:["height"]});
  const actual=parseRgba8Image(await resolveAssetObject(root,result.outputs.height!));
  assert.deepEqual(actual.pixels,Buffer.from(Array.from({length:3},()=>[50,64,78,64]).flat().flatMap(v=>[v,v,v,255])));
  assert.equal(actual.pixels[0],50);assert.equal(actual.pixels[12],64,"periodic endpoints are not duplicated");
 } finally {await rm(root,{recursive:true,force:true});}
});

async function workspace(run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(path.join(tmpdir(),"wood-surfaces-check-"));
 try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}

function variation(image:ReturnType<typeof parseRgba8Image>) {
 let x=0,y=0;
 for(let row=0;row<image.height;row++) for(let column=0;column<image.width;column++) {
  const v=image.pixels[(row*image.width+column)*4]!;
  x+=Math.abs(v-image.pixels[(row*image.width+(column+1)%image.width)*4]!);
  y+=Math.abs(v-image.pixels[(((row+1)%image.height)*image.width+column)*4]!);
 }
 return {x,y};
}

test("controlled wood grain direction/length changes pixels at the same seed and preserves palette locks",()=>workspace(async root=>{
 const metrics:Record<string,{x:number;y:number}>={};
 for(const name of ["wood-long-grain","wood-short-grain","wood-cross-grain"] as const) {
  const recipe={...SURFACE_TEXTURE_PRESETS[name],width:101,height:103},accepted=await executeSurfaceTextureRecipe(root,recipe);
  assert.equal(recipe.seed,"42");assert.ok(Object.isFrozen(SURFACE_TEXTURE_PRESETS[name].low));
  metrics[name]=variation(parseRgba8Image(await resolveAssetObject(root,accepted.outputs.height!)));
  await workspace(async cold=>{assert.deepEqual(await executeSurfaceTextureRecipe(cold,recipe),accepted);});
  const preserve:SurfaceTexturePreservation={};
  for(const channel of ["height","normal","roughness"] as const) {
   const step=accepted.steps.find(s=>s.output.metadata.field===channel);assert.ok(step);preserve[channel]=step;
  }
  const recolored={...recipe,low:[80,45,20],high:[230,190,115]},partial=await executePreservedSurfaceTextureRecipe(root,recolored,{preserve});
  assert.equal(partial.execution.executedOperations,1);assert.equal(partial.execution.reusedOperations,5);
  for(const channel of ["height","normal","roughness"] as const) assert.deepEqual(partial.outputs[channel],accepted.outputs[channel]);
  assert.notEqual(partial.outputs.color!.sha256,accepted.outputs.color!.sha256);
  const {execution:_execution,...canonical}=partial;
  await workspace(async cold=>{assert.deepEqual(await executeSurfaceTextureRecipe(cold,recolored),canonical);});
 }
 assert.ok(metrics["wood-long-grain"]!.x>8*metrics["wood-long-grain"]!.y,"long grain varies across its length axis more slowly");
 assert.ok(metrics["wood-cross-grain"]!.y>8*metrics["wood-cross-grain"]!.x,"crosswise grain changes the dominant image direction");
 assert.ok(metrics["wood-short-grain"]!.y>metrics["wood-long-grain"]!.y,"short grain varies faster along its length axis");
}));

test("odd wood wrapped normals agree with the interior of an independently repeated height tile",()=>workspace(async root=>{
 const recipe={...SURFACE_TEXTURE_PRESETS["wood-long-grain"],width:17,height:13,gridX:4,gridY:1,detailGridX:8,detailGridY:2};
 const result=await executeSurfaceTextureRecipe(root,recipe,{channels:["height","normal"]});
 const height=parseRgba8Image(await resolveAssetObject(root,result.outputs.height!)),normal=parseRgba8Image(await resolveAssetObject(root,result.outputs.normal!));
 const width=height.width*3,h=height.height*3,pixels=Buffer.alloc(width*h*4);
 for(let y=0;y<h;y++) for(let x=0;x<width;x++) height.pixels.copy(pixels,(y*width+x)*4,((y%height.height)*height.width+x%height.width)*4,((y%height.height)*height.width+x%height.width)*4+4);
 const source=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width,height:h,pixels})})).asset;
 const independent=parseRgba8Image(await resolveAssetObject(root,createAssetRef((await executeNormalFromHeightOperation(root,{inputs:{source},parameters:{strength:recipe.normalStrength,wrap:false}})).outputs.output)));
 for(let y=0;y<height.height;y++) for(let x=0;x<height.width;x++) assert.deepEqual(normal.pixels.subarray((y*height.width+x)*4,(y*height.width+x)*4+4),independent.pixels.subarray(((y+height.height)*width+x+height.width)*4,((y+height.height)*width+x+height.width)*4+4));
 assert.equal(result.outputs.normal!.metadata.normalYAxis,"negative");
}));
