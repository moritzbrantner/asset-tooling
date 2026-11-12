// Staged surface-texture computation for the texture workbench (#127, docs/texture-workbench.md). It runs the same
// kernels as `asset-tooling/recipes/surface-textures` and keeps the last result of each stage, so a palette edit
// recolours the kept height instead of regenerating noise, as the recipe's explicit preservation path does.
import { canonicalJson } from "../canonical.js";
import type { Rgba8Image } from "../image-rgba8.js";
import { deriveNormalMapRgba8, generateTileableHeightMapRgba8 } from "../procedural-textures.js";
import {
  composeSurfaceHeightRgba8, scalarColorRampRgba8, surfaceHeightComponentParameters, surfaceRecipeHeightParameters,
  type SurfaceTextureRecipe,
} from "../surface-texture-kernels.js";

export const TEXTURE_CHANNELS = ["color", "height", "normal", "roughness"] as const;
export type TextureChannel = (typeof TEXTURE_CHANNELS)[number];
export type StageStatus = { channel: TextureChannel; status: "executed" | "reused" };

type Kept = { key: string; image: Rgba8Image };

/** Stage keys: each lists exactly the recipe fields its operation consumes, plus its height dependency. */
export function textureStageKeys(recipe: SurfaceTextureRecipe): Record<TextureChannel, string> {
  const height = canonicalJson(surfaceRecipeHeightParameters(recipe));
  return {
    height,
    color: canonicalJson({ height, low: recipe.low, high: recipe.high }),
    normal: canonicalJson({ height, strength: recipe.normalStrength, wrap: true }),
    roughness: canonicalJson({ height, low: recipe.roughnessMin, high: recipe.roughnessMax }),
  };
}

export class TextureWorkbenchSession {
  #kept: Partial<Record<TextureChannel, Kept>> = {};

  /** Computes every channel of a normalized recipe, reusing a stage whose inputs did not change. */
  run(recipe: SurfaceTextureRecipe): { images: Record<TextureChannel, Rgba8Image>; stages: StageStatus[] } {
    const keys = textureStageKeys(recipe);
    const stages: StageStatus[] = [];
    const stage = (channel: TextureChannel, compute: () => Rgba8Image) => {
      const kept = this.#kept[channel];
      if (kept && kept.key === keys[channel]) {
        stages.push({ channel, status: "reused" });
        return kept.image;
      }
      const image = compute();
      this.#kept[channel] = { key: keys[channel], image };
      stages.push({ channel, status: "executed" });
      return image;
    };
    const height = stage("height", () => {
      const p = surfaceRecipeHeightParameters(recipe);
      const [coarse, detail] = surfaceHeightComponentParameters(p).map((c) => generateTileableHeightMapRgba8(c));
      return composeSurfaceHeightRgba8(p, coarse!, detail);
    });
    const color = stage("color", () => scalarColorRampRgba8(height, { low: recipe.low, high: recipe.high }));
    const normal = stage("normal", () => deriveNormalMapRgba8(height, { strength: recipe.normalStrength, wrap: true }));
    const roughness = stage("roughness", () => scalarColorRampRgba8(height, {
      low: [recipe.roughnessMin, recipe.roughnessMin, recipe.roughnessMin],
      high: [recipe.roughnessMax, recipe.roughnessMax, recipe.roughnessMax],
    }));
    return { images: { color, height, normal, roughness }, stages };
  }
}
