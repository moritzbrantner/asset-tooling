import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject, assetObjectPortablePath } from "../src/asset-store.js";
import { createAssetRef } from "../src/operations.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import {
  executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS, SURFACE_HEIGHT_OPERATION, SCALAR_COLOR_RAMP_OPERATION,
  executeScalarColorRampOperation, executeSurfaceHeightOperation,
  createScalarColorRampOperationBuildIdentity,
} from "../src/surface-texture-recipes.js";

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "surface-texture-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function image(root: string, asset: unknown) {
  assert.ok(asset);
  return parseRgba8Image(await resolveAssetObject(root, createAssetRef(asset))); }

test("scalar ramp uses independent endpoint/interior reference and preserves opaque alpha", () => withRoot(async root => {
  const source = (await storeAssetObject(root, {
    kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    bytes: encodeRgba8Image({ width: 3, height: 1, pixels: Buffer.from([0,0,0,255, 128,128,128,255, 255,255,255,255]) }),
  })).asset;
  const invocation = { inputs: { source }, parameters: { low: [10,20,30], high: [110,220,230] } };
  const result = await executeScalarColorRampOperation(root, invocation);
  assert.deepEqual((await image(root, result.outputs.output)).pixels,
    Buffer.from([10,20,30,255, 60,120,130,255, 110,220,230,255]));
  await writeFile(path.join(root, assetObjectPortablePath(source)), 'corrupt');
  await assert.rejects(() => createScalarColorRampOperationBuildIdentity(root, invocation), /mismatch/);
}));

test("height composes the existing periodic fixture with a zero-detail weight", () => withRoot(async root => {
  const result = await executeSurfaceHeightOperation(root, { parameters: {
    seed: "42", width: 4, height: 2, gridX: 2, gridY: 1,
    detailGridX: 4, detailGridY: 2, detailWeight: 0, heightMin: 0, heightMax: 255,
  } });
  assert.deepEqual((await image(root, result.outputs.output)).pixels,
    Buffer.from([50,64,78,64,50,64,78,64].flatMap(v => [v,v,v,255])));
}));

test("surface channels replay across cold stores and recolor leaves height/normal/roughness identities stable", () => withRoot(async root => {
  const preset = SURFACE_TEXTURE_PRESETS['soil-fine'];
  const recipe = { ...preset, width: 17, height: 13, gridX: 4, gridY: 3, detailGridX: 12, detailGridY: 10 };
  const first = await executeSurfaceTextureRecipe(root, recipe);
  const second = await executeSurfaceTextureRecipe(root, recipe);
  assert.deepEqual(second, first);
  await withRoot(async coldRoot => assert.deepEqual(await executeSurfaceTextureRecipe(coldRoot, recipe), first));
  const recolored = await executeSurfaceTextureRecipe(root, { ...recipe, low: [20,30,40], high: [170,180,190] });
  for (const channel of ['height', 'normal', 'roughness'] as const) assert.deepEqual(recolored.outputs[channel], first.outputs[channel]);
  assert.notEqual(recolored.outputs.color!.sha256, first.outputs.color!.sha256);
  const normalChanged = await executeSurfaceTextureRecipe(root, { ...recipe, normalStrength: 12 });
  assert.notEqual(normalChanged.outputs.normal!.sha256, first.outputs.normal!.sha256);
  assert.equal(normalChanged.outputs.height!.sha256, first.outputs.height!.sha256);
  for (const channel of ['color', 'height', 'roughness', 'normal'] as const) {
    const pixels = (await image(root, first.outputs[channel])).pixels;
    for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 255);
  }
  assert.equal(first.conventions.color, 'srgb');
  assert.equal(first.outputs.roughness?.metadata.sampling, 'data');
  assert.equal(first.outputs.roughness?.metadata.channelColorSpace, 'linear');
  assert.equal(first.outputs.roughness?.metadata.scalarEncoding, 'unorm8');
  assert.equal(first.outputs.normal?.metadata.normalYAxis, 'negative');
  assert.equal(first.conventions.normal.yAxis, 'negative');
  assert.equal(first.steps.filter(step => step.operation.id === 'image.normal.from-height').length, 1);
}));

test("selected channels avoid unrelated stages; tiny/odd images stay valid", () => withRoot(async root => {
  for (const [width,height] of [[1,1], [3,5]] as const) {
    const result = await executeSurfaceTextureRecipe(root, {
      ...SURFACE_TEXTURE_PRESETS['rock-smooth'], width, height,
      gridX: 1, gridY: 1, detailGridX: 1, detailGridY: 1,
    }, { channels: ['height'] });
    assert.deepEqual(Object.keys(result.outputs), ['height']);
    assert.equal(result.steps.length, 1);
    assert.equal((await image(root, result.outputs.height)).pixels.length, width*height*4);
  }
  for (const change of [{ width: 0 }, { detailWeight: 256 }, { heightMin: 250, heightMax: 10 }, { gridX: 999 }, { low: [0,NaN,0] }, { seamMode: 'clamp' }, { unexpected: true }]) {
    await assert.rejects(() => executeSurfaceTextureRecipe(root, { ...SURFACE_TEXTURE_PRESETS['soil-fine'], ...change }));
  }
  // @ts-expect-error Deliberately exercise invalid untrusted channel input.
  await assert.rejects(() => executeSurfaceTextureRecipe(root, SURFACE_TEXTURE_PRESETS['soil-fine'], { channels: ['bogus'] }));
}));

test("wrapped normals agree with an independently repeated 3x3 height tile including seams", () => withRoot(async root => {
  const { executeNormalFromHeightOperation } = await import('../src/procedural-texture-operations.js');
  const recipe = { ...SURFACE_TEXTURE_PRESETS['soil-fine'], width: 7, height: 5, gridX: 2, gridY: 2, detailGridX: 5, detailGridY: 4 };
  const result = await executeSurfaceTextureRecipe(root, recipe, { channels: ['normal','height'] });
  const height = await image(root,result.outputs.height);
  assert.notEqual(height.pixels[0],height.pixels[(height.width-1)*4], 'periodic sampling does not duplicate endpoint texels');
  const width = height.width*3, repeatHeight = height.height*3, pixels = Buffer.alloc(width*repeatHeight*4);
  for (let y=0;y<repeatHeight;y++) for (let x=0;x<width;x++) {
    const from=((y%height.height)*height.width+x%height.width)*4;
    height.pixels.copy(pixels,(y*width+x)*4,from,from+4);
  }
  const source = (await storeAssetObject(root,{ kind:'image', mediaType:RGBA8_IMAGE_MEDIA_TYPE, bytes:encodeRgba8Image({ width,height:repeatHeight,pixels }) })).asset;
  const reference = await executeNormalFromHeightOperation(root,{ inputs:{source}, parameters:{strength:recipe.normalStrength,wrap:false} });
  const repeatedNormal = await image(root,reference.outputs.output), normal = await image(root,result.outputs.normal);
  for (let y=0;y<height.height;y++) for (let x=0;x<height.width;x++) {
    const from=((y+height.height)*width+x+height.width)*4, to=(y*height.width+x)*4;
    assert.deepEqual(normal.pixels.subarray(to,to+4),repeatedNormal.pixels.subarray(from,from+4));
  }
}));

test("scalar operations reject colored and transparent sources and unknown inputs", () => withRoot(async root => {
  for (const pixels of [Buffer.from([0,1,0,255]),Buffer.from([0,0,0,0])]) {
    const source=(await storeAssetObject(root,{kind:'image',mediaType:RGBA8_IMAGE_MEDIA_TYPE,bytes:encodeRgba8Image({width:1,height:1,pixels})})).asset;
    await assert.rejects(()=>executeScalarColorRampOperation(root,{inputs:{source},parameters:{low:[0,0,0],high:[255,255,255]}}),/opaque grayscale/);
  }
  await assert.rejects(()=>executeSurfaceHeightOperation(root,{parameters:SURFACE_TEXTURE_PRESETS['soil-fine'],inputs:{unexpected:{}}}));
}));

test("constant height and roughness ranges have analytic pixel meaning", () => withRoot(async root => {
  const result=await executeSurfaceTextureRecipe(root,{
    ...SURFACE_TEXTURE_PRESETS['soil-fine'],width:1,height:1,gridX:1,gridY:1,detailGridX:1,detailGridY:1,
    heightMin:128,heightMax:128,roughnessMin:211,roughnessMax:211,
  });
  assert.deepEqual((await image(root,result.outputs.height)).pixels,Buffer.from([128,128,128,255]));
  assert.deepEqual((await image(root,result.outputs.roughness)).pixels,Buffer.from([211,211,211,255]));
  assert.deepEqual((await image(root,result.outputs.normal)).pixels,Buffer.from([128,128,255,255]));
}));

test("nonzero mixture and range remapping match pinned component bytes and rational reference", () => withRoot(async root => {
  // Existing coarse fixture: [50,64,78,64]; seed 43's one-cell field is constant 53.
  // Weight 128/255 gives [52,58,65,58]; mapping 0..255 to 20..200 gives [57,61,66,61].
  const result = await executeSurfaceHeightOperation(root,{ parameters: {
    seed:'42',width:4,height:2,gridX:2,gridY:1,detailGridX:1,detailGridY:1,
    detailWeight:128,heightMin:20,heightMax:200,
  } });
  assert.deepEqual((await image(root,result.outputs.output)).pixels,
    Buffer.from([57,61,66,61,57,61,66,61].flatMap(v=>[v,v,v,255])));
  assert.equal((result.observations.components as unknown[]).length,2);
}));


test("public descriptors and nested presets cannot alter later recipe identity", () => withRoot(async root => {
  const before = await executeSurfaceTextureRecipe(root,SURFACE_TEXTURE_PRESETS['soil-fine'],{channels:['height']});
  assert.equal(Reflect.set(SURFACE_HEIGHT_OPERATION,'version','999'),false);
  assert.equal(Reflect.set(SCALAR_COLOR_RAMP_OPERATION.outputs[0]!,'required',false),false);
  assert.equal(Reflect.set(SURFACE_TEXTURE_PRESETS['soil-fine'].low,'0',255),false);
  assert.equal(Reflect.set(SURFACE_TEXTURE_PRESETS['soil-fine'],'seed','99'),false);
  assert.deepEqual(await executeSurfaceTextureRecipe(root,SURFACE_TEXTURE_PRESETS['soil-fine'],{channels:['height']}),before);
}));
