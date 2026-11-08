// #516 step 4: the Ranger's non-Blender operations reuse results across throwaway object stores through the shared
// cache directory (docs/cache.md#operation-result-entries), and Blender gets geometry without textures.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { Document, NodeIO } from "@gltf-transform/core";
import { resolveAssetObject, runAssetOperation, storeAssetObject } from "../src/asset-store.js";
import { pruneGenerationCache } from "../src/cache.js";
import { withoutTextures } from "../src/gltf-without-textures.js";
import { executeGltfTextureResizeOperation } from "../src/gltf-texture-resize-operations.js";
import { createAssetOperationDescriptor, type AssetOperationResult, type AssetRef } from "../src/operations.js";
import { cachedTextureResize, operationCacheSources, operationCacheStatistics } from "../scripts/cached-operations.ts";
import { GENERATION_CACHE_DIRECTORY_ENV } from "../scripts/generation-cache.ts";

const DESCRIPTOR = createAssetOperationDescriptor({
  schemaVersion: 1, id: "test.shout", version: "1", label: "Shout", category: "test", description: "Upper-case text with a suffix.",
  inputs: [{ id: "source", assetKinds: ["text"], mediaTypes: ["text/plain"] }],
  outputs: [{ id: "output", assetKinds: ["text"], mediaTypes: ["text/plain"] }],
  parameterSchema: { type: "object", additionalProperties: false, properties: { suffix: { type: "string" } } },
});

function shout() {
  const calls: string[] = [];
  return {
    calls,
    registration: {
      descriptor: DESCRIPTOR, implementation: { id: "shout", version: "1" },
      async execute(root: string, { parameters, inputs }: { parameters: any; inputs: any }): Promise<AssetOperationResult> {
        calls.push(root);
        const text = (await resolveAssetObject(root, inputs.source)).toString("utf8").toUpperCase() + parameters.suffix;
        const output = (await storeAssetObject(root, { bytes: Buffer.from(text), kind: "text", mediaType: "text/plain" })).asset;
        return { outputs: { output }, observations: { length: text.length } };
      },
    },
  };
}

const temporary = (name: string) => mkdtemp(path.join(os.tmpdir(), `asset-tooling-${name}-`));
const text = async (root: string, value: string) => (await storeAssetObject(root, { bytes: Buffer.from(value), kind: "text", mediaType: "text/plain" })).asset;
const output = (result: AssetOperationResult) => result.outputs.output as AssetRef;

test("a shared cache directory reuses a result in a fresh object store and misses on other inputs or parameters", async () => {
  const cache = await temporary("op-cache"), first = await temporary("op-a"), second = await temporary("op-b");
  try {
    const { calls, registration } = shout();
    const miss = await runAssetOperation(first, registration, { parameters: { suffix: "!" }, inputs: { source: await text(first, "hi") } }, { cacheDirectory: cache });
    assert.equal(miss.status, "miss");
    assert.deepEqual(await readdir(path.join(cache, "v1/blobs")), [output(miss.result).sha256], "the output object is a blob");
    assert.equal((await readdir(path.join(cache, "v1/operations"))).length, 1);

    const hit = await runAssetOperation(second, registration, { parameters: { suffix: "!" }, inputs: { source: await text(second, "hi") } }, { cacheDirectory: cache });
    assert.equal(hit.status, "hit");
    assert.deepEqual(calls, [first], "a hit never executes");
    assert.deepEqual(hit.result, miss.result);
    assert.equal((await resolveAssetObject(second, output(hit.result))).toString("utf8"), "HI!", "the output is restored into the fresh store");
    assert.deepEqual(await readdir(second), [".asset-tooling"]);
    assert.ok(!(await readdir(path.join(second, ".asset-tooling"))).includes("cache"), "the entry stays in the shared directory");

    assert.equal((await runAssetOperation(second, registration, { parameters: { suffix: "?" }, inputs: { source: await text(second, "hi") } }, { cacheDirectory: cache })).status, "miss");
    assert.equal((await runAssetOperation(second, registration, { parameters: { suffix: "!" }, inputs: { source: await text(second, "ho") } }, { cacheDirectory: cache })).status, "miss");
    assert.equal(calls.length, 3);
    await assert.rejects(async () => runAssetOperation(second, registration, {}, { cacheDirectory: "relative" }), /absolute/);
  } finally {
    for (const directory of [cache, first, second]) await rm(directory, { recursive: true, force: true });
  }
});

test("a tampered blob or entry in the shared directory is rejected, not reused or re-executed", async () => {
  const cache = await temporary("op-cache"), first = await temporary("op-a");
  try {
    const { calls, registration } = shout();
    const invocation = async (root: string) => ({ parameters: { suffix: "!" }, inputs: { source: await text(root, "hi") } });
    const miss = await runAssetOperation(first, registration, await invocation(first), { cacheDirectory: cache });
    const blob = path.join(cache, "v1/blobs", output(miss.result).sha256);
    // A new file, not an in-place write: the blob may be a hard link of the first store's object.
    await rm(blob);
    await writeFile(blob, "HO!");
    const fresh = await temporary("op-b");
    try {
      await assert.rejects(async () => runAssetOperation(fresh, registration, await invocation(fresh), { cacheDirectory: cache }), /unusable.*does not match/);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
    await rm(blob);
    const other = await temporary("op-c");
    try {
      await assert.rejects(async () => runAssetOperation(other, registration, await invocation(other), { cacheDirectory: cache }), /unusable.*missing/);
      const [entryName] = await readdir(path.join(cache, "v1/operations"));
      const entryPath = path.join(cache, "v1/operations", entryName!);
      const entry = JSON.parse(await readFile(entryPath, "utf8"));
      entry.result.observations.length = 99;
      await writeFile(entryPath, JSON.stringify(entry));
      await assert.rejects(async () => runAssetOperation(other, registration, await invocation(other), { cacheDirectory: cache }), /unusable.*result hash mismatch/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    assert.equal(calls.length, 1);
  } finally {
    for (const directory of [cache, first]) await rm(directory, { recursive: true, force: true });
  }
});

test("pruning keeps the operation entries a build used and their blobs", async () => {
  const cache = await temporary("op-cache"), root = await temporary("op-a");
  try {
    const { registration } = shout();
    const old = await runAssetOperation(root, registration, { parameters: { suffix: "1" }, inputs: { source: await text(root, "a") } }, { cacheDirectory: cache });
    const operations = path.join(cache, "v1/operations");
    const past = new Date(Date.now() - 60_000);
    for (const name of await readdir(operations)) await utimes(path.join(operations, name), past, past);
    const since = new Date(Date.now() - 1000);
    const used = await runAssetOperation(root, registration, { parameters: { suffix: "2" }, inputs: { source: await text(root, "a") } }, { cacheDirectory: cache });
    const result = await pruneGenerationCache(cache, since);
    assert.equal(result.keptOperations, 1);
    assert.equal(result.removedOperations, 1);
    assert.deepEqual(await readdir(path.join(cache, "v1/blobs")), [output(used.result).sha256]);
    assert.notEqual(output(old.result).sha256, output(used.result).sha256);
  } finally {
    for (const directory of [cache, root]) await rm(directory, { recursive: true, force: true });
  }
});

test("a cached operation's key is its module's source closure, not all of src/**", () => {
  const sources = operationCacheSources("src/gltf-texture-resize-operations.ts");
  for (const file of ["src/gltf-texture-resize-operations.ts", "src/image-codec-operations.ts", "src/gltf-processing.ts"]) assert.ok(sources.includes(file), file);
  for (const file of ["src/catalog-storage.ts", "src/blender-script-backend.ts", "src/asset-bundle.ts"]) assert.ok(!sources.includes(file), `${file} is not in the closure`);
});

async function texturedGlb(textures: number) {
  const document = new Document();
  const buffer = document.createBuffer();
  const material = document.createMaterial("m").setBaseColorFactor([0.5, 0.4, 0.3, 1]);
  // A 32x32 opaque PNG from the encoder below, embedded `textures` times under different names.
  const png = await solidPng(32, 32);
  for (let index = 0; index < textures; index += 1) {
    const texture = document.createTexture(`t${index}`).setMimeType("image/png").setImage(png);
    if (index === 0) material.setBaseColorTexture(texture);
  }
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer))
    .setMaterial(material);
  document.createScene("Scene").addChild(document.createNode("n").setMesh(document.createMesh("n").addPrimitive(primitive)));
  return new NodeIO().writeBinary(document);
}

/** A tiny valid PNG (zlib-stored IDAT) of one colour, built without FFmpeg. */
async function solidPng(width: number, height: number) {
  const { deflateSync, crc32 } = await import("node:zlib");
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 200)])));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}

test("withoutTextures drops textures and images and keeps geometry and material factors", async () => {
  const bytes = await texturedGlb(2);
  const stripped = await new NodeIO().readBinary(await withoutTextures(bytes));
  assert.equal(stripped.getRoot().listTextures().length, 0);
  assert.equal(stripped.getRoot().listMeshes().length, 1);
  assert.deepEqual(stripped.getRoot().listMaterials()[0]!.getBaseColorFactor(), [0.5, 0.4, 0.3, 1]);
  assert.equal(stripped.getRoot().listMaterials()[0]!.getBaseColorTexture(), null);
  const plain = await withoutTextures(await new NodeIO().writeBinary(stripped));
  assert.deepEqual(await withoutTextures(plain), plain, "a GLB without textures is returned unchanged");
});

const codecAvailable = ["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"], { timeout: 30_000 }).status === 0);

test("the cached texture resize is a hit in a fresh store and matches the direct operation", { skip: !codecAvailable }, async () => {
  const cache = await temporary("op-cache"), first = await temporary("op-a"), second = await temporary("op-b");
  const previous = process.env[GENERATION_CACHE_DIRECTORY_ENV];
  process.env[GENERATION_CACHE_DIRECTORY_ENV] = cache;
  try {
    const parameters = { maxEdgeBySlot: { baseColor: 8 }, default: 8, policy: { allowedValidatorWarnings: [] } };
    const glb = await texturedGlb(1);
    const source = async (root: string) => (await storeAssetObject(root, { bytes: glb, kind: "scene", mediaType: "model/gltf-binary" })).asset;
    const before = operationCacheStatistics();
    const cold = await cachedTextureResize(first, { inputs: { source: await source(first) }, parameters });
    const warm = await cachedTextureResize(second, { inputs: { source: await source(second) }, parameters });
    const after = operationCacheStatistics();
    assert.deepEqual([after.misses - before.misses, after.hits - before.hits], [1, 1]);
    assert.deepEqual(warm, cold);
    delete process.env[GENERATION_CACHE_DIRECTORY_ENV];
    const direct = await executeGltfTextureResizeOperation(second, { inputs: { source: await source(second) }, parameters });
    assert.equal(output(direct).sha256, output(cold).sha256, "the cache returns what the operation produces");
    process.env[GENERATION_CACHE_DIRECTORY_ENV] = cache;
    await cachedTextureResize(second, { inputs: { source: await source(second) }, parameters: { ...parameters, default: 4, maxEdgeBySlot: { baseColor: 4 } } });
    assert.equal(operationCacheStatistics().misses - after.misses, 1, "other parameters miss");
  } finally {
    if (previous === undefined) delete process.env[GENERATION_CACHE_DIRECTORY_ENV];
    else process.env[GENERATION_CACHE_DIRECTORY_ENV] = previous;
    for (const directory of [cache, first, second]) await rm(directory, { recursive: true, force: true });
  }
});
