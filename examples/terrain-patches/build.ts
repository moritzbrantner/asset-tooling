/**
 * Builds a 2×2 grid of terrain patches with masks, meshes and detail into .artifacts/terrain-patches/ (#134).
 * Usage: bun examples/terrain-patches/build.ts [outDir] [recipe.json]. See docs/terrain-patches.md.
 *
 * Rerunning after an edit rebuilds only the components the edit reaches (#139): unchanged components are reused from
 * the previous manifest after their bytes verify. A clean reference build checks that the result matches byte for byte.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../src/canonical.js";
import { sha256Bytes } from "../../src/hash.js";
import {
  TERRAIN_PATCH_BUILD_SCHEMA, buildTerrainPatchFiles, encodeGrayPng, generateTerrainPatch, normalizeTerrainPatchRecipe, scatterTerrainDetail,
  terrainPatchGlb, type TerrainPatchBuildRecord, type Vec2,
} from "../../src/terrain-patch-recipes.js";
import { writeIfChanged } from "../reconcile-file.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(directory, "../../.artifacts/terrain-patches"));
const recipePath = path.resolve(process.argv[3] ?? path.join(directory, "recipe.json"));
const recipe = normalizeTerrainPatchRecipe(JSON.parse(await readFile(recipePath, "utf8")));
const grid: Vec2[] = [[-1, -1], [0, -1], [-1, 0], [0, 0]];
const patchDir = (patch: Vec2) => path.join(outDir, `patch_${patch[0]}_${patch[1]}`);

/** Clean reference path: the whole patch from the recipe, without the component build. */
async function render(patch: Vec2) {
  const p = generateTerrainPatch(recipe, patch), detail = scatterTerrainDetail(p);
  const files: Record<string, Uint8Array> = {
    "height.png": encodeGrayPng(p.width, p.depth, p.heights),
    "slope.png": encodeGrayPng(p.width, p.depth, p.slope),
    "exclusion.png": encodeGrayPng(p.width, p.depth, p.exclusion),
    ...Object.fromEntries(Object.entries(p.paint).map(([name, mask]) => [`paint-${name}.png`, encodeGrayPng(p.width, p.depth, mask)])),
    "mesh.glb": await terrainPatchGlb(p),
    "detail.json": Buffer.from(`${canonicalJson({ schema: "terrain-detail-v1", patch, instances: detail })}\n`),
  };
  return { p, detail, files };
}

// Build in two orders: the bytes must not depend on which neighbour came first.
const forward = await Promise.all(grid.map(render));
const backward = await Promise.all([...grid].reverse().map(render));
backward.reverse();
forward.forEach((f, i) => { for (const name of Object.keys(f.files)) assert.deepEqual(f.files[name], backward[i]!.files[name], `${grid[i]} ${name}`); });

// Shared edges: east column of each western patch equals west column of its neighbour; likewise rows.
const byKey = new Map(forward.map((f) => [f.p.patch.join(","), f.p]));
let seams = 0;
for (const f of forward) {
  const p = f.p, east = byKey.get(`${p.patch[0] + 1},${p.patch[1]}`), south = byKey.get(`${p.patch[0]},${p.patch[1] + 1}`);
  for (let j = 0; east && j < p.depth; j += 1) {
    assert.equal(p.heights[j * p.width + p.width - 1], east.heights[j * east.width]);
    for (let c = 0; c < 3; c += 1) assert.equal(p.normals[(j * p.width + p.width - 1) * 3 + c], east.normals[j * east.width * 3 + c]);
  }
  for (let i = 0; south && i < p.width; i += 1) {
    assert.equal(p.heights[(p.depth - 1) * p.width + i], south.heights[i]);
    for (let c = 0; c < 3; c += 1) assert.equal(p.normals[((p.depth - 1) * p.width + i) * 3 + c], south.normals[i * 3 + c]);
  }
  seams += (east ? 1 : 0) + (south ? 1 : 0);
}
const ids = forward.flatMap((f) => f.detail.map((d) => d.id));
assert.equal(new Set(ids).size, ids.length, "detail IDs are unique across patches");

// Partial rebuild against the previous run's manifest; it must reproduce the reference bytes exactly.
let previousManifest: { patches?: { patch: Vec2; components?: TerrainPatchBuildRecord["components"] }[] } = {};
try { previousManifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8")); } catch { /* first run: build everything */ }
const readOrUndefined = (file: string) => { try { return readFileSync(file); } catch { return undefined; } };
const manifest: Record<string, unknown> = { schema: "terrain-patches-v1", recipe: sha256Bytes(canonicalJson(recipe)), sampleSpacing: recipe.sampleSpacing,
  samples: recipe.samples, height: recipe.height, patches: [] as unknown[] };
const totals = { executed: 0, reused: 0, heightSamples: 0, filesWritten: 0, bytesWritten: 0 };
for (const [i, patch] of grid.entries()) {
  const dir = patchDir(patch), old = previousManifest.patches?.find((p) => p.patch.join(",") === patch.join(","));
  const build = await buildTerrainPatchFiles(recipe, patch, old?.components === undefined ? {} : {
    previous: { record: { schema: TERRAIN_PATCH_BUILD_SCHEMA, patch, components: old.components }, read: (file) => readOrUndefined(path.join(dir, file)) },
  });
  assert.deepEqual(Object.keys(build.files).sort(), Object.keys(forward[i]!.files).sort());
  for (const [name, bytes] of Object.entries(build.files)) assert.deepEqual(Buffer.from(bytes), Buffer.from(forward[i]!.files[name]!), `partial ${patch} ${name}`);
  totals.executed += build.stages.executed.length; totals.reused += build.stages.reused.length; totals.heightSamples += build.heightSamplesEvaluated;
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(build.files)) {
    if (await writeIfChanged(path.join(dir, name), bytes)) { totals.filesWritten += 1; totals.bytesWritten += bytes.byteLength; }
  }
  const counts = Object.fromEntries(recipe.detail.map((l) => [l.id, build.detail.filter((d) => d.layer === l.id).length]));
  (manifest.patches as unknown[]).push({ patch: build.record.patch, origin: forward[i]!.p.origin, firstSample: forward[i]!.p.firstSample, detail: counts,
    files: Object.fromEntries(Object.entries(build.files).map(([n, b]) => [n, sha256Bytes(b)])), components: build.record.components });
}
await writeIfChanged(path.join(outDir, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
console.log(`${forward.length} patches, ${seams} shared edges identical, ${ids.length} detail instances -> ${outDir}`);
console.log(`components: ${totals.executed} executed, ${totals.reused} reused; ${totals.heightSamples} height samples evaluated; `
  + `${totals.filesWritten} files / ${totals.bytesWritten} bytes written; matches the clean reference build`);
