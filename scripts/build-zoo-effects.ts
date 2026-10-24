// Build Zoo's baked particle flipbooks (#136 slice 1, docs/zoo-effects.md) from the deterministic 2D recipe in
// src/zoo-effect-flipbooks.ts:
//   bun scripts/build-zoo-effects.ts --out <directory>
// Each effect is one 256×256 atlas PNG (4×4 cells of 64 px, 16 frames). The PNGs are exported as the
// static-glb-png-v1 package (the zoo-scenery format), packed to <directory>/zoo-effects.tar (+ .sha256), next to
// the zoo-effects-descriptor-v1 (<directory>/zoo-effects.descriptor.json) carrying each atlas layout and its
// BurstPresets, lineage.json, export.ref.json and review boards under <directory>/review/.
import { burstPresetErrors, checkerboard } from "../src/effect-flipbook-raster.ts";
import { buildEffectFlipbookRelease } from "../src/effect-flipbook-release.ts";
import {
  ZOO_EFFECT_KINDS, ZOO_EFFECT_LAYOUT, ZOO_EFFECT_RECIPES, rasterizeZooEffectAtlas, transparentRgb, type ZooEffectKind,
} from "../src/zoo-effect-flipbooks.ts";

export const ZOO_EFFECTS_DESCRIPTOR_SCHEMA = "zoo-effects-descriptor-v1";
export const ZOO_EFFECTS_DESCRIPTOR_FILE = "zoo-effects.descriptor.json";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const ZOO_EFFECTS_RELEASE = "zoo-effects";
export const ZOO_EFFECT_VARIANT = "toy";
export const zooEffectKey = (kind: ZooEffectKind) => `${kind}.flipbook`;

export async function buildZooEffects({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const { cell, columns, rows, frameCount, width, height, filter } = ZOO_EFFECT_LAYOUT;
  const parts = ZOO_EFFECT_KINDS.map((kind) => {
    const recipe = ZOO_EFFECT_RECIPES[kind];
    for (const [name, preset] of Object.entries(recipe.presets)) {
      const errors = burstPresetErrors(preset);
      if (errors.length) throw new Error(`${kind}/${name} preset: ${errors.join("; ")}`);
    }
    log(`bake ${kind} flipbook (${columns}×${rows}, ${frameCount} frames)`);
    return {
      name: kind, key: zooEffectKey(kind), variant: ZOO_EFFECT_VARIANT, layout: ZOO_EFFECT_LAYOUT, pixels: rasterizeZooEffectAtlas(kind),
      reviewBackgrounds: [checkerboard, () => [126, 187, 90], () => [38, 44, 52]],
      describe: (png: { sha256: string; byteLength: number }) => ({
        key: zooEffectKey(kind), variant: ZOO_EFFECT_VARIANT, role: kind, description: recipe.description,
        atlas: { width, height, columns, rows, frameCount, filter, cell, colorSpace: "srgb", alpha: "straight", rowOrder: "top-first", transparentRgb: [...transparentRgb(kind)] },
        png, scale: recipe.scale, presets: recipe.presets,
      }),
    };
  });
  return buildEffectFlipbookRelease({
    outDir, release: ZOO_EFFECTS_RELEASE, recipeSource: "src/zoo-effect-flipbooks.ts", descriptorFile: ZOO_EFFECTS_DESCRIPTOR_FILE, parts, log,
    descriptor: (effects) => ({ schema: ZOO_EFFECTS_DESCRIPTOR_SCHEMA, units: { time: "second", distance: "metre" }, up: "+Y", renderer: "three-d-renderer frame.effects.bursts", effects }),
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: bun scripts/build-zoo-effects.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildZooEffects({ outDir: args[1]!, log: (line) => console.error(`[zoo-effects] ${line}`) });
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, descriptor: result.descriptorPath, reviews: result.reviews, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
