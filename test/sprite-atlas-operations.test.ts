import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { createAssetOperationCacheKey, createAssetRef, type AssetRef } from "../src/operations.js";
import {
  createSpriteAtlasOperationBuildIdentity, executeSpriteAtlasOperation, SPRITE_ATLAS_OPERATION,
  type SpriteAtlasManifest, type SpriteAtlasParameters, type SpriteDeclaration,
} from "../src/sprite-atlas-operations.js";

async function workspace(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-sprites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function image(root: string, width: number, height: number, values: number[]): Promise<AssetRef> {
  return (await storeAssetObject(root, { bytes: encodeRgba8Image({ width, height, pixels: Uint8Array.from(values) }),
    kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE })).asset;
}
const declaration = (id: string): SpriteDeclaration => ({ id, pivot: { x: 0, y: 0 } });
const parameters = (sprites: SpriteDeclaration[], changes: Partial<SpriteAtlasParameters> = {}): SpriteAtlasParameters => ({
  width: 16, maxHeight: 32, padding: 1, extrusion: 1, trim: true, sprites, ...changes,
});
async function result(root: string, p: SpriteAtlasParameters, refs: AssetRef[]) {
  const output = await executeSpriteAtlasOperation(root, { parameters: p, inputs: { sprites: refs } });
  const atlasRef = createAssetRef(output.outputs.image), manifestRef = createAssetRef(output.outputs.manifest);
  const atlas = parseRgba8Image(await resolveAssetObject(root, atlasRef));
  // This test reads the operation's own generated manifest; subsequent assertions check its contract.
  const manifest = JSON.parse((await resolveAssetObject(root, manifestRef)).toString()) as SpriteAtlasManifest;
  return { output, atlasRef, manifestRef, atlas, manifest };
}
function pixel(image: ReturnType<typeof parseRgba8Image>, x: number, y: number): number[] {
  return [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x + 1) * 4)];
}

test("atlas pins shelf rectangles, straight-alpha edge extrusion and transparent separation", async t => {
  const root = await workspace(t);
  const a = await image(root, 2, 1, [255, 0, 0, 128, 0, 0, 255, 255]);
  const b = await image(root, 1, 2, [0, 255, 0, 255, 255, 255, 0, 64]);
  const { atlas, manifest } = await result(root, parameters([declaration("b"), declaration("a")], { width: 11 }), [b, a]);
  assert.equal(atlas.width, 11); assert.equal(atlas.height, 6);
  assert.deepEqual(manifest.sprites.map(s => [s.id, s.rect]), [
    ["a", { x: 2, y: 2, width: 2, height: 1 }], ["b", { x: 8, y: 2, width: 1, height: 2 }],
  ]);
  assert.deepEqual(pixel(atlas, 1, 1), [255, 0, 0, 128]);
  assert.deepEqual(pixel(atlas, 4, 3), [0, 0, 255, 255]);
  assert.deepEqual(pixel(atlas, 7, 4), [255, 255, 0, 64]);
  for (const x of [0, 5, 6, 10]) for (let y = 0; y < atlas.height; y++) assert.deepEqual(pixel(atlas, x, y), [0, 0, 0, 0]);
  assert.deepEqual(manifest.sprites[0]!.source, a);
  assert.equal(manifest.coordinates, "top-left-pixels");
});

test("trim metadata reconstructs sparse non-square sprites and pivots, including fully empty images", async t => {
  const root = await workspace(t), pixels = Buffer.alloc(5 * 3 * 4);
  pixels.set([10, 20, 30, 1], (1 * 5 + 2) * 4); pixels.set([40, 50, 60, 255], (2 * 5 + 3) * 4);
  const sparse = await image(root, 5, 3, [...pixels]);
  const empty = await image(root, 4, 2, [...Buffer.alloc(32)]);
  const { atlas, manifest } = await result(root, parameters([{ id: "sparse", pivot: { x: 4.5, y: 2.5 } }, declaration("empty")]), [sparse, empty]);
  const entry = manifest.sprites.find(s => s.id === "sparse")!;
  assert.deepEqual(entry.sourceSize, { width: 5, height: 3 });
  assert.deepEqual(entry.trimOffset, { x: 2, y: 1 });
  assert.deepEqual(entry.pivot, { x: 4.5, y: 2.5 });
  assert.deepEqual([entry.rect.width, entry.rect.height, entry.rotated], [2, 2, false]);
  const restored = Buffer.alloc(entry.sourceSize.width * entry.sourceSize.height * 4);
  for (let y = 0; y < entry.rect.height; y++) for (let x = 0; x < entry.rect.width; x++) {
    restored.set(pixel(atlas, entry.rect.x + x, entry.rect.y + y), ((y + entry.trimOffset.y) * entry.sourceSize.width + x + entry.trimOffset.x) * 4);
  }
  assert.deepEqual(restored, pixels);
  const blank = manifest.sprites.find(s => s.id === "empty")!;
  assert.equal(blank.empty, true); assert.deepEqual(blank.sourceSize, { width: 4, height: 2 });
  assert.deepEqual([blank.rect.width, blank.rect.height], [1, 1]);
  assert.deepEqual(pixel(atlas, blank.rect.x, blank.rect.y), [0, 0, 0, 0]);
});

test("untrimmed atlases preserve hidden RGB bytes and wrap to bounded shelves", async t => {
  const root = await workspace(t);
  const source = await image(root, 2, 1, [99, 88, 77, 0, 10, 20, 30, 255]);
  const { atlas, manifest } = await result(root, parameters([declaration("b"), declaration("a")], { width: 2, padding: 0, extrusion: 0, trim: false }), [source, source]);
  assert.equal(atlas.height, 2);
  assert.deepEqual(manifest.sprites.map(s => s.rect), [{ x: 0, y: 0, width: 2, height: 1 }, { x: 0, y: 1, width: 2, height: 1 }]);
  assert.deepEqual(pixel(atlas, 0, 0), [99, 88, 77, 0]);
});

test("source/declaration pairing canonicalizes order, reuses stored outputs and matches a cold build", async t => {
  const root = await workspace(t), coldRoot = await workspace(t);
  const bytes = [33, 44, 55, 255], a = await image(root, 1, 1, bytes), b = await image(root, 1, 1, [66, 77, 88, 255]);
  const coldA = await image(coldRoot, 1, 1, bytes), coldB = await image(coldRoot, 1, 1, [66, 77, 88, 255]);
  const forward = { parameters: parameters([declaration("a"), declaration("b")]), inputs: { sprites: [a, b] } };
  const reverse = { parameters: parameters([declaration("b"), declaration("a")]), inputs: { sprites: [b, a] } };
  const firstBuild = await createSpriteAtlasOperationBuildIdentity(root, forward);
  assert.equal(createAssetOperationCacheKey({ ...firstBuild, operation: SPRITE_ATLAS_OPERATION }), createAssetOperationCacheKey({ ...await createSpriteAtlasOperationBuildIdentity(root, reverse), operation: SPRITE_ATLAS_OPERATION }));
  const first = await result(root, forward.parameters, [a, b]);
  const outputPath = path.join(root, assetObjectPortablePath(first.atlasRef));
  const before = (await stat(outputPath)).mtimeMs;
  assert.deepEqual((await result(root, reverse.parameters, [b, a])).output, first.output);
  assert.equal((await stat(outputPath)).mtimeMs, before);
  assert.deepEqual((await result(coldRoot, forward.parameters, [coldA, coldB])).output, first.output);
  const changed = await result(root, parameters([declaration("a"), declaration("b")], { width: 6 }), [a, b]);
  assert.notEqual(changed.atlasRef.sha256, first.atlasRef.sha256);
  assert.deepEqual(changed.manifest.sprites.map(s => [s.id, s.source]), first.manifest.sprites.map(s => [s.id, s.source]));
});

test("producer frame indices and sample times survive ID packing order, with invalid sequences rejected", async t => {
  const root = await workspace(t), source = await image(root, 1, 1, [0, 0, 0, 255]);
  const declarations: SpriteDeclaration[] = [
    { ...declaration("z-first"), frame: { sequence: "burst", index: 2, timeMs: 10, durationMs: 20, loop: false } },
    { ...declaration("a-second"), frame: { sequence: "burst", index: 7, timeMs: 40, durationMs: 30, loop: false } },
  ];
  const { manifest } = await result(root, parameters(declarations), [source, source]);
  assert.deepEqual(manifest.sprites.map(s => s.frame?.index), [7, 2]);
  for (const frame of [
    { ...declarations[1]!.frame!, index: 2 }, { ...declarations[1]!.frame!, timeMs: 29 },
    { ...declarations[1]!.frame!, loop: true }, { ...declarations[1]!.frame!, durationMs: 0 },
  ]) await assert.rejects(executeSpriteAtlasOperation(root, { parameters: parameters([declarations[0]!, { ...declaration("second"), frame }]), inputs: { sprites: [source, source] } }));
});

test("invalid declarations, unsupported rotation, bounds, missing or corrupt sources fail before writing outputs", async t => {
  const root = await workspace(t), source = await image(root, 1, 1, [1, 2, 3, 255]);
  const before = (await readdir(root, { recursive: true })).sort();
  const valid = parameters([declaration("a")]);
  const invalid = [
    { ...valid, width: 0 }, { ...valid, width: 4097 }, { ...valid, extrusion: 33 }, { ...valid, rotated: true },
    { ...valid, sprites: [declaration("a"), declaration("a")] },
    { ...valid, sprites: [{ id: "a", pivot: { x: 2, y: 0 } }] },
    { ...valid, sprites: [{ id: "../a", pivot: { x: 0, y: 0 } }] },
    { ...valid, width: 4 }, { ...valid, maxHeight: 4 },
  ];
  for (const p of invalid) await assert.rejects(executeSpriteAtlasOperation(root, { parameters: p, inputs: { sprites: [source] } }));
  await assert.rejects(executeSpriteAtlasOperation(root, { parameters: valid, inputs: { sprites: [] } }));
  await assert.rejects(executeSpriteAtlasOperation(root, { parameters: valid, inputs: { sprites: [{ ...source, sha256: "0".repeat(64) }] } }));
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  await writeFile(path.join(root, assetObjectPortablePath(source)), "corrupt");
  await assert.rejects(createSpriteAtlasOperationBuildIdentity(root, { parameters: valid, inputs: { sprites: [source] } }), /hash|length|size/i);
  assert.equal(Reflect.set(SPRITE_ATLAS_OPERATION.parameterSchema, "type", "array"), false);
});
