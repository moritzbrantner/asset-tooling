import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAssetRef } from "../src/operations.js";
import { resolveAssetObject, assetObjectPortablePath } from "../src/asset-store.js";
import { parseRgba8Image } from "../src/image-rgba8.js";
import { EFFECT_ARTWORK_PRESETS, normalizeEffectArtworkParameters, createEffectArtworkBuildIdentity, executeEffectArtwork } from "../src/effect-artwork-recipes.js";

const parameters = { shape: "puff", width: 25, height: 21, centerX: 12, centerY: 10, radius: 4, softness: 4, color: [37, 129, 241], opacity: 200 } as const;
function sample(image: ReturnType<typeof parseRgba8Image>, x:number, y:number) { return [...image.pixels.subarray((y*image.width+x)*4, (y*image.width+x)*4+4)]; }

test("effect artwork controls reject unsupported geometry and budgets before writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"effects-controls-"));
  try {
    assert.equal(normalizeEffectArtworkParameters(parameters).shape,"puff");
    assert.ok(Object.isFrozen(EFFECT_ARTWORK_PRESETS.puff.subtle));
    assert.ok(Object.isFrozen(EFFECT_ARTWORK_PRESETS.puff.subtle.color));
    for (const invalid of [ { ...parameters, width:257 }, { ...parameters, width:2 }, { ...parameters, radius:11 }, { ...parameters, softness:0 },
      { ...parameters, centerX:1 }, { ...parameters, color:[-1,0,0] }, { ...parameters, opacity:256 },
      { ...parameters, seed:"1" }, { ...parameters, stroke:1 }, { ...parameters, shape:"ring", stroke:4 },
      { ...parameters, shape:"ring", stroke:0 }, { ...parameters, shape:"spark" } ]) {
      await assert.rejects(executeEffectArtwork(root,{parameters:invalid}));
    }
    await assert.rejects(executeEffectArtwork(root,{parameters,inputs:{ambient:{}}}), /input|port/i);
    await assert.rejects(stat(path.join(root,".asset-tooling")), { code:"ENOENT" });
    await assert.rejects(executeEffectArtwork("relative",{parameters}), /absolute/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("actual non-square puff and ring samples match independent cardinal references", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"effects-pixels-"));
  try {
    const puff = await executeEffectArtwork(root,{parameters});
    const image = parseRgba8Image(await resolveAssetObject(root,createAssetRef(puff.outputs.image)));
    const mask = parseRgba8Image(await resolveAssetObject(root,createAssetRef(puff.outputs.mask)));
    // Independent cardinal distances. At half-softness SDF=192, remapped=129;
    // coverage=126 and round(200*126/255)=99 (two declared UNORM8 quantizations).
    for (const [x,alpha] of [[12,200],[16,200],[18,99],[20,0]] as const) {
      assert.deepEqual(sample(image,x,10),[37,129,241,alpha]);
      assert.deepEqual(sample(mask,x,10),[alpha,alpha,alpha,255]);
    }
    const ringParameters = {...parameters, shape:"ring", radius:6, softness:2, stroke:2};
    const ring = await executeEffectArtwork(root,{parameters:ringParameters});
    const ringImage = parseRgba8Image(await resolveAssetObject(root,createAssetRef(ring.outputs.image)));
    for (const [distance,alpha] of [[0,0],[2,0],[3,99],[4,200],[6,200],[7,99],[8,0]] as const) assert.deepEqual(sample(ringImage,12+distance,10),[37,129,241,alpha]);
    for (const actual of [image,ringImage]) {
      for(let y=0;y<actual.height;y++) for(let x=0;x<actual.width;x++) {
        const [r,g,b,a]=sample(actual,x,y);
        assert.deepEqual([r,g,b],[37,129,241]);
        if(x===0 || y===0 || x===actual.width-1 || y===actual.height-1) assert.equal(a,0);
        assert.deepEqual(sample(actual,x,y),sample(actual,24-x,20-y));
      }
    }
    assert.equal(createAssetRef(puff.outputs.image).metadata.alphaMode,"straight");
    assert.equal(createAssetRef(puff.outputs.mask).metadata.channelColorSpace,"linear");
    assert.notEqual(createAssetRef(puff.outputs.image).sha256,createAssetRef(ring.outputs.image).sha256);
    assert.equal(puff.observations.randomness,"none");
    const recolored=await executeEffectArtwork(root,{parameters:{...parameters,color:[1,2,3]}});
    assert.equal(createAssetRef(recolored.outputs.mask).sha256,createAssetRef(puff.outputs.mask).sha256);
    assert.notEqual(createAssetRef(recolored.outputs.image).sha256,createAssetRef(puff.outputs.image).sha256);
    const softer=await executeEffectArtwork(root,{parameters:{...parameters,softness:6}});
    assert.notEqual(createAssetRef(softer.outputs.mask).sha256,createAssetRef(puff.outputs.mask).sha256);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("effect ingredients replay from a cold store and reconcile unchanged objects", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"effects-replay-"));
  const cold = await mkdtemp(path.join(tmpdir(),"effects-cold-"));
  try {
    for (const shape of ["puff","ring"] as const) for (const intensity of ["subtle","strong","off"] as const) {
      const parameters = EFFECT_ARTWORK_PRESETS[shape][intensity];
      const first = await executeEffectArtwork(root,{parameters});
      const ref = createAssetRef(first.outputs.image), before = await stat(path.join(root,assetObjectPortablePath(ref)));
      assert.deepEqual(await executeEffectArtwork(root,{parameters}),first);
      assert.equal((await stat(path.join(root,assetObjectPortablePath(ref)))).mtimeMs,before.mtimeMs);
      const rebuilt = await executeEffectArtwork(cold,{parameters});
      assert.deepEqual(rebuilt,first);
      assert.deepEqual(await resolveAssetObject(cold,createAssetRef(rebuilt.outputs.image)),await resolveAssetObject(root,ref));
      const pixels = parseRgba8Image(await resolveAssetObject(root,ref)).pixels;
      if(intensity==="off") for(let i=3;i<pixels.length;i+=4) assert.equal(pixels[i],0);
    }
    const maximum=await executeEffectArtwork(root,{parameters:{...parameters,width:256,height:256,centerX:128,centerY:128,radius:62,softness:64}});
    const maximumImage=parseRgba8Image(await resolveAssetObject(root,createAssetRef(maximum.outputs.image)));
    assert.equal(maximumImage.pixels.byteLength,256*256*4);
    assert.equal(sample(maximumImage,255,128)[3],0);
    const first = await createEffectArtworkBuildIdentity(root,{parameters});
    const paletteEdit = await createEffectArtworkBuildIdentity(root,{parameters:{...parameters,color:[1,2,3]}});
    assert.notDeepEqual(first,paletteEdit);
  } finally { await rm(root,{recursive:true,force:true}); await rm(cold,{recursive:true,force:true}); }
});
