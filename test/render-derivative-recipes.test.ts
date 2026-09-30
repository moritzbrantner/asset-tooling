import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { generateAsset, verifyAsset } from "../src/core.js";
import { canonicalJson } from "../src/canonical.js";
import { normalizeRenderDerivativeParameters, prepareRenderDerivativeRecipe, readRenderDerivativeRecipeSource, RENDER_DERIVATIVE_PRESETS } from "../src/render-derivative-recipes.js";

const renderer = await readRenderDerivativeRecipeSource();
const configured = Boolean(process.env.ASSET_TOOLING_BLENDER);
const front = { ...RENDER_DERIVATIVE_PRESETS.icon, width: 81, height: 49, viewDirection: [0, 0, 1], padding: 0.1,
  selection: { type: "nodes", names: ["plane"] }, samples: 8 };

// Independently authored GLB: one 2x1 quad and a distant duplicate. No production writer oracle.
function quadGlb(change: Record<string, unknown> = {}, images: Buffer[] = []) {
  const binary = Buffer.alloc(108);
  [-1, -.5, 0, 1, -.5, 0, 1, .5, 0, -1, .5, 0, ...Array.from({ length: 4 }, () => [0, 0, 1]).flat()]
    .forEach((value, i) => binary.writeFloatLE(value, i * 4));
  [0, 1, 2, 0, 2, 3].forEach((value, i) => binary.writeUInt16LE(value, 96 + i * 2));
  const imageViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const chunks = [binary];
  let offset = binary.length;
  for (const bytes of images) {
    imageViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4);
    chunks.push(bytes, padding); offset += bytes.length + padding.length;
  }
  const payload = Buffer.concat(chunks);
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: "plane", mesh: 0, translation: [2, 3, 4] }, { name: "other", mesh: 0, translation: [10, 3, 4] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.25, .5, .75, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    buffers: [{ byteLength: payload.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 12 }, ...imageViews],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-1, -.5, 0], max: [1, .5, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" }, { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" }],
    ...(images.length ? { images: images.map((_, i) => ({ bufferView: 3 + i, mimeType: "image/png" })),
      textures: images.map((_, source) => ({ source })) } : {}), ...change };
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + payload.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(payload.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, payload]);
}
async function workspace(t: TestContext, bytes = quadGlb()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = (await storeAssetObject(root, { bytes, kind: "scene", mediaType: "model/gltf-binary" })).asset;
  return { root, source };
}
async function prepare(t: TestContext, parameters: unknown = front, bytes = quadGlb()) {
  const { root, source } = await workspace(t, bytes);
  const prepared = await prepareRenderDerivativeRecipe(root, { assetId: "test.render", source, parameters, ...{ scriptSha256: renderer.sha256, blenderVersion: renderer.blenderVersion } });
  await writeFile(path.join(root, "render_static_glb.py"), renderer.bytes);
  await writeFile(path.join(root, "source.glb"), prepared.sourceBytes);
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, canonicalJson(prepared.spec));
  return { root, source, prepared, specPath };
}

// Independent valid, highly compressible RGBA PNGs. No production image encoder/Blender oracle.
function png(width: number, height: number, firstRed = 0) {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4);
    header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, tail]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height); raw[1] = firstRed;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("render preflight bounds each embedded texture and total decoded pixels before Blender", async t => {
  for (const images of [[png(8192, 1)], [png(4096, 2049), png(4096, 2049, 17)]]) {
    const bytes = quadGlb({}, images);
    const { root, source } = await workspace(t, bytes);
    assert.ok(source.byteLength < 1024 * 1024, "compressed transport is small despite excessive decoded dimensions");
    await assert.rejects(prepareRenderDerivativeRecipe(root, { assetId: "test.texture-budget", source, parameters: front,
      scriptSha256: renderer.sha256, blenderVersion: renderer.blenderVersion }), /texture.*budget/);
    assert.deepEqual(await resolveAssetObject(root, source), bytes);
  }
  const { root, source } = await workspace(t, quadGlb({}, [png(4096, 4096)]));
  const prepared = await prepareRenderDerivativeRecipe(root, { assetId: "test.texture-budget-boundary", source,
    parameters: front, scriptSha256: renderer.sha256, blenderVersion: renderer.blenderVersion });
  assert.equal(prepared.sourceSummary.textureCount, 1);
  assert.deepEqual(prepared.sourceBytes, await resolveAssetObject(root, source));
});

test("render recipe pins validated source/script bytes and rejects incompatible camera/selection/budgets", async t => {
  const { source, prepared } = await prepare(t);
  assert.equal(prepared.spec.inputs.source.sha256, source.sha256);
  assert.equal(prepared.spec.inputs.script.sha256, renderer.sha256);
  assert.equal(prepared.spec.reproducibility.expected, "approximate");
  assert.deepEqual(prepared.sourceSummary, { nodeCount: 2, meshCount: 1, materialCount: 1, textureCount: 0, vertexCount: 4, triangleCount: 2 });
  for (const change of [{ width: 0 }, { height: 1025 }, { samples: 65 }, { seed: -1 }, { padding: .5 },
    { projection: { type: "orthographic", horizontalFovDegrees: 40 } }, { projection: { type: "perspective", horizontalFovDegrees: 0 } },
    { viewDirection: [0, 1, 0] }, { viewDirection: [0, 0, 0] }, { lightDirection: [0, 0, 0] }, { worldColor: [1, 2, 3] }, { frame: 0 }]) {
    assert.throws(() => normalizeRenderDerivativeParameters({ ...front, ...change }));
  }
  assert.equal(Reflect.set(RENDER_DERIVATIVE_PRESETS.icon.viewDirection, 0, 99), false);
});

test("render preflight rejects missing nodes, extensions, external resources and tampered objects", async t => {
  const { root, source } = await workspace(t);
  const request = { assetId: "test.render", source, parameters: { ...front, selection: { type: "nodes", names: ["missing"] } }, scriptSha256: renderer.sha256, blenderVersion: renderer.blenderVersion };
  await assert.rejects(prepareRenderDerivativeRecipe(root, request), /selected node/);
  for (const document of [{ extensionsUsed: ["KHR_materials_unlit"] }, { buffers: [{ uri: "missing.bin", byteLength: 108 }] }]) {
    const invalid = await workspace(t, quadGlb(document));
    await assert.rejects(prepareRenderDerivativeRecipe(invalid.root, { ...request, source: invalid.source, parameters: front }));
  }
  await assert.rejects(prepareRenderDerivativeRecipe(root, { ...request, source: { ...source, sha256: "0".repeat(64) }, parameters: front }));
});

test("node selection retains original multibyte names despite importer truncation and collisions", {
  skip: !configured && "ASSET_TOOLING_BLENDER is not set", timeout: 120_000,
}, async t => {
  const prefix = "树".repeat(128), name = `${prefix}-selected`;
  const bytes = quadGlb({ nodes: [{ name: `${prefix}-other`, mesh: 0, translation: [2, 3, 4] },
    { name, mesh: 0, translation: [10, 3, 4] }] });
  const { source, specPath } = await prepare(t, { ...front, selection: { type: "nodes", names: [name] } }, bytes);
  const generated = await generateAsset(specPath);
  assert.equal(generated.receipt.inputs.source.sha256, source.sha256);
  const observed = generated.receipt.observations.script;
  assert.equal(observed.meshCount, 1);
  assert.deepEqual(observed.sourceBoundsBlenderZUp, { min: [9, -4, 2.5], max: [11, -4, 3.5] });
});

for (const projection of [{ type: "orthographic" }, { type: "perspective", horizontalFovDegrees: 40 }] as const) {
  test(`actual ${projection.type} PNG retains odd-size alpha framing, pivot and selected-only source lineage`, {
    skip: !configured && "ASSET_TOOLING_BLENDER is not set", timeout: 120_000,
  }, async t => {
    const { root, source, prepared, specPath } = await prepare(t, { ...front, projection });
    const first = await generateAsset(specPath);
    const observed = first.receipt.observations.script;
    assert.equal(observed.meshCount, 1); assert.equal(observed.materialCount, 1);
    assert.deepEqual(observed.pivot, { x: 40.5, y: 24.5 });
    assert.equal(first.receipt.inputs.source.sha256, source.sha256);
    const bounds = observed.projectedBounds;
    // Independent front-on 2x1 rectangle: horizontal usable fraction .8; vertical extent .4*81/49.
    const tolerance = projection.type === "orthographic" ? 1e-5 : .002;
    assert.ok(Math.abs(bounds.left - .1) < tolerance); assert.ok(Math.abs(bounds.right - .9) < tolerance);
    assert.ok(Math.abs(bounds.top - (1 - .4 * 81 / 49) / 2) < tolerance);
    assert.ok(Math.abs(bounds.bottom - (1 + .4 * 81 / 49) / 2) < tolerance);
    assert.deepEqual(prepared.sourceBytes, quadGlb());
    const pngPath = path.join(root, "render.png"), bytes = await readFile(pngPath);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), 81); assert.equal(bytes.readUInt32BE(20), 49);
    for (let offset = 8; offset < bytes.length;) {
      assert.ok(!["tEXt", "iTXt", "zTXt"].includes(bytes.toString("ascii", offset + 4, offset + 8)), "PNG must not carry volatile render metadata");
      offset += 12 + bytes.readUInt32BE(offset);
    }
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1024 * 1024, timeout: 30_000 });
    assert.equal(decoded.status, 0, decoded.error?.message ?? decoded.stderr.toString());
    const alpha = (x: number, y: number) => decoded.stdout[(y * 81 + x) * 4 + 3];
    assert.equal(alpha(0, 0), 0); assert.equal(alpha(40, 24), 255);
    assert.equal(alpha(4, 24), 0); assert.ok(alpha(9, 24)! > 0);
    const center = (24 * 81 + 40) * 4;
    assert.ok(decoded.stdout[center]! < decoded.stdout[center + 2]!, "blue material identity must survive lighting and sRGB encoding");
    const mtime = (await stat(pngPath)).mtimeMs;
    const again = await generateAsset(specPath);
    assert.equal(again.cache.status, "hit"); assert.equal((await stat(pngPath)).mtimeMs, mtime);
    const replay = await verifyAsset(specPath);
    assert.equal(replay.checks.regeneratedOutputMatchesReceipt, true);
    assert.equal((await stat(pngPath)).mtimeMs, mtime);
    await writeFile(path.join(root, "source.glb"), Buffer.alloc(prepared.sourceBytes.length));
    await assert.rejects(generateAsset(specPath), /hash mismatch/);
    assert.equal((await stat(pngPath)).mtimeMs, mtime);
  });
}

test("perspective framing fits independently authored near/far corners rather than an orthographic extent", {
  skip: !configured && "ASSET_TOOLING_BLENDER is not set", timeout: 120_000,
}, async t => {
  const bytes = quadGlb({ nodes: [{ name: "plane", mesh: 0, translation: [2, 3, 4] }, { name: "other", mesh: 0, translation: [10, 3, 5] }] });
  const { specPath } = await prepare(t, { ...front, selection: { type: "scene" }, projection: { type: "perspective", horizontalFovDegrees: 40 } }, bytes);
  const observed = (await generateAsset(specPath)).receipt.observations.script;
  const tangent = Math.tan(20 * Math.PI / 180), distance = 5 / (tangent * .8) + .5 + Math.hypot(10, 1, 1) * .001;
  const near = distance - .5, far = distance + .5;
  assert.equal(observed.meshCount, 2);
  assert.ok(Math.abs(observed.projectedBounds.left - (.5 - 5 / (2 * tangent * far))) < 1e-5);
  assert.ok(Math.abs(observed.projectedBounds.right - (.5 + 5 / (2 * tangent * near))) < 1e-5);
  assert.ok(Math.abs(observed.projectedBounds.top - (.5 - .5 * (81 / 49) / (2 * tangent * near))) < 1e-5);
});
