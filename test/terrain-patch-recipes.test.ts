import assert from "node:assert/strict";
import { test } from "bun:test";
import { NodeIO } from "@gltf-transform/core";
import {
  TERRAIN_PATCH_PRESETS, encodeGrayPng, generateTerrainPatch, normalizeTerrainPatchRecipe, scatterTerrainDetail,
  terrainPatchGlb, terrainShapeWeight, type TerrainPatchRecipe, type Vec2,
} from "../src/terrain-patch-recipes.ts";

const recipe = (patch: Partial<TerrainPatchRecipe> = {}): TerrainPatchRecipe => ({
  ...structuredClone(TERRAIN_PATCH_PRESETS.rolling), samples: [17, 13], origin: [-20, 5], sampleSpacing: 1.5,
  detail: [{ id: "grass", density: 0.4, minSpacing: 0.8, slopeDegrees: [0, 90], height: [-100, 100], maxExclusion: 0.5, paint: null, scale: [0.8, 1.2], variants: 3 }],
  ...patch,
});
const column = (p: ReturnType<typeof generateTerrainPatch>, i: number, data: ArrayLike<number>, size = 1) =>
  Array.from({ length: p.depth }, (_, j) => Array.from({ length: size }, (_, c) => data[(j * p.width + i) * size + c])).flat();
const row = (p: ReturnType<typeof generateTerrainPatch>, j: number, data: ArrayLike<number>, size = 1) =>
  Array.from(data).slice(j * p.width * size, (j + 1) * p.width * size);

test("adjacent patches share edge heights, normals and masks in any generation order, including negative patches", () => {
  const r = recipe({ exclusions: [{ kind: "circle", center: [0, 10], radius: 4, falloff: 3 }] });
  for (const [a, b] of [[[-1, -1], [0, -1]], [[0, -1], [-1, -1]]] as [Vec2, Vec2][]) {
    const left = generateTerrainPatch(r, a), right = generateTerrainPatch(r, b);
    const [west, east] = left.patch[0] < right.patch[0] ? [left, right] : [right, left];
    assert.deepEqual(column(west, west.width - 1, west.heights), column(east, 0, east.heights));
    assert.deepEqual(column(west, west.width - 1, west.normals, 3), column(east, 0, east.normals, 3));
    assert.deepEqual(column(west, west.width - 1, west.slope), column(east, 0, east.slope));
    assert.deepEqual(column(west, west.width - 1, west.exclusion), column(east, 0, east.exclusion));
  }
  const south = generateTerrainPatch(r, [0, 0]), north = generateTerrainPatch(r, [0, -1]);
  assert.deepEqual(row(north, north.depth - 1, north.heights), row(south, 0, south.heights));
  assert.deepEqual(row(north, north.depth - 1, north.normals, 3), row(south, 0, south.normals, 3));
  assert.deepEqual(south.origin, [-20, 5]);
  assert.deepEqual(north.origin, [-20, 5 - 12 * 1.5]);
});

test("a patch is a pure function of its index: full and incremental rebuilds match byte for byte", async () => {
  const r = recipe();
  const full = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => generateTerrainPatch(r, p as Vec2));
  const again = generateTerrainPatch(r, [1, 1]);
  assert.deepEqual(again.heights, full[3]!.heights);
  assert.deepEqual(again.normals, full[3]!.normals);
  assert.deepEqual(scatterTerrainDetail(again), scatterTerrainDetail(full[3]!));
  assert.deepEqual(await terrainPatchGlb(again), await terrainPatchGlb(full[3]!));
});

test("heights match an independent naive resampling of the declared world grid", () => {
  const r = normalizeTerrainPatchRecipe(recipe({ noise: { baseHeight: 2, amplitude: 0, featureSize: 10, octaves: 1, roughness: 0.5 },
    edits: [{ kind: "flatten", shape: { kind: "rect", center: [-10, 14], size: [6, 4], rotationDegrees: 0, falloff: 0 }, height: 5, excludeDetail: true }] }));
  const p = generateTerrainPatch(r, [0, 0]);
  for (let j = 0; j < p.depth; j += 1) for (let i = 0; i < p.width; i += 1) {
    const x = -20 + i * 1.5, z = 5 + j * 1.5;
    const inside = Math.abs(x + 10) <= 3 && Math.abs(z - 14) <= 2;
    assert.equal(p.heights[j * p.width + i], Math.round(((inside ? 5 : 2) + 8) / 0.001), `${x},${z}`);
    assert.equal(p.exclusion[j * p.width + i], inside ? 255 : 0);
  }
});

test("detail IDs partition across adjacent patches regardless of order, honour minimum spacing and sit on the mesh", () => {
  const r = recipe();
  const a = scatterTerrainDetail(generateTerrainPatch(r, [-1, 0])), b = scatterTerrainDetail(generateTerrainPatch(r, [0, 0]));
  const b2 = scatterTerrainDetail(generateTerrainPatch(r, [0, 0])), a2 = scatterTerrainDetail(generateTerrainPatch(r, [-1, 0]));
  assert.deepEqual([a, b], [a2, b2]);
  assert.ok(a.length > 20 && b.length > 20);
  const all = [...a, ...b];
  assert.equal(new Set(all.map((d) => d.id)).size, all.length);
  for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < all.length; j += 1) {
    const d = Math.hypot(all[i]!.position[0] - all[j]!.position[0], all[i]!.position[2] - all[j]!.position[2]);
    assert.ok(d >= 0.8 - 2e-4, `${all[i]!.id} and ${all[j]!.id} are ${d} m apart`);
  }
  const p = generateTerrainPatch(r, [0, 0]);
  for (const d of b) {
    assert.ok(d.position[0] >= p.origin[0] && d.position[0] < p.origin[0] + 16 * 1.5);
    assert.ok(d.scale >= 0.8 && d.scale <= 1.2 && d.variant >= 0 && d.variant < 3);
  }
});

test("a localized edit removes only nearby detail and changes only nearby heights", () => {
  const before = recipe();
  const circle = { kind: "circle" as const, center: [-12, 12] as Vec2, radius: 3, falloff: 2 };
  const after = recipe({ exclusions: [circle], edits: [{ kind: "flatten", shape: circle, height: 3, excludeDetail: false }] });
  const old = scatterTerrainDetail(generateTerrainPatch(before, [0, 0])), next = scatterTerrainDetail(generateTerrainPatch(after, [0, 0]));
  const far = (d: { position: number[] }) => Math.hypot(d.position[0]! + 12, d.position[2]! - 12) > 5 + 1.5 * Math.SQRT2; // a mesh cell beyond the edit
  const kept = new Map(next.map((d) => [d.id, d]));
  const core = (d: { position: number[] }) => Math.hypot(d.position[0]! + 12, d.position[2]! - 12) <= 4;
  assert.ok(old.some(core) && !next.some(core));
  for (const d of old.filter(far)) assert.deepEqual(kept.get(d.id), d);
  const h0 = generateTerrainPatch(before, [0, 0]), h1 = generateTerrainPatch(after, [0, 0]);
  for (let k = 0; k < h0.heights.length; k += 1) {
    const x = -20 + (k % 17) * 1.5, z = 5 + Math.floor(k / 17) * 1.5;
    if (Math.hypot(x + 12, z - 12) > 5) assert.equal(h1.heights[k], h0.heights[k]);
  }
});

test("slope, height, paint and exclusion limits filter detail; all-excluded scatter is empty", () => {
  const steep = recipe({ noise: { baseHeight: 4, amplitude: 10, featureSize: 12, octaves: 3, roughness: 0.5 } });
  const limited = { ...steep, detail: [{ ...steep.detail[0]!, slopeDegrees: [0, 15] as Vec2, height: [0, 6] as Vec2 }] };
  const all = scatterTerrainDetail(generateTerrainPatch(steep, [0, 0])), some = scatterTerrainDetail(generateTerrainPatch(limited, [0, 0]));
  assert.ok(some.length > 0 && some.length < all.length);
  for (const d of some) assert.ok(d.position[1] >= 0 && d.position[1] <= 6);
  const allIds = new Set(all.map((d) => d.id));
  assert.ok(some.every((d) => allIds.has(d.id)));
  const everywhere = recipe({ exclusions: [{ kind: "rect", center: [0, 0], size: [500, 500], rotationDegrees: 0, falloff: 0 }] });
  assert.deepEqual(scatterTerrainDetail(generateTerrainPatch(everywhere, [0, 0])), []);
  const painted = recipe({ paint: { meadow: [{ kind: "polyline", points: [[-20, 5], [4, 23]], width: 4, falloff: 0 }] } });
  painted.detail[0]!.paint = "meadow";
  const inPaint = scatterTerrainDetail(generateTerrainPatch(painted, [0, 0]));
  assert.ok(inPaint.length > 0 && inPaint.every((d) => terrainShapeWeight(painted.paint.meadow![0]!, d.position[0], d.position[2]) > 0));
});

test("a path levels its cross-section to the centreline and can exclude detail", () => {
  const r = recipe({ edits: [{ kind: "path", points: [[-20, 8], [4, 20]], width: 3, falloff: 2, excludeDetail: true }] });
  const p = generateTerrainPatch(r, [0, 0]);
  assert.ok(p.exclusion.some((w) => w === 255));
  for (const d of scatterTerrainDetail(p)) assert.ok(terrainShapeWeight({ kind: "polyline", points: [[-20, 8], [4, 20]], width: 3, falloff: 2 }, d.position[0], d.position[2]) <= 0.5);
});

test("invalid or extreme recipes fail closed", () => {
  const bad = (patch: Record<string, unknown>, message: RegExp) => assert.throws(() => generateTerrainPatch({ ...recipe(), ...patch }, [0, 0]), message);
  bad({ height: { min: 5, max: 5, precision: 0.01 } }, /above height.min/);
  bad({ height: { min: 0, max: Number.NaN, precision: 0.01 } }, /finite/);
  bad({ height: { min: -1000, max: 1000, precision: 0.001 } }, /65535 steps/);
  bad({ height: { min: 50, max: 60, precision: 0.001 } }, /outside the declared range/);
  bad({ samples: [1, 17] }, /samples\[0\]/);
  bad({ detail: [{ ...recipe().detail[0], density: 10 }] }, /packed/);
  bad({ detail: [{ ...recipe().detail[0], paint: "missing" }] }, /undeclared paint/);
  bad({ extra: 1 }, /unknown field/);
  assert.throws(() => generateTerrainPatch(recipe(), [0.5, 0]), /patch\[0\]/);
});

test("every preset generates a valid GLB and PNG height map", async () => {
  for (const preset of Object.values(TERRAIN_PATCH_PRESETS)) {
    const p = generateTerrainPatch(preset, [0, 0]);
    const doc = await new NodeIO().readBinary(await terrainPatchGlb(p));
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    assert.equal(prim.getAttribute("POSITION")!.getCount(), 65 * 65);
    assert.equal(prim.getIndices()!.getCount(), 64 * 64 * 6);
    const png = encodeGrayPng(p.width, p.depth, p.heights);
    assert.equal(png.readUInt8(24), 16);
  }
});
