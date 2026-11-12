// Editable SVG vocabulary → derived transparent PNGs at several sizes → one sprite atlas (docs/vector-artwork.md).
// Outputs are disposable under .artifacts/vector-artwork/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { canonicalJson } from "../../src/canonical.js";
import { resolveAssetObject } from "../../src/asset-store.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import {
  createProceduralRingVectorOperationBuildIdentity, createProceduralRoundedRectVectorOperationBuildIdentity,
  createProceduralStarVectorOperationBuildIdentity, executeProceduralRingVectorOperation,
  executeProceduralRoundedRectVectorOperation, executeProceduralStarVectorOperation,
} from "../../src/procedural-shape-operations.js";
import { createVectorRasterizeOperationBuildIdentity, executeVectorRasterizeOperation } from "../../src/vector-rasterize-operations.js";
import { createImageEncodePngOperationBuildIdentity, executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { executeSpriteAtlasOperation } from "../../src/sprite-atlas-operations.js";
import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, ".artifacts/vector-artwork");
await mkdir(directory, { recursive: true });
const steps: { build: unknown; output: AssetRef }[] = [];
const canvas = { width: 64, height: 64 };

type Recipe = { id: string; operation: "rounded-rect" | "ring" | "star"; parameters: Record<string, unknown> };
const recipes: Recipe[] = [
  // Puzzle tile: a floor slab with a rounded corner; the slab, not its colour, carries the "walkable" cue.
  { id: "tile", operation: "rounded-rect", parameters: { ...canvas, x: 2, y: 2, rectWidth: 60, rectHeight: 60, cornerRadius: 8, fill: "#d8cdb4" } },
  // Target ring: hollow, so it reads differently from a filled token even in greyscale.
  { id: "ring", operation: "ring", parameters: { ...canvas, centerX: 32, centerY: 32, radius: 22, strokeWidth: 8, stroke: "#2f6f9f" } },
  // Reward burst: many sharp points with a shallow inner radius.
  { id: "burst", operation: "star", parameters: { ...canvas, centerX: 32, centerY: 32, points: 12, outerRadius: 30, innerRadius: 19, rotationDegrees: 0, fill: "#f2c230", stroke: "none", strokeWidth: 0, strokeJoin: "miter" } },
  // Token/icon: a five-point star with a dark round-joined outline for contrast on light and dark backgrounds.
  { id: "star", operation: "star", parameters: { ...canvas, centerX: 32, centerY: 34, points: 5, outerRadius: 26, innerRadius: 11, rotationDegrees: 0, fill: "#f7d548", stroke: "#5a3b12", strokeWidth: 4, strokeJoin: "round" } },
];
const generators = {
  "rounded-rect": [createProceduralRoundedRectVectorOperationBuildIdentity, executeProceduralRoundedRectVectorOperation],
  ring: [createProceduralRingVectorOperationBuildIdentity, executeProceduralRingVectorOperation],
  star: [createProceduralStarVectorOperationBuildIdentity, executeProceduralStarVectorOperation],
} as const;

async function png(name: string, source: AssetRef) {
  const invocation = { inputs: { source }, parameters: { compressionLevel: 9 } };
  const build = await createImageEncodePngOperationBuildIdentity(root, invocation);
  const output = createAssetRef((await executeImageEncodePngOperation(root, invocation)).outputs.output);
  steps.push({ build, output });
  await writeIfChanged(path.join(directory, `${name}.png`), await resolveAssetObject(root, output));
  return output;
}

const sizes = [32, 64, 128];
const sprites: { id: string; source: AssetRef }[] = [];
for (const recipe of recipes) {
  const [createBuild, execute] = generators[recipe.operation];
  const invocation = { parameters: recipe.parameters };
  const svg = createAssetRef((await execute(root, invocation)).outputs.output);
  steps.push({ build: await createBuild(invocation), output: svg });
  await writeIfChanged(path.join(directory, `${recipe.id}.svg`), await resolveAssetObject(root, svg));
  for (const size of sizes) {
    const rasterize = { inputs: { source: svg }, parameters: { width: size, height: size, padding: 2 } };
    const output = createAssetRef((await executeVectorRasterizeOperation(root, rasterize)).outputs.output);
    steps.push({ build: await createVectorRasterizeOperationBuildIdentity(root, rasterize), output });
    await png(`${recipe.id}-${size}`, output);
    if (size === 64) sprites.push({ id: recipe.id, source: output });
  }
}
const atlas = await executeSpriteAtlasOperation(root, {
  parameters: {
    width: 256, maxHeight: 256, padding: 2, extrusion: 1, trim: true,
    sprites: sprites.map((sprite) => ({ id: sprite.id, pivot: { x: 34, y: 34 } })),
  },
  inputs: { sprites: sprites.map((sprite) => sprite.source) },
});
await png("atlas", createAssetRef(atlas.outputs.image));
await writeIfChanged(path.join(directory, "atlas.json"), await resolveAssetObject(root, atlas.outputs.manifest));
await writeIfChanged(path.join(directory, "evidence.json"), Buffer.from(`${canonicalJson({ steps, atlas })}\n`));
console.log(JSON.stringify({ directory, sprites: sprites.map((sprite) => sprite.id), sizes }));
