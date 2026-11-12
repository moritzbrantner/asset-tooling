// Terrain workbench (#127, docs/terrain-workbench.md): the page runs the terrain recipe's own component build, reuses
// unchanged components, refuses to change kept ones without losing its previous build, and its browser shims for
// node:zlib and node:crypto produce the same hashes and samples as Node's.
import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { crc32 as nodeCrc32, inflateSync as nodeInflate } from "node:zlib";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import exampleRecipe from "../examples/terrain-patches/recipe.json";
import {
  buildTerrainPatchFiles, generateTerrainPatch, normalizeTerrainPatchRecipe, terrainPatchComponentKeys, TERRAIN_PATCH_PRESETS,
  type TerrainPatchRecipe,
} from "../src/terrain-patch-recipes.js";
import { TerrainWorkbenchSession } from "../src/browser/terrain-workbench-compute.js";
import {
  changedComponents, componentIdentities, decodeTerrainParam, encodeTerrainParam, reseedTerrainRecipe, TERRAIN_WORKBENCH_GRID,
  terrainComponentNames, terrainFieldForError, terrainFormFields, terrainWorkbenchRecipe,
} from "../src/browser/terrain-workbench-state.js";
import { crc32, deflateSync, inflateSync } from "../src/browser/node-zlib-shim.js";
import { createHash as shimCreateHash } from "../src/browser/node-crypto-shim.js";
import { renderTerrainWorkbenchHtml, writeTerrainWorkbenchPage } from "../src/terrain-workbench-page.js";

/** The example hillside at 17×17 samples per patch, so the suite stays fast. */
const small = (overrides: Record<string, unknown> = {}): TerrainPatchRecipe =>
  terrainWorkbenchRecipe({ ...structuredClone(exampleRecipe), samples: [17, 17], sampleSpacing: 4, ...overrides });

test("schema 1 recipes become schema 2 with the same component keys", () => {
  const schema1 = normalizeTerrainPatchRecipe({ ...structuredClone(exampleRecipe), samples: [17, 17] });
  const schema2 = terrainWorkbenchRecipe(schema1);
  expect(schema2.schemaVersion).toBe(2);
  expect(schema2.detail.every((layer) => layer.seed === schema1.seed)).toBe(true);
  for (const patch of TERRAIN_WORKBENCH_GRID) expect(terrainPatchComponentKeys(schema2, patch)).toEqual(terrainPatchComponentKeys(schema1, patch));
});

test("the session builds the CLI grid byte for byte and reruns only components an edit reaches", async () => {
  const session = new TerrainWorkbenchSession();
  const base = small();
  const first = await session.run(base);
  expect(first.map((p) => p.patch)).toEqual(TERRAIN_WORKBENCH_GRID.map((p) => [...p]));
  for (const built of first) {
    const cold = await buildTerrainPatchFiles(base, built.patch);
    expect(built.record).toEqual(cold.record);
    const reference = generateTerrainPatch(base, built.patch);
    expect(built.heights).toEqual(reference.heights);
    expect(built.paint.meadow).toEqual(reference.paint.meadow!);
    expect(built.stages.reused).toEqual([]);
  }
  const moved = { ...base, paint: { meadow: [{ kind: "circle" as const, center: [-10, 36] as [number, number], radius: 26, falloff: 14 }] } };
  const second = await session.run(moved);
  for (const built of second) {
    expect(built.stages.executed).toEqual(["paint.meadow", "detail.flowers", "detail"]);
    expect(built.heightSamplesEvaluated).toBe(0);
    expect(built.record).toEqual((await buildTerrainPatchFiles(moved, built.patch)).record);
  }
  const reseeded = reseedTerrainRecipe(moved, new Set(["seed", "detail.1.seed", "detail.2.seed"]), () => 7);
  expect(reseeded.detail.map((layer) => layer.seed)).toEqual([7, 134, 134]);
  const third = await session.run(reseeded);
  expect(third[0]!.stages.executed).toEqual(["detail.grass", "detail"]);
  expect(changedComponents(componentIdentities(second.map((p) => p.record)), componentIdentities(third.map((p) => p.record))))
    .toEqual(["detail", "detail.grass"]);
});

test("a kept component refuses the edit and the previous build stays the basis", async () => {
  const session = new TerrainWorkbenchSession();
  const base = small();
  await session.run(base);
  const louder = { ...base, noise: { ...base.noise, amplitude: 10 } };
  await expect(session.run(louder, ["height"])).rejects.toThrow(/terrain component 'height' cannot be preserved: its inputs changed/);
  // Undo: the base recipe again reuses everything, so the refused build left nothing behind.
  const again = await session.run(base, ["height"]);
  expect(again.every((p) => p.stages.executed.length === 0)).toBe(true);
});

test("URL state round-trips and rejects invalid values", () => {
  const recipe = small();
  const encoded = encodeTerrainParam(recipe);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeTerrainParam(encoded)).toEqual(recipe);
  expect(decodeTerrainParam(null)).toBeUndefined();
  expect(decodeTerrainParam("%%%")).toBeUndefined();
  expect(decodeTerrainParam(encodeTerrainParam({ ...recipe, samples: [1, 17] }))).toBeUndefined();
});

test("validation messages point at their field", () => {
  const recipe = small();
  const fields = terrainFormFields(recipe);
  const layer = (overrides: Record<string, unknown>) => ({ detail: recipe.detail.map((l, i) => (i === 1 ? { ...l, ...overrides } : l)) });
  const cases: [Record<string, unknown>, string | undefined][] = [
    [{ noise: { ...recipe.noise, octaves: 12 } }, "noise.octaves"],
    [{ height: { ...recipe.height, max: -9 } }, "height.max"],
    [{ height: { min: 0, max: 100, precision: 0.0001 } }, "height.min"],
    [{ samples: [1, 17] }, "samples.0"],
    [{ origin: [0, "x"] }, "origin.1"],
    [{ id: "Bad Id" }, "id"],
    [{ seed: -1 }, "seed"],
    [{ edits: [{ kind: "flatten", shape: { kind: "circle", center: [0, 0], radius: -1, falloff: 1 }, height: 0, excludeDetail: false }] }, "edits"],
    [{ paint: { "Bad Key": [] } }, "paint"],
    [{ exclusions: [{ kind: "blob" }] }, "exclusions"],
    [layer({ slopeDegrees: [30, 10] }), "detail.1.slopeDegrees.0"],
    [layer({ scale: [1, 0] }), "detail.1.scale.1"],
    [layer({ density: 50 }), "detail.1.density"],
    [layer({ paint: "nowhere" }), "detail.1.paint"],
    [layer({ id: "grass" }), undefined],
  ];
  for (const [overrides, field] of cases) {
    let message = "";
    try { terrainWorkbenchRecipe({ ...recipe, ...overrides }); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe("");
    expect(terrainFieldForError(message, fields)).toBe(field);
  }
  expect(terrainFieldForError("edits is not valid JSON: Unexpected token", fields)).toBe("edits");
  const island = terrainWorkbenchRecipe({ ...TERRAIN_PATCH_PRESETS.island });
  expect(terrainFieldForError("shaping.radius must be a finite number in 0..1000000", terrainFormFields(island))).toBe("shaping.radius");
  expect(terrainComponentNames(recipe)).toEqual(["height", "exclusion", "paint.meadow", "detail.grass", "detail.flowers", "detail.stones", "detail"]);
});

test("the browser zlib and sha256 shims match Node", () => {
  for (const size of [0, 1, 55, 56, 64, 1000, 70000]) {
    const bytes = new Uint8Array(randomBytes(size));
    expect(shimCreateHash("sha256").update(bytes).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(crc32(bytes)).toBe(nodeCrc32(bytes));
    const packed = deflateSync(bytes, { level: 9 });
    expect(new Uint8Array(nodeInflate(packed))).toEqual(bytes);
    expect(new Uint8Array(inflateSync(packed))).toEqual(bytes);
  }
  expect(shimCreateHash("sha256").update("grün").digest("hex")).toBe(createHash("sha256").update("grün").digest("hex"));
  expect(() => shimCreateHash("md5")).toThrow(/only sha256/);
});

test("the page has its controls and its bundles build without Node imports", async () => {
  const html = renderTerrainWorkbenchHtml();
  for (const id of ["recipe", "components", "accept", "reset", "undo", "redo", "cancel", "export-recipe", "add-layer", "reseed-all"]) expect(html).toContain(`id="${id}"`);
  const outDir = await mkdtemp(path.join(os.tmpdir(), "terrain-workbench-page-"));
  try {
    await writeTerrainWorkbenchPage({ repositoryRoot: path.resolve(import.meta.dir, ".."), outDir });
    for (const name of ["index.html", "app.js", "worker.js"]) expect((await stat(path.join(outDir, name))).size).toBeGreaterThan(0);
    for (const name of ["app.js", "worker.js"]) expect(await readFile(path.join(outDir, name), "utf8")).not.toMatch(/(from\s*|import\s*\(\s*)"node:/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
