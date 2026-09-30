import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { canonicalJson } from "../../src/canonical.js";
import { resolveAssetObject } from "../../src/asset-store.js";
import { parseRgba8Image } from "../../src/image-rgba8.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import { executeSpriteAtlasOperation } from "../../src/sprite-atlas-operations.js";
import { createProceduralCircleSdfOperationBuildIdentity, createProceduralRoundedRectSdfOperationBuildIdentity,
  executeProceduralCircleSdfOperation, executeProceduralRoundedRectSdfOperation } from "../../src/procedural-shape-operations.js";
import { createImageLevelsOperationBuildIdentity, executeImageLevelsOperation } from "../../src/image-filter-operations.js";
import { createScalarColorRampOperationBuildIdentity, executeScalarColorRampOperation } from "../../src/surface-texture-recipes.js";
import { createImageMaskApplyOperationBuildIdentity, executeImageMaskApplyOperation } from "../../src/image-advanced-operations.js";
import { createImageEncodePngOperationBuildIdentity, executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, ".artifacts/sprite-atlas");
await mkdir(directory, { recursive: true });
const steps: { build: unknown; output: AssetRef }[] = [];
async function shape(geometry: { kind: "circle"; radius: number } | { kind: "tile"; halfSize: number; cornerRadius: number }) {
  const common = { width: 64, height: 64, centerX: 32, centerY: 32, spread: 8 };
  if (geometry.kind === "circle") {
    const invocation = { parameters: { ...common, radius: geometry.radius } };
    const build = await createProceduralCircleSdfOperationBuildIdentity(invocation);
    const output = createAssetRef((await executeProceduralCircleSdfOperation(root, invocation)).outputs.output);
    steps.push({ build, output }); return output;
  }
  const invocation = { parameters: { ...common, halfWidth: geometry.halfSize, halfHeight: geometry.halfSize, cornerRadius: geometry.cornerRadius } };
  const build = await createProceduralRoundedRectSdfOperationBuildIdentity(invocation);
  const output = createAssetRef((await executeProceduralRoundedRectSdfOperation(root, invocation)).outputs.output);
  steps.push({ build, output }); return output;
}
async function coverage(source: AssetRef, invert = false) {
  // Existing SDF uses 128 at the boundary, darker inside. A narrow ramp preserves edge alpha.
  const invocation = { inputs: { source }, parameters: { blackPoint: 120, whitePoint: 136, outputBlack: 0, outputWhite: 255 } };
  const build = await createImageLevelsOperationBuildIdentity(root, invocation);
  const output = createAssetRef((await executeImageLevelsOperation(root, invocation)).outputs.output);
  steps.push({ build, output }); return invert ? output : ramp(output, [255, 255, 255], [0, 0, 0]);
}
async function mask(source: AssetRef, alpha: AssetRef) {
  const invocation = { inputs: { source, mask: alpha }, parameters: { channel: "luma" } };
  const build = await createImageMaskApplyOperationBuildIdentity(root, invocation);
  const output = createAssetRef((await executeImageMaskApplyOperation(root, invocation)).outputs.output);
  steps.push({ build, output }); return output;
}
async function ramp(source: AssetRef, low: [number, number, number], high: [number, number, number]) {
  const invocation = { inputs: { source }, parameters: { low, high } };
  const build = await createScalarColorRampOperationBuildIdentity(root, invocation);
  const output = createAssetRef((await executeScalarColorRampOperation(root, invocation)).outputs.output);
  steps.push({ build, output }); return output;
}
const sprites: { id: string; source: AssetRef }[] = [];
for (const recipe of [
  { id: "floor", geometry: { kind: "tile", halfSize: 29, cornerRadius: 3 }, rgb: [223, 214, 195] },
  { id: "wall", geometry: { kind: "tile", halfSize: 29, cornerRadius: 3 }, rgb: [69, 79, 87] },
  { id: "crate", geometry: { kind: "tile", halfSize: 19, cornerRadius: 3 }, rgb: [191, 114, 48] },
  { id: "player", geometry: { kind: "circle", radius: 13 }, rgb: [38, 89, 130] },
  { id: "target", geometry: { kind: "circle", radius: 22 }, rgb: [38, 89, 130] },
] as const) {
  const field = await shape(recipe.geometry), alpha = await coverage(field);
  let source = await mask(await ramp(field, [...recipe.rgb], [...recipe.rgb]), alpha);
  if (recipe.id === "target") source = await mask(source, await coverage(await shape({ kind: "circle", radius: 17 }), true));
  const actual = parseRgba8Image(await resolveAssetObject(root, source));
  if (actual.pixels[3] !== 0 || actual.pixels[(32 * 64 + 32) * 4 + 3] !== (recipe.id === "target" ? 0 : 255)) throw new Error(`unexpected coverage for ${recipe.id}`);
  sprites.push({ id: recipe.id, source });
}
const pngs: Record<string, AssetRef> = {};
async function png(id: string, source: AssetRef) {
  const invocation = { inputs: { source }, parameters: { compressionLevel: 9 } };
  const build = await createImageEncodePngOperationBuildIdentity(root, invocation);
  const output = createAssetRef((await executeImageEncodePngOperation(root, invocation)).outputs.output);
  steps.push({ build, output }); pngs[id] = output;
  await writeIfChanged(path.join(directory, `${id}.png`), await resolveAssetObject(root, output));
}
for (const sprite of sprites) await png(sprite.id, sprite.source);
const atlas = await executeSpriteAtlasOperation(root, {
  parameters: { width: 256, maxHeight: 256, padding: 2, extrusion: 1, trim: true,
    sprites: sprites.map(s => ({ id: s.id, pivot: { x: 32, y: 32 } })) },
  inputs: { sprites: sprites.map(s => s.source) },
});
await png("atlas", createAssetRef(atlas.outputs.image));
await writeIfChanged(path.join(directory, "atlas.json"), await resolveAssetObject(root, atlas.outputs.manifest));
await writeIfChanged(path.join(directory, "evidence.json"), Buffer.from(`${canonicalJson({ sprites, pngs, steps, atlas })}\n`));
console.log(JSON.stringify({ directory, sprites: sprites.map(s => s.id) }));
