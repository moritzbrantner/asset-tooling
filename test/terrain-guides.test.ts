import assert from "node:assert/strict";
import { test } from "bun:test";
import { sha256Bytes } from "../src/hash.ts";
import { encodeRgba8Image } from "../src/image-rgba8.ts";
import {
  TERRAIN_PATCH_PRESETS, buildTerrainPatchFiles, generateTerrainPatch, loadTerrainPatchGuides, normalizeTerrainPatchRecipe,
  scatterTerrainDetail, terrainPatchComponentKeys, type TerrainGuide, type TerrainPatchRecipe, type Vec2,
} from "../src/terrain-patch-recipes.ts";

// Saved guides (#140): independent fixtures with hand-computed expectations.
const gray = (width: number, height: number, values: number[]) =>
  encodeRgba8Image({ width, height, pixels: Uint8Array.from(values.flatMap((v) => [v, v, v, 255])) });
const polylineFile = (points: unknown, extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ schema: "terrain-guide-polyline-v1", space: "terrain-world-xz", units: "m", points, ...extra }));
const pin = (file: string, bytes: Uint8Array) => ({ file, sha256: sha256Bytes(bytes), bytes: bytes.byteLength });
type Mask = Extract<TerrainGuide, { kind: "mask" }>;
const maskGuide = (file: string, bytes: Uint8Array, w: number, h: number, rest: Partial<Mask> = {}): Mask =>
  ({ kind: "mask", ...pin(file, bytes), width: w, height: h, origin: [0, 0], pixelSize: 1, filter: "nearest", outside: "zero", ...rest });

/** A flat 11×9 patch at 1 m spacing from (0, 0), with one grass layer and no shapes. */
const flat = (overrides: Partial<TerrainPatchRecipe> = {}): TerrainPatchRecipe => ({
  ...structuredClone(TERRAIN_PATCH_PRESETS.flat), schemaVersion: 3, samples: [11, 9], noise: { ...TERRAIN_PATCH_PRESETS.flat.noise, amplitude: 0 },
  guides: {}, edits: [], exclusions: [], paint: {},
  detail: [{ id: "grass", seed: 5, density: 4, minSpacing: 0.3, slopeDegrees: [0, 90], height: [-100, 100], maxExclusion: 0.5, paint: null, scale: [1, 1], variants: 1 }],
  ...overrides,
});
const reader = (files: Record<string, Uint8Array>) => (file: string) => files[file];
const patch: Vec2 = [0, 0];

test("a mask guide is sampled at declared pixel centres: nearest, bilinear, outside zero or clamp, odd non-square, negative origin", () => {
  // 3×2 mask, one marked pixel (2, 1); pixel centres at origin + (i, j)·2 with origin (−3, −1).
  const bytes = gray(3, 2, [0, 0, 0, 0, 0, 255]);
  const sample = (rest: Partial<Mask>) => {
    const r = flat({ samples: [9, 5], origin: [-4, -2], guides: { m: maskGuide("m.json", bytes, 3, 2, { origin: [-3, -1], pixelSize: 2, ...rest }) },
      paint: { m: [{ kind: "mask", guide: "m" }] } });
    const p = generateTerrainPatch(r, patch, loadTerrainPatchGuides(r, reader({ "m.json": bytes })));
    return [...p.paint.m!];
  };
  // Samples x = −4..4, z = −2..2. Pixel (2, 1) centre is world (1, 1); nearest footprint x ∈ [0, 2), z ∈ [0, 2).
  const nearest = sample({});
  const expected = Array.from({ length: 45 }, (_, k) => { const x = -4 + (k % 9), z = -2 + Math.floor(k / 9); return x >= 0 && x < 2 && z >= 0 && z < 2 ? 255 : 0; });
  assert.deepEqual(nearest, expected);
  // Bilinear: 255 at the centre (1, 1), 128 halfway to (0, 1); x = 2 is outside the half-open footprint [−4, 2) and weighs 0.
  const bilinear = sample({ filter: "bilinear" }), at = (values: number[], x: number, z: number) => values[(z + 2) * 9 + x + 4];
  assert.equal(at(bilinear, 1, 1), 255);
  assert.equal(at(bilinear, 0, 1), 128);
  assert.equal(at(bilinear, 1, 0), 128);
  assert.equal(at(bilinear, 0, 0), 64);
  assert.equal(at(bilinear, 2, 1), 0);
  // Clamp extends the edge pixel beyond the footprint instead.
  const clamped = sample({ outside: "clamp" });
  assert.equal(at(clamped, 4, 2), 255);
  assert.equal(at(clamped, -4, -2), 0);
});

test("zero and one masks: an all-black exclusion keeps every candidate, an all-white one removes all of them", () => {
  const black = gray(11, 9, Array(99).fill(0)), white = gray(11, 9, Array(99).fill(255));
  const run = (bytes: Uint8Array) => {
    const r = flat({ guides: { x: maskGuide("x.json", bytes, 11, 9) }, exclusions: [{ kind: "mask", guide: "x" }] });
    return scatterTerrainDetail(generateTerrainPatch(r, patch, loadTerrainPatchGuides(r, reader({ "x.json": bytes }))));
  };
  const none = scatterTerrainDetail(generateTerrainPatch(flat(), patch));
  assert.ok(none.length > 50);
  assert.deepEqual(run(black), none);
  assert.deepEqual(run(white), []);
});

test("a saved polyline guide equals the same inline path, and its exclusion leaves no detail inside the path", async () => {
  const points: Vec2[] = [[-1, 1.5], [4, 6.5], [11, 3.5]];
  const bytes = polylineFile(points), files = { "guides/trail.json": bytes };
  const guided = flat({ guides: { trail: { kind: "polyline", ...pin("guides/trail.json", bytes) } },
    edits: [{ kind: "path", points: { guide: "trail" }, width: 2, falloff: 0, excludeDetail: true }] });
  const inline = flat({ edits: [{ kind: "path", points, width: 2, falloff: 0, excludeDetail: true }] });
  const guides = loadTerrainPatchGuides(guided, reader(files));
  const a = await buildTerrainPatchFiles(guided, patch, { guides }), b = await buildTerrainPatchFiles(inline, patch);
  for (const file of Object.keys(b.files)) assert.deepEqual(a.files[file], b.files[file], file);
  // Exclusion weight is 1 within width/2 = 1 m of the centreline, above maxExclusion 0.5: nothing may stand there.
  const distance = (x: number, z: number) => Math.min(...points.slice(1).map((q, i) => {
    const p = points[i]!, dx = q[0] - p[0], dz = q[1] - p[1], t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - p[0] - t * dx, z - p[1] - t * dz);
  }));
  const all = scatterTerrainDetail(generateTerrainPatch(flat(), patch));
  assert.ok(all.some((d) => distance(d.position[0], d.position[2]) <= 1), "the fixture has candidates on the path");
  assert.ok(a.detail.length > 0 && a.detail.every((d) => distance(d.position[0], d.position[2]) > 1));
  assert.ok(a.detail.every((d) => all.some((o) => o.id === d.id)), "the path only removes detail");
  assert.deepEqual(Buffer.from(files["guides/trail.json"]), bytes, "the guide is unchanged");
});

test("editing a mask guide rebuilds only the components that read it; moving its file changes nothing", async () => {
  const meadow = gray(11, 9, Array.from({ length: 99 }, (_, k) => (k % 11 < 5 ? 255 : 0)));
  const moved = gray(11, 9, Array.from({ length: 99 }, (_, k) => (k % 11 >= 6 ? 255 : 0)));
  const recipe = (file: string, bytes: Uint8Array): TerrainPatchRecipe => {
    const r = flat({ guides: { meadow: maskGuide(file, bytes, 11, 9) }, paint: { meadow: [{ kind: "mask", guide: "meadow" }] },
      exclusions: [{ kind: "circle", center: [8, 2], radius: 1, falloff: 0 }] });
    r.detail.push({ ...r.detail[0]!, id: "flowers", seed: 9, paint: "meadow" });
    return r;
  };
  const before = recipe("a.json", meadow), guides = loadTerrainPatchGuides(before, reader({ "a.json": meadow }));
  const first = await buildTerrainPatchFiles(before, patch, { guides });
  assert.deepEqual(terrainPatchComponentKeys(recipe("elsewhere/b.json", meadow), patch), terrainPatchComponentKeys(before, patch), "a file path is not identity");
  const after = recipe("a.json", moved), afterGuides = loadTerrainPatchGuides(after, reader({ "a.json": moved }));
  const second = await buildTerrainPatchFiles(after, patch, { guides: afterGuides, previous: { record: first.record, read: (f) => first.files[f] },
    preserve: ["height", "exclusion", "detail.grass"] });
  assert.deepEqual(second.stages.executed, ["paint.meadow", "detail.flowers", "detail"]);
  assert.equal(second.heightSamplesEvaluated, 0);
  const cold = await buildTerrainPatchFiles(after, patch, { guides: afterGuides });
  for (const [file, bytes] of Object.entries(cold.files)) assert.deepEqual(second.files[file], bytes, `${file} matches a cold build`);
  assert.ok(second.detail.filter((d) => d.layer === "flowers").every((d) => d.position[0] >= 5.5));
  // A guide loaded for another version of the recipe is refused, and so is a recipe built without its guides.
  assert.throws(() => generateTerrainPatch(after, patch, guides), /loaded guide 'meadow' does not match its declaration/);
  assert.throws(() => generateTerrainPatch(after, patch), /guide 'meadow' was not loaded/);
});

test("guide declarations and files fail closed", () => {
  const line = polylineFile([[0, 0], [5, 5]]), mask = gray(2, 2, [0, 0, 0, 0]);
  const withGuide = (guide: unknown, use: Partial<TerrainPatchRecipe> = { edits: [{ kind: "path", points: { guide: "g" }, width: 1, falloff: 0, excludeDetail: false }] }) =>
    flat({ guides: { g: guide as TerrainGuide }, ...use });
  const load = (guide: unknown, bytes: Uint8Array | undefined, use?: Partial<TerrainPatchRecipe>) =>
    loadTerrainPatchGuides(withGuide(guide, use), () => bytes);
  const g = { kind: "polyline", ...pin("g.json", line) };
  // Declarations.
  for (const file of ["../g.json", "/g.json", "a//g.json", "a\\g.json", "./g.json", ""]) {
    assert.throws(() => normalizeTerrainPatchRecipe(withGuide({ ...g, file })), /portable relative path/, file);
  }
  assert.throws(() => normalizeTerrainPatchRecipe(withGuide({ ...g, sha256: "ABC" })), /sha256/);
  assert.throws(() => normalizeTerrainPatchRecipe(withGuide({ ...g, bytes: 9 * 1024 * 1024 })), /bytes must be an integer/);
  assert.throws(() => normalizeTerrainPatchRecipe(withGuide(maskGuide("m.json", mask, 2048, 2))), /width must be an integer/);
  assert.throws(() => normalizeTerrainPatchRecipe(withGuide(maskGuide("m.json", mask, 2, 2, { pixelSize: 0 }))), /pixelSize/);
  assert.throws(() => normalizeTerrainPatchRecipe(withGuide(maskGuide("m.json", mask, 2, 2, { filter: "cubic" as "nearest" }))), /filter/);
  assert.throws(() => normalizeTerrainPatchRecipe(withGuide(maskGuide("m.json", mask, 2, 2))), /names mask guide 'g' where a polyline guide is needed/);
  assert.throws(() => normalizeTerrainPatchRecipe(flat({ exclusions: [{ kind: "mask", guide: "nope" }] })), /undeclared guide 'nope'/);
  const { guides: _, ...noGuides } = flat();
  assert.throws(() => normalizeTerrainPatchRecipe({ ...noGuides, schemaVersion: 2, exclusions: [{ kind: "mask", guide: "g" }] }), /needs schemaVersion 3/);
  assert.throws(() => normalizeTerrainPatchRecipe(noGuides), /missing 'guides'/);
  // Files.
  assert.throws(() => load(g, undefined), /guide 'g' \(g.json\) is missing/);
  assert.throws(() => load(g, Buffer.concat([line, Buffer.from(" ")])), /bytes, not the declared/);
  const tampered = Buffer.from(line); tampered[tampered.length - 3] = 0x36;
  assert.throws(() => load(g, tampered), /does not match its declared sha256/);
  const file = (bytes: Uint8Array) => load({ kind: "polyline", ...pin("g.json", bytes) }, bytes);
  assert.throws(() => file(polylineFile([[0, 0], [5, 5]], { units: "ft" })), /units must be m/);
  assert.throws(() => file(polylineFile([[0, 0], [5, 5]], { space: "image-uv" })), /space must be terrain-world-xz/);
  assert.throws(() => file(Buffer.from('{"schema":"terrain-guide-polyline-v1","space":"terrain-world-xz","units":"m","points":[[0,0],[1e400,0]]}')), /finite number/);
  assert.throws(() => file(polylineFile([[0, 0], [2, 2], [2, 2]])), /points\[2\] repeats the previous point/);
  assert.throws(() => file(polylineFile([[0, 0]])), /2..256 points/);
  const maskUse = { exclusions: [{ kind: "mask" as const, guide: "g" }] };
  const loadMask = (bytes: Uint8Array, w = 2, h = 2) => load(maskGuide("m.json", bytes, w, h), bytes, maskUse);
  assert.throws(() => loadMask(mask, 3, 2), /not a 3×2 RGBA8 image/);
  assert.throws(() => loadMask(encodeRgba8Image({ width: 1, height: 1, pixels: Uint8Array.from([9, 9, 9, 128]) }), 1, 1), /pixel \(0, 0\) is not opaque grayscale/);
  assert.throws(() => loadMask(encodeRgba8Image({ width: 2, height: 1, pixels: Uint8Array.from([0, 0, 0, 255, 9, 8, 9, 255]) }), 2, 1), /pixel \(1, 0\) is not opaque grayscale/);
});
