// Mipmap evidence for the tileable surface presets (#131, docs/surface-textures.md#mipmaps):
//   bun examples/surface-textures/mipmaps.ts [preset ...]
// For every preset (or the named ones) and channel it writes `<preset>-<channel>.ktx2` (full mip chain, wrapped
// filtering) into the ignored .artifacts/surface-textures/mipmaps/ and records each level's periodicity error
// against the ktx default (clamp) in mipmaps.json. sheet-<preset>.png shows levels 64² to 8² of the normal channel
// tiled 3x3: wrapped, clamped, and their difference amplified eight times. Needs KTX-Software's `ktx` and FFmpeg.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS, type SurfaceChannel } from "../../src/surface-texture-recipes.js";
import { surfaceMipPeriodicity } from "../../src/surface-texture-mipmaps.js";
import { executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { resolveAssetObject, storeAssetObject } from "../../src/asset-store.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "../../src/image-rgba8.js";
import { createAssetRef } from "../../src/operations.js";
import { canonicalJson } from "../../src/canonical.js";
import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, ".artifacts/surface-textures/mipmaps");
await mkdir(directory, { recursive: true });
const presets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SURFACE_TEXTURE_PRESETS);
const SHEET_LEVELS = [2, 3, 4, 5], CELL = 192, SHEET_CHANNEL: SurfaceChannel = "normal";

/** The level tiled 3x3 and scaled by nearest neighbour to CELL x CELL. */
function tiled(level: Rgba8Image, into: Uint8Array, stride: number, ox: number, oy: number) {
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const sx = Math.floor((x * 3 * level.width) / CELL) % level.width, sy = Math.floor((y * 3 * level.height) / CELL) % level.height;
    into.set(level.pixels.subarray((sy * level.width + sx) * 4, (sy * level.width + sx) * 4 + 4), ((oy + y) * stride + ox + x) * 4);
  }
}

/** |a - b| per colour byte, amplified eight times on black, so the texels where the two chains differ stand out. */
function difference(a: Rgba8Image, b: Rgba8Image): Rgba8Image {
  const pixels = new Uint8Array(a.pixels.length);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4 === 3 ? 255 : Math.min(255, 8 * Math.abs(a.pixels[i]! - b.pixels[i]!));
  return { width: a.width, height: a.height, pixels };
}

const evidence: Record<string, Record<string, unknown>> = {};
for (const id of presets) {
  const recipe = SURFACE_TEXTURE_PRESETS[id as keyof typeof SURFACE_TEXTURE_PRESETS];
  if (!recipe) throw new Error(`unknown surface preset '${id}'`);
  const result = await executeSurfaceTextureRecipe(root, recipe);
  evidence[id] = {};
  const sheetRows: Rgba8Image[][] = [];
  for (const [channel, source] of Object.entries(result.outputs) as [SurfaceChannel, NonNullable<(typeof result.outputs)[SurfaceChannel]>][]) {
    const wrap = await surfaceMipPeriodicity(root, { source, channel, mipmapWrap: "wrap" });
    const clamp = await surfaceMipPeriodicity(root, { source, channel, mipmapWrap: "clamp" });
    await writeIfChanged(path.join(directory, `${id}-${channel}.ktx2`), Buffer.from(wrap.ktx2.bytes));
    evidence[id]![channel] = {
      bytes: wrap.ktx2.bytes.length,
      levels: wrap.levels.map((level, index) => ({ ...level, clampMaxError: clamp.levels[index]!.maxError })),
    };
    if (channel === SHEET_CHANNEL) sheetRows.push(SHEET_LEVELS.map((l) => wrap.ktx2.levels[l]!), SHEET_LEVELS.map((l) => clamp.ktx2.levels[l]!),
      SHEET_LEVELS.map((l) => difference(wrap.ktx2.levels[l]!, clamp.ktx2.levels[l]!)));
  }
  if (sheetRows.length) {
    const width = SHEET_LEVELS.length * CELL + (SHEET_LEVELS.length - 1) * 8, height = sheetRows.length * CELL + (sheetRows.length - 1) * 8;
    const pixels = new Uint8Array(width * height * 4).fill(255);
    sheetRows.forEach((row, r) => row.forEach((level, c) => tiled(level, pixels, width, c * (CELL + 8), r * (CELL + 8))));
    const source = (await storeAssetObject(root, { bytes: encodeRgba8Image({ width, height, pixels }), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE })).asset;
    const png = createAssetRef((await executeImageEncodePngOperation(root, { inputs: { source }, parameters: { compressionLevel: 9 } })).outputs.output);
    await writeIfChanged(path.join(directory, `sheet-${id}.png`), await resolveAssetObject(root, png));
  }
}
await writeIfChanged(path.join(directory, "mipmaps.json"), Buffer.from(canonicalJson(evidence as never) + "\n"));
console.log(JSON.stringify({ directory, presets }));
