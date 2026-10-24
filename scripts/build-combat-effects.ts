// Build arpg's baked combat flipbooks (#362, docs/combat-effects.md) from the deterministic 2D recipe in
// src/combat-effect-flipbooks.ts:
//   bun scripts/build-combat-effects.ts --out <directory>
// Each effect is one 256×256 atlas PNG (4×4 cells of 64 px, 16 frames), exported as a static-glb-png-v1 package and
// packed to <directory>/combat-effects.tar (+ .sha256), next to the combat-effects-descriptor-v1
// (<directory>/combat-effects.descriptor.json) carrying each atlas layout and its BurstPresets, lineage.json,
// export.ref.json and review boards under <directory>/review/.
import { burstPresetErrors, checkerboard } from "../src/effect-flipbook-raster.ts";
import { buildEffectFlipbookRelease } from "../src/effect-flipbook-release.ts";
import {
  COMBAT_EFFECT_KINDS, COMBAT_EFFECT_LAYOUT, COMBAT_EFFECT_RECIPES, rasterizeCombatEffectAtlas, transparentRgb, type CombatEffectKind,
} from "../src/combat-effect-flipbooks.ts";

export const COMBAT_EFFECTS_DESCRIPTOR_SCHEMA = "combat-effects-descriptor-v1";
export const COMBAT_EFFECTS_DESCRIPTOR_FILE = "combat-effects.descriptor.json";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const COMBAT_EFFECTS_RELEASE = "combat-effects";
export const COMBAT_EFFECT_VARIANT = "arpg";
/** Bundle keys are lowercase tokens, so the camelCase kinds become kebab-case: `blockSpark` is `block-spark.flipbook`. */
export const combatEffectName = (kind: CombatEffectKind) => kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
export const combatEffectKey = (kind: CombatEffectKind) => `${combatEffectName(kind)}.flipbook`;

/** Review backgrounds: checkerboard, arpg's stone floor and its near-black scene background. */
const REVIEW_BACKGROUNDS = [checkerboard, () => [92, 84, 72], () => [17, 16, 15]];

export async function buildCombatEffects({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const { cell, columns, rows, frameCount, width, height, filter } = COMBAT_EFFECT_LAYOUT;
  const parts = COMBAT_EFFECT_KINDS.map((kind) => {
    const recipe = COMBAT_EFFECT_RECIPES[kind];
    for (const [name, preset] of Object.entries(recipe.presets)) {
      const errors = burstPresetErrors(preset);
      if (errors.length) throw new Error(`${kind}/${name} preset: ${errors.join("; ")}`);
    }
    log(`bake ${kind} flipbook (${columns}×${rows}, ${frameCount} frames)`);
    return {
      name: combatEffectName(kind), key: combatEffectKey(kind), variant: COMBAT_EFFECT_VARIANT, layout: COMBAT_EFFECT_LAYOUT,
      pixels: rasterizeCombatEffectAtlas(kind), reviewBackgrounds: REVIEW_BACKGROUNDS,
      describe: (png: { sha256: string; byteLength: number }) => ({
        key: combatEffectKey(kind), variant: COMBAT_EFFECT_VARIANT, role: combatEffectName(kind), description: recipe.description,
        atlas: { width, height, columns, rows, frameCount, filter, cell, colorSpace: "srgb", alpha: "straight", rowOrder: "top-first", transparentRgb: [...transparentRgb(kind)] },
        png, scale: recipe.scale, presets: recipe.presets, ...(recipe.instances ? { instances: recipe.instances } : {}),
      }),
    };
  });
  return buildEffectFlipbookRelease({
    outDir, release: COMBAT_EFFECTS_RELEASE, recipeSource: "src/combat-effect-flipbooks.ts", descriptorFile: COMBAT_EFFECTS_DESCRIPTOR_FILE, parts, log,
    descriptor: (effects) => ({
      schema: COMBAT_EFFECTS_DESCRIPTOR_SCHEMA, units: { time: "second", distance: "metre" }, up: "+Y",
      renderer: "three-d-renderer frame.effects", effects,
    }),
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: bun scripts/build-combat-effects.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildCombatEffects({ outDir: args[1]!, log: (line) => console.error(`[combat-effects] ${line}`) });
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, descriptor: result.descriptorPath, reviews: result.reviews, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
