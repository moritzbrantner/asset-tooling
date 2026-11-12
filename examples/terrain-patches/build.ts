/**
 * Builds a 2×2 grid of terrain patches with masks, meshes and detail into .artifacts/terrain-patches/ (#134).
 * Usage: bun examples/terrain-patches/build.ts [outDir]. See docs/terrain-patches.md.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../src/canonical.js";
import { sha256Bytes } from "../../src/hash.js";
import {
  encodeGrayPng, generateTerrainPatch, normalizeTerrainPatchRecipe, scatterTerrainDetail, terrainPatchGlb, type Vec2,
} from "../../src/terrain-patch-recipes.js";
import { writeIfChanged } from "../reconcile-file.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(directory, "../../.artifacts/terrain-patches"));
const recipe = normalizeTerrainPatchRecipe(JSON.parse(await readFile(path.join(directory, "recipe.json"), "utf8")));
const grid: Vec2[] = [[-1, -1], [0, -1], [-1, 0], [0, 0]];

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

const manifest: Record<string, unknown> = { schema: "terrain-patches-v1", recipe: sha256Bytes(canonicalJson(recipe)), sampleSpacing: recipe.sampleSpacing,
  samples: recipe.samples, height: recipe.height, patches: [] as unknown[] };
for (const { p, detail, files } of forward) {
  const dir = path.join(outDir, `patch_${p.patch[0]}_${p.patch[1]}`);
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeIfChanged(path.join(dir, name), bytes);
  const counts = Object.fromEntries(recipe.detail.map((l) => [l.id, detail.filter((d) => d.layer === l.id).length]));
  (manifest.patches as unknown[]).push({ patch: p.patch, origin: p.origin, firstSample: p.firstSample, detail: counts,
    files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha256Bytes(b)])) });
}
await writeIfChanged(path.join(outDir, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
console.log(`${forward.length} patches, ${seams} shared edges identical, ${ids.length} detail instances -> ${outDir}`);
