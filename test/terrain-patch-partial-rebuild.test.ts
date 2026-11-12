import assert from "node:assert/strict";
import { test } from "bun:test";
import { sha256Bytes } from "../src/hash.ts";
import {
  TERRAIN_PATCH_PRESETS, buildTerrainPatchFiles, decodeGrayPng, encodeGrayPng, generateTerrainPatch, terrainPatchComponentKeys,
  type TerrainPatchBuild, type TerrainPatchRecipe, type Vec2,
} from "../src/terrain-patch-recipes.ts";

// A small schema-2 recipe: the height seed and each detail layer's seed are separate groups.
const base = (): TerrainPatchRecipe => ({
  ...structuredClone(TERRAIN_PATCH_PRESETS.rolling), schemaVersion: 2, samples: [17, 13], origin: [-20, 5], sampleSpacing: 1.5,
  edits: [{ kind: "flatten", shape: { kind: "circle", center: [-8, 12], radius: 3, falloff: 2 }, height: 4, excludeDetail: true }],
  exclusions: [{ kind: "circle", center: [-14, 20], radius: 2, falloff: 1 }],
  paint: { meadow: [{ kind: "circle", center: [-12, 10], radius: 6, falloff: 4 }] },
  detail: [
    { id: "grass", density: 0.4, minSpacing: 0.8, slopeDegrees: [0, 90], height: [-100, 100], maxExclusion: 0.5, paint: null, scale: [0.8, 1.2], variants: 3, seed: 11 },
    { id: "flowers", density: 0.3, minSpacing: 1, slopeDegrees: [0, 90], height: [-100, 100], maxExclusion: 0.2, paint: "meadow", scale: [0.9, 1.1], variants: 2, seed: 12 },
  ],
});
const patch: Vec2 = [0, 0];
const edit = (r: TerrainPatchRecipe, change: (r: TerrainPatchRecipe) => void) => { const copy = structuredClone(r); change(copy); return copy; };
const previousOf = (build: TerrainPatchBuild, files = build.files) => ({ record: build.record, read: (file: string) => files[file] });
const hashes = (build: TerrainPatchBuild) => Object.fromEntries(Object.entries(build.files).map(([f, b]) => [f, sha256Bytes(b)]));
async function partial(r: TerrainPatchRecipe, previous: TerrainPatchBuild, options: { preserve?: string[]; files?: Record<string, Uint8Array> } = {}) {
  const build = await buildTerrainPatchFiles(r, patch, { previous: previousOf(previous, options.files), preserve: options.preserve });
  const cold = await buildTerrainPatchFiles(r, patch);
  assert.deepEqual(hashes(build), hashes(cold), "partial rebuild matches the cold build");
  assert.deepEqual(build.record, cold.record);
  return build;
}

test("a cold component build equals the whole-patch reference, and a schema-1 recipe keeps its bytes as schema 2", async () => {
  const v1: TerrainPatchRecipe = { ...base(), schemaVersion: 1, seed: 11, detail: base().detail.map(({ seed: _, ...l }) => l) };
  const reference = generateTerrainPatch(v1, patch), build = await buildTerrainPatchFiles(v1, patch);
  assert.deepEqual(Buffer.from(build.files["height.png"]!), encodeGrayPng(reference.width, reference.depth, reference.heights));
  assert.deepEqual(Buffer.from(build.files["paint-meadow.png"]!), encodeGrayPng(reference.width, reference.depth, reference.paint.meadow!));
  assert.equal(build.heightSamplesEvaluated, (17 + 2) * (13 + 2));
  assert.deepEqual(build.stages.reused, []);
  const v2 = { ...base(), seed: 11, detail: base().detail.map((l) => ({ ...l, seed: 11 })) };
  assert.deepEqual(terrainPatchComponentKeys(v2, patch), terrainPatchComponentKeys(v1, patch));
  assert.deepEqual(hashes(await buildTerrainPatchFiles(v2, patch)), hashes(build));
  const { seed: _, ...unseeded } = v2.detail[0]!;
  assert.throws(() => generateTerrainPatch({ ...v2, detail: [unseeded] }, patch), /detail\[0\] is missing 'seed'/);
});

test("a paint edit rebuilds the mask and the detail that reads it, never the height", async () => {
  const before = await buildTerrainPatchFiles(base(), patch);
  const r = edit(base(), (r) => { r.paint.meadow![0]!.center = [-4, 14]; });
  const after = await partial(r, before, { preserve: ["height", "exclusion", "detail.grass"] });
  assert.deepEqual(after.stages.executed, ["paint.meadow", "detail.flowers", "detail"]);
  assert.equal(after.heightSamplesEvaluated, 0, "the preserved height was decoded, not re-evaluated");
  for (const file of ["height.png", "slope.png", "mesh.glb", "exclusion.png"]) assert.equal(after.files[file], before.files[file], `${file} is the same object`);
  assert.notEqual(sha256Bytes(after.files["paint-meadow.png"]!), sha256Bytes(before.files["paint-meadow.png"]!));
  const grass = (b: TerrainPatchBuild) => b.detail.filter((d) => d.layer === "grass");
  assert.deepEqual(grass(after), grass(before));
});

test("reseeding one detail group changes only that layer; its IDs come from cells, not order", async () => {
  const before = await buildTerrainPatchFiles(base(), patch);
  const after = await partial(edit(base(), (r) => { r.detail[0]!.seed = 99; }), before, { preserve: ["height", "detail.flowers"] });
  assert.deepEqual(after.stages.executed, ["detail.grass", "detail"]);
  assert.equal(after.heightSamplesEvaluated, 0);
  assert.deepEqual(after.detail.filter((d) => d.layer === "flowers"), before.detail.filter((d) => d.layer === "flowers"));
  assert.notDeepEqual(after.detail.filter((d) => d.layer === "grass"), before.detail.filter((d) => d.layer === "grass"));
});

test("a height edit invalidates the mesh and every detail layer, and refuses an explicit height lock", async () => {
  const before = await buildTerrainPatchFiles(base(), patch);
  const r = edit(base(), (r) => { r.noise.amplitude = 3; });
  await assert.rejects(buildTerrainPatchFiles(r, patch, { previous: previousOf(before), preserve: ["height"] }), /'height' cannot be preserved: its inputs changed/);
  await assert.rejects(buildTerrainPatchFiles(r, patch, { previous: previousOf(before), preserve: ["detail.grass"] }), /'detail.grass' cannot be preserved/);
  const after = await partial(r, before);
  assert.deepEqual(after.stages.executed, ["height", "detail.grass", "detail.flowers", "detail"]);
  assert.deepEqual(after.stages.reused, ["exclusion", "paint.meadow"]);
  // excludeDetail only feeds the exclusion mask and detail, not the height.
  const flag = await partial(edit(base(), (r) => { r.edits[0]!.excludeDetail = false; }), before, { preserve: ["height"] });
  assert.deepEqual(flag.stages.executed, ["exclusion", "detail.grass", "detail.flowers", "detail"]);
});

test("corrupt or missing earlier bytes are regenerated, but an explicit lock on them fails closed", async () => {
  const before = await buildTerrainPatchFiles(base(), patch);
  const corrupt = { ...before.files, "height.png": Uint8Array.from(before.files["height.png"]!, (b, i) => (i === 60 ? b ^ 1 : b)) };
  await assert.rejects(buildTerrainPatchFiles(base(), patch, { previous: previousOf(before, corrupt), preserve: ["height"] }), /height.png is missing or does not match/);
  const repaired = await partial(base(), before, { files: corrupt });
  assert.deepEqual(repaired.stages.executed, ["height"]);
  const { ["detail.json"]: _, ...noDetail } = before.files;
  assert.deepEqual((await partial(base(), before, { files: noDetail })).stages.executed, ["detail.grass", "detail.flowers", "detail"]);
  await assert.rejects(buildTerrainPatchFiles(base(), patch, { previous: previousOf(before), preserve: ["detail.rocks"] }), /unknown terrain component/);
});

test("an edit sequence with reorder, add, remove, reseed, undo and an interrupted write ends where a clean build does", async () => {
  const steps: ((r: TerrainPatchRecipe) => void)[] = [
    (r) => { r.detail.reverse(); },
    (r) => { r.detail.push({ id: "stones", density: 0.05, minSpacing: 2, slopeDegrees: [0, 90], height: [-100, 100], maxExclusion: 1, paint: null, scale: [1, 1], variants: 2, seed: 3 }); },
    (r) => { r.detail = r.detail.filter((l) => l.id !== "flowers"); },
    (r) => { r.detail[0]!.seed = 5; },
    (r) => { r.detail[0]!.seed = 3; },
    (r) => { r.exclusions = []; },
  ];
  let current = base(), previous = await buildTerrainPatchFiles(current, patch);
  for (const step of steps) {
    current = edit(current, step);
    previous = await partial(current, previous);
    assert.equal(previous.heightSamplesEvaluated, 0, "no step touches the height");
  }
  // Interrupted write: some new files landed but the record that pins them did not. Mismatched bytes regenerate.
  const next = edit(current, (r) => { r.paint.meadow![0]!.radius = 9; });
  const landed = await buildTerrainPatchFiles(next, patch);
  const mixed = { ...previous.files, "paint-meadow.png": landed.files["paint-meadow.png"]! };
  const restarted = await partial(next, previous, { files: mixed });
  assert.ok(restarted.stages.executed.includes("paint.meadow"));
  // Undo all the way back reuses the height and returns the original bytes.
  const undone = await partial(base(), restarted, { preserve: ["height"] });
  assert.deepEqual(hashes(undone), hashes(await buildTerrainPatchFiles(base(), patch)));
});

test("decodeGrayPng reads exactly what encodeGrayPng writes and rejects other layouts", () => {
  const samples = Uint16Array.from({ length: 12 }, (_, i) => i * 5000);
  assert.deepEqual(decodeGrayPng(encodeGrayPng(4, 3, samples), 4, 3, 16), samples);
  const bytes = Uint8Array.from({ length: 6 }, (_, i) => i * 40);
  assert.deepEqual(decodeGrayPng(encodeGrayPng(3, 2, bytes), 3, 2, 8), bytes);
  assert.throws(() => decodeGrayPng(encodeGrayPng(3, 2, bytes), 2, 3, 8), /3-bit|2×3/);
});
