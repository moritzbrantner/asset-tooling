// Build ui's reward-feedback flipbooks (part of #136, ui#60, docs/reward-effects.md) from the deterministic 2D recipe
// in src/reward-effect-flipbooks.ts:
//   bun scripts/build-reward-effects.ts --out <directory>
// Each effect variant is one 1024×64 white alpha-mask strip PNG (16 frames of 64 px), exported as a static-glb-png-v1
// package and packed to <directory>/reward-effects.tar (+ .sha256), next to the reward-effects-descriptor-v1
// (<directory>/reward-effects.descriptor.json), lineage.json, export.ref.json and tinted review boards under
// <directory>/review/.
import { checkerboard } from "../src/effect-flipbook-raster.ts";
import { buildEffectFlipbookRelease } from "../src/effect-flipbook-release.ts";
import {
  MASK_RGB, REWARD_EFFECT_KINDS, REWARD_EFFECT_LAYOUT, REWARD_EFFECT_RECIPES, REWARD_EFFECT_VARIANTS, rasterizeRewardEffectStrip, tintMask,
} from "../src/reward-effect-flipbooks.ts";

export const REWARD_EFFECTS_DESCRIPTOR_SCHEMA = "reward-effects-descriptor-v1";
export const REWARD_EFFECTS_DESCRIPTOR_FILE = "reward-effects.descriptor.json";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const REWARD_EFFECTS_RELEASE = "reward-effects";
export const rewardEffectKey = (kind: string) => `${kind}.flipbook`;

/** Review tint, close to ui's Pop primary, on a checkerboard, a light page and a dark page. */
const REVIEW_TINT = [112, 82, 236] as const;
const REVIEW_BACKGROUNDS = [checkerboard, () => [250, 250, 252], () => [20, 20, 26]];

export async function buildRewardEffects({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const { cell, columns, rows, frameCount, width, height, filter } = REWARD_EFFECT_LAYOUT;
  const parts = REWARD_EFFECT_KINDS.flatMap((kind) => REWARD_EFFECT_VARIANTS.map((variant) => {
    const recipe = REWARD_EFFECT_RECIPES[kind];
    log(`bake ${kind}/${variant} strip (${columns}×${rows}, ${frameCount} frames)`);
    const pixels = rasterizeRewardEffectStrip(kind, variant);
    return {
      name: `${kind}-${variant}`, key: rewardEffectKey(kind), variant, layout: REWARD_EFFECT_LAYOUT, pixels,
      reviewPixels: tintMask(pixels, REVIEW_TINT), reviewBackgrounds: REVIEW_BACKGROUNDS,
      describe: (png: { sha256: string; byteLength: number }) => ({
        key: rewardEffectKey(kind), variant, role: kind, description: recipe.description,
        atlas: { width, height, columns, rows, frameCount, filter, cell, colorSpace: "srgb", alpha: "straight", rowOrder: "top-first", transparentRgb: [...MASK_RGB] },
        png, cssSize: recipe.cssSize[variant],
      }),
    };
  }));
  return buildEffectFlipbookRelease({
    outDir, release: REWARD_EFFECTS_RELEASE, recipeSource: "src/reward-effect-flipbooks.ts", descriptorFile: REWARD_EFFECTS_DESCRIPTOR_FILE, parts, log,
    descriptor: (effects) => ({
      schema: REWARD_EFFECTS_DESCRIPTOR_SCHEMA, consumer: "ui Pop/Pulse reward feedback", tint: "alpha-mask",
      playback: { loop: false, frameTime: "(k + 0.5) / frameCount", lastFrame: "blank" }, reducedMotion: "omit", effects,
    }),
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: bun scripts/build-reward-effects.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildRewardEffects({ outDir: args[1]!, log: (line) => console.error(`[reward-effects] ${line}`) });
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, descriptor: result.descriptorPath, reviews: result.reviews, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
