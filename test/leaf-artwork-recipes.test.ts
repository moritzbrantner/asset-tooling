import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeLeafArtworkRecipe, LEAF_ARTWORK_PRESETS } from "../src/leaf-artwork-recipes.js";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAssetRef } from "../src/operations.js";
import { canonicalJson } from "../src/canonical.js";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { LEAF_MASK_OPERATION, MASK_COLOR_GRADIENT_OPERATION, executeLeafMaskOperation, executeMaskColorGradientOperation, executePreservedLeafArtworkRecipe, normalizeLeafArtworkRecipe } from "../src/leaf-artwork-recipes.js";

test("leaf recoloring preserves the complete silhouette identity", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"leaf-artwork-"));
  try {
    const first=await executeLeafArtworkRecipe(root,LEAF_ARTWORK_PRESETS.broad);
    const changed=await executeLeafArtworkRecipe(root,{...LEAF_ARTWORK_PRESETS.broad,low:[12,34,56],high:[78,90,123]});
    assert.deepEqual(changed.outputs.mask,first.outputs.mask);
    assert.notEqual(changed.outputs.image.sha256,first.outputs.image.sha256);
  } finally { await rm(root,{recursive:true,force:true}); }
});


const small={schemaVersion:1,width:11,height:13,radius:3,offset:1,softness:2,low:[10,20,30],high:[130,80,6]} as const;
async function inventory(root:string) {
  const files=(await readdir(root,{recursive:true,withFileTypes:true})).filter(e=>e.isFile());
  return Promise.all(files.map(async e=>{const filename=path.join(e.parentPath,e.name),s=await stat(filename);return [path.relative(root,filename),s.size,s.mtimeMs] as const;})).then(v=>v.sort((a,b)=>a[0].localeCompare(b[0])));
}
async function pixels(root:string,ref:unknown) {return parseRgba8Image(await resolveAssetObject(root,createAssetRef(ref)));}

test("leaf lens and straight-alpha color match independent odd/non-square references",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"leaf-reference-"));
  try {
    const first=await executeLeafArtworkRecipe(root,small),mask=await pixels(root,first.outputs.mask),image=await pixels(root,first.outputs.image);
    assert.deepEqual([...Array(11)].map((_,x)=>mask.pixels[(6*11+x)*4]),[0,0,126,255,255,255,255,255,126,0,0]);
    assert.equal(mask.pixels[(10*11+5)*4],62); // Two independently quantized half-coverages: round(126² / 255).
    for(let y=0;y<13;y++) for(let x=0;x<11;x++) {
      // Reference uses platform sqrt, rather than the producer's integer SDF kernel.
      const coverage=(cx:number)=>{
        const d=Math.floor(Math.hypot(x-cx,y-6))-3;
        if(d<=0) return 255;
        const encoded=Math.min(127,Math.floor(d*127/2+0.5));
        return 255-Math.floor(encoded*255/127+0.5);
      };
      const alpha=Math.floor(coverage(4)*coverage(6)/255+0.5),i=(y*11+x)*4;
      assert.deepEqual([...mask.pixels.subarray(i,i+4)],[alpha,alpha,alpha,255]);
      const rgb=[10+Math.round(120*y/12),20+Math.round(60*y/12),30-Math.round(24*y/12)];
      assert.deepEqual([...image.pixels.subarray(i,i+4)],[...rgb,alpha]);
      if(x===0 || y===0 || x===10 || y===12) assert.equal(alpha,0);
    }
    assert.equal(first.outputs.mask.metadata.channelColorSpace,"linear");
    assert.equal(first.outputs.image.metadata.alphaMode,"straight");
    assert.equal(createAssetRef(first.colorBuild.inputs.mask).sha256,first.outputs.mask.sha256);
    assert.deepEqual(first.outputs.mask.metadata.pivot,{x:5,y:6});
  } finally {await rm(root,{recursive:true,force:true});}
});

test("leaf controls and invalid saved coverage fail before writes",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"leaf-invalid-"));
  try {
    for(const change of [{width:8},{width:257},{height:2},{radius:0},{radius:128},{offset:-1},{offset:3},{offset:1.5},{softness:0},{softness:17},{low:[0,0,256]},{high:[1,2]},{seed:"42"},{schemaVersion:2}]) {
      await assert.rejects(executeLeafArtworkRecipe(root,{...small,...change}));
      assert.deepEqual(await inventory(root),[]);
    }
    await assert.rejects(executeLeafArtworkRecipe("relative",small),/absolute/);
    await assert.rejects(executeLeafMaskOperation(root,{parameters:{width:11,height:13,radius:3,offset:1,softness:2},inputs:{unexpected:{}}}),/input|port/i);
    assert.deepEqual(await inventory(root),[]);
    for(const pixel of [[0,1,0,255],[0,0,0,100]]) {
      const mask=(await storeAssetObject(root,{kind:"image",mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:1,height:1,pixels:Buffer.from(pixel)})})).asset;
      const before=await inventory(root);
      await assert.rejects(executeMaskColorGradientOperation(root,{parameters:{low:[0,0,0],high:[255,255,255]},inputs:{mask}}),/opaque grayscale/);
      assert.deepEqual(await inventory(root),before);
    }
    assert.equal(Object.isFrozen(LEAF_ARTWORK_PRESETS.broad.low),true);
    assert.equal(Reflect.set(LEAF_ARTWORK_PRESETS.broad,"radius",100),false);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("leaf full, cold and explicitly preserved recolors agree across restart and undo",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"leaf-preserve-")),cold=await mkdtemp(path.join(tmpdir(),"leaf-cold-"));
  try {
    for(const preset of Object.values(LEAF_ARTWORK_PRESETS)) {
      const first=await executeLeafArtworkRecipe(root,preset),before=await inventory(root);
      assert.deepEqual(await executeLeafArtworkRecipe(root,preset),first);
      assert.deepEqual(await inventory(root),before);
      assert.deepEqual(await executeLeafArtworkRecipe(cold,preset),first);
      const changed={...preset,low:[220,140,20],high:[70,36,12]};
      const partial=await executePreservedLeafArtworkRecipe(root,changed,{mask:first.maskStep});
      const {execution,...result}=partial;
      assert.deepEqual(result,await executeLeafArtworkRecipe(cold,changed));
      assert.deepEqual(execution,{executedOperations:1,reusedOperations:1,maskPixelsGenerated:0,colorPixelsGenerated:64*64});
      assert.deepEqual(result.outputs.mask,first.outputs.mask);
      const oldImage=await pixels(root,first.outputs.image),newImage=await pixels(root,result.outputs.image);
      for(let i=3;i<oldImage.pixels.length;i+=4) assert.equal(oldImage.pixels[i],newImage.pixels[i]);
      const restarted=JSON.parse(canonicalJson(first.maskStep));
      const undone=await executePreservedLeafArtworkRecipe(root,preset,{mask:restarted});
      const {execution:_undo,...undoResult}=undone;
      assert.deepEqual(undoResult,first);
    }
    for(const p of [{...small,width:9,height:9,radius:2,offset:1,softness:1},{...small,width:256,height:256,radius:110,offset:50,softness:16}]) {
      const first=await executeLeafArtworkRecipe(root,p);
      assert.deepEqual(await executeLeafArtworkRecipe(cold,p),first);
    }
  } finally {await rm(root,{recursive:true,force:true});await rm(cold,{recursive:true,force:true});}
});

test("preserved leaf masks reject stale controls, forged evidence and corrupted bytes without writes",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"leaf-locks-"));
  try {
    const accepted=await executeLeafArtworkRecipe(root,small),before=await inventory(root),step=accepted.maskStep;
    for(const change of [{radius:2},{offset:0},{softness:1},{width:13}]) {
      await assert.rejects(executePreservedLeafArtworkRecipe(root,{...small,...change},{mask:step}),/does not match/);
      assert.deepEqual(await inventory(root),before);
    }
    for(const invalid of [
      {...step,observations:{...step.observations,randomness:"ambient"}},
      {...step,output:createAssetRef({...step.output,metadata:{...step.output.metadata,channelColorSpace:"srgb"}})},
      {...step,output:createAssetRef({...step.output,sha256:"0".repeat(64)})},
      {...step,build:{...step.build,implementation:{...step.build.implementation,version:"other"}}},
    ]) {
      await assert.rejects(executePreservedLeafArtworkRecipe(root,small,{mask:invalid}));
      assert.deepEqual(await inventory(root),before);
    }
    // @ts-expect-error Explicitly test an unknown untrusted preservation key.
    await assert.rejects(executePreservedLeafArtworkRecipe(root,small,{image:accepted.outputs.image}),/only/);
    const filename=path.join(root,assetObjectPortablePath(step.output)),original=await readFile(filename);
    await writeFile(filename,Buffer.from("tampered"));
    const damaged=await inventory(root);
    await assert.rejects(executePreservedLeafArtworkRecipe(root,small,{mask:step}),/byte|hash|sha256/i);
    assert.deepEqual(await inventory(root),damaged);
    await writeFile(filename,original);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("saved leaf coverage is verified and reused without calling the shape generator",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"leaf-execution-"));
  try {
    const accepted=await executeLeafArtworkRecipe(root,small),snapshot=path.join(root,"accepted.json");
    await writeFile(snapshot,canonicalJson({recipe:{...small,low:[1,2,3],high:[4,5,6]},step:accepted.maskStep}));
    const child=spawnSync(process.execPath,["--eval",`
      import {mock} from "bun:test";
      import {readFile} from "node:fs/promises";
      const shapes=await import("./src/procedural-shapes.ts");
      mock.module("./src/procedural-shapes.ts",()=>({...shapes,generateCircleSdfRgba8(){throw new Error("shape generation forbidden");}}));
      const {executePreservedLeafArtworkRecipe,executeLeafArtworkRecipe}=await import("./src/leaf-artwork-recipes.ts");
      const {recipe,step}=JSON.parse(await readFile(process.argv[2],"utf8"));
      const r=await executePreservedLeafArtworkRecipe(process.argv[1],recipe,{mask:step});
      if(r.execution.maskPixelsGenerated!==0 || r.execution.reusedOperations!==1) throw new Error("unexpected shape work");
      let intercepted=false;
      try {await executeLeafArtworkRecipe(process.argv[1],recipe);}
      catch(e) {if(e.message!=="shape generation forbidden") throw e;intercepted=true;}
      if(!intercepted) throw new Error("shape spy missed full generation");
    `,root,snapshot],{cwd:path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),encoding:"utf8",timeout:30_000});
    assert.equal(child.status,0,child.error?.message??child.stderr);
    assert.deepEqual(normalizeLeafArtworkRecipe(small),small);
  } finally {await rm(root,{recursive:true,force:true});}
});


test("published leaf descriptors reject nested mutation and preserve later build identity",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"leaf-descriptors-"));
  try {
    const first=await executeLeafArtworkRecipe(root,small);
    assert.equal(Reflect.set(LEAF_MASK_OPERATION,"version","999"),false);
    assert.equal(Reflect.set(MASK_COLOR_GRADIENT_OPERATION,"id","other"),false);
    assert.equal(Reflect.set(LEAF_MASK_OPERATION.outputs[0]!,"required",false),false);
    assert.equal(Reflect.set(MASK_COLOR_GRADIENT_OPERATION.parameterSchema,"additionalProperties",true),false);
    assert.deepEqual(await executeLeafArtworkRecipe(root,small),first);
  } finally {await rm(root,{recursive:true,force:true});}
});
