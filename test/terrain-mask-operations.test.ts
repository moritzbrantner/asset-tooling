import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { createAssetRef } from "../src/operations.js";
import { createHeightMaskFlattenOperationBuildIdentity, executeHeightMaskFlattenOperation } from "../src/terrain-mask-operations.js";

async function workspace(t: TestContext, prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function image(root: string, values: number[], width = 3, alpha = false) {
  return (await storeAssetObject(root, { kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE, metadata: {},
    bytes: encodeRgba8Image({ width, height: values.length / width,
      pixels: Buffer.from(values.flatMap(v => alpha ? [17, 31, 73, v] : [v, v, v, 255])) }) })).asset;
}

test("saved scalar and alpha masks flatten exact samples with independent Q8 blend references", async t => {
  const root = await workspace(t, "height-mask-");
  const original = [0, 100, 255, 25, 75, 200];
  const source = await image(root, original);
  const sourceBytes = await resolveAssetObject(root, source);
  for (const channel of ["scalar", "alpha"] as const) {
    const mask = await image(root, [0, 255, 128, 255, 0, 64], 3, channel === "alpha");
    const invocation = { parameters: { targetHeight: 50, channel }, inputs: { source, mask } };
    const build = await createHeightMaskFlattenOperationBuildIdentity(root, invocation);
    assert.equal(createAssetRef(build.inputs.source).sha256, source.sha256);
    assert.equal(createAssetRef(build.inputs.mask).sha256, mask.sha256);
    const first = await executeHeightMaskFlattenOperation(root, invocation);
    const output = createAssetRef(first.outputs.output);
    const parsed = parseRgba8Image(await resolveAssetObject(root, output));
    // round(((255-weight)*source + weight*50)/255), independently calculated.
    assert.deepEqual([...parsed.pixels.filter((_, i) => i % 4 === 0)], [0, 50, 152, 50, 75, 162]);
    assert.equal(output.metadata.sourceSha256, source.sha256);
    assert.equal(output.metadata.maskSha256, mask.sha256);
    assert.deepEqual(first.observations.maskSamples, { zero: 2, full: 2, partial: 2, changed: 4 });
    const outputPath = path.join(root, assetObjectPortablePath(output));
    const before = await stat(outputPath);
    const second = await executeHeightMaskFlattenOperation(root, invocation);
    assert.deepEqual(first, second);
    assert.equal((await stat(outputPath)).mtimeMs, before.mtimeMs);
    const cold = await workspace(t, "height-mask-cold-");
    await storeAssetObject(cold, { bytes: sourceBytes, kind: source.kind, mediaType: source.mediaType, metadata: source.metadata });
    await storeAssetObject(cold, { bytes: await resolveAssetObject(root, mask), kind: mask.kind, mediaType: mask.mediaType, metadata: mask.metadata });
    const replay = await executeHeightMaskFlattenOperation(cold, invocation);
    assert.deepEqual(await resolveAssetObject(cold, createAssetRef(replay.outputs.output)), await resolveAssetObject(root, output));
  }
  assert.deepEqual(await resolveAssetObject(root, source), sourceBytes);
});

test("zero/full and marked-pixel masks preserve exact endpoints on odd non-square grids", async t => {
  const root = await workspace(t, "height-mask-endpoints-");
  const source = await image(root, [0, 17, 255, 71, 84, 123]);
  for (const targetHeight of [0, 255]) {
    for (const weight of [0, 255]) {
      const mask = await image(root, Array(6).fill(weight));
      const output = await executeHeightMaskFlattenOperation(root, { parameters: { targetHeight, channel: "scalar" }, inputs: { source, mask } });
      const pixels = parseRgba8Image(await resolveAssetObject(root, createAssetRef(output.outputs.output))).pixels;
      assert.deepEqual([...pixels.filter((_, i) => i % 4 === 0)], weight === 0 ? [0, 17, 255, 71, 84, 123] : Array(6).fill(targetHeight));
      if (weight === 0) assert.equal(createAssetRef(output.outputs.output).sha256, source.sha256);
    }
  }
  const mask = await image(root, [0, 0, 0, 0, 0, 255]);
  const output = await executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source, mask } });
  assert.deepEqual([...parseRgba8Image(await resolveAssetObject(root, createAssetRef(output.outputs.output))).pixels.filter((_, i) => i % 4 === 0)], [0, 17, 255, 71, 84, 10]);
});

test("mask edits fail closed before storing outputs on invalid controls, coverage or content", async t => {
  const root = await workspace(t, "height-mask-invalid-");
  const source = await image(root, [0, 100, 255]);
  const mask = await image(root, [0, 255, 128]);
  const snapshot = async () => (await readdir(path.join(root, ".asset-tooling/objects"), { recursive: true })).sort();
  const before = await snapshot();
  for (const relativeRoot of ["", ".", "relative-store"]) {
    await assert.rejects(executeHeightMaskFlattenOperation(relativeRoot, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source, mask } }), /absolute path/);
    await assert.rejects(createHeightMaskFlattenOperationBuildIdentity(relativeRoot), /absolute path/);
  }
  for (const parameters of [{ targetHeight: -1, channel: "scalar" }, { targetHeight: 256, channel: "scalar" }, { targetHeight: NaN, channel: "scalar" },
    { targetHeight: 1.5, channel: "scalar" }, { targetHeight: 10, channel: "red" }, { targetHeight: 10, channel: "scalar", stretch: true }, { targetHeight: 10 }]) {
    await assert.rejects(executeHeightMaskFlattenOperation(root, { parameters, inputs: { source, mask } }));
  }
  assert.deepEqual(await snapshot(), before);
  const mismatch = await image(root, [0, 255], 2);
  await assert.rejects(executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 10, channel: "alpha" }, inputs: { source, mask: mismatch } }), /dimensions/);
  const colored = (await storeAssetObject(root, { kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE, metadata: {},
    bytes: encodeRgba8Image({ width: 3, height: 1, pixels: Buffer.from([0, 1, 0, 255, 1, 1, 1, 254, 1, 1, 1, 255]) }) })).asset;
  await assert.rejects(executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source: colored, mask } }), /opaque grayscale/);
  await assert.rejects(executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source, mask: colored } }), /opaque grayscale/);
  const oversized = await image(root, Array(257).fill(0), 257);
  await assert.rejects(executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source: oversized, mask: oversized } }), /dimensions/);
  const longBytes = Buffer.concat([await resolveAssetObject(root, source), Buffer.alloc(512 * 1024, 32)]);
  const tooLong = (await storeAssetObject(root, { bytes: longBytes, kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE })).asset;
  const beforeBudget = await snapshot();
  await assert.rejects(executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source: tooLong, mask } }), /512 KiB/);
  await assert.rejects(createHeightMaskFlattenOperationBuildIdentity(root, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source, mask: { ...mask, byteLength: 1 } } }), /mismatch/);
  assert.deepEqual(await snapshot(), beforeBudget);
  const maskPath = path.join(root, assetObjectPortablePath(mask));
  const bytes = await readFile(maskPath);
  await writeFile(maskPath, Buffer.alloc(bytes.length));
  const corruptBefore = await snapshot();
  await assert.rejects(executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 10, channel: "scalar" }, inputs: { source, mask } }), /hash|sha256/);
  assert.deepEqual(await snapshot(), corruptBefore);
});

test("maximum supported grid retains every unmasked byte and blends the final sample", async t => {
  const root = await workspace(t, "height-mask-max-grid-");
  const values = Array.from({ length: 256 * 256 }, (_, i) => i % 256);
  const source = await image(root, values, 256);
  const weights = Array(256 * 256).fill(0);
  weights[weights.length - 1] = 128;
  const mask = await image(root, weights, 256);
  const result = await executeHeightMaskFlattenOperation(root, { parameters: { targetHeight: 0, channel: "scalar" }, inputs: { source, mask } });
  const output = parseRgba8Image(await resolveAssetObject(root, createAssetRef(result.outputs.output)));
  const original = parseRgba8Image(await resolveAssetObject(root, source));
  assert.deepEqual(output.pixels.subarray(0, -4), original.pixels.subarray(0, -4));
  assert.deepEqual([...output.pixels.subarray(-4)], [127, 127, 127, 255]);
  assert.deepEqual(result.observations.maskSamples, { zero: 65535, full: 0, partial: 1, changed: 1 });
});
