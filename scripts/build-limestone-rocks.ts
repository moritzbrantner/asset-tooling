// Build the limestone rock kit for mmorpg's Greyhaven (docs/limestone-rocks.md, #536):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-limestone-rocks.ts [--textures full|half] [--surface baked|layered] --out <directory>
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/limestone-rocks.kit.tar. `--surface layered` is the #567 trial and packs limestone-rocks-layered.kit.tar
// instead. The steps are in scripts/baked-rock-kit.ts.
import { bakedRockKey, buildBakedRockKit, createBakedRockSpec, runBakedRockKitCli, type BakedRockKit, type RockSurface } from "./baked-rock-kit.ts";

/** In the order of the recipe's tables, which the atlas's numbered inputs follow. */
export const LIMESTONE_PARTS = ["outcrop-1", "outcrop-2", "ledge", "block-1", "block-2", "block-3", "scree-1", "scree-2"] as const;
export type LimestonePart = (typeof LIMESTONE_PARTS)[number];
/** Where LOD0 and lod1 end, in metres at the reference FOV, for every piece. */
export const LIMESTONE_LOD_DISTANCES = [60, 180] as const;
export const LIMESTONE_KIT: BakedRockKit<LimestonePart> = {
  release: "limestone-rocks", tarName: "limestone-rocks.kit.tar", keyPrefix: "limestone-rocks.kit", material: "limestone-rock",
  descriptorSchema: "limestone-rocks-descriptor-v1", descriptorAttachment: "limestone-rocks-descriptor", parts: LIMESTONE_PARTS,
  recipe: "adapters/blender/limestone_rocks.py", recipeInputs: { outcrop: "adapters/blender/cliff_outcrop.py" },
  // The terrain's own scans, so the rock's foot and crown match the ground around it.
  sources: {
    rockColour: "poly-haven.rock-face-03-diff-2k-jpg",
    rockHeight: "poly-haven.rock-face-03-disp-2k-jpg",
    grassColour: "poly-haven.forrest-ground-01-diff-2k-jpg",
    gravelColour: "poly-haven.rocks-ground-02-diff-2k-jpg",
    mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
  },
  lodDistances: LIMESTONE_LOD_DISTANCES,
  surface: { recipe: "adapters/blender/limestone_rock_surface.py", release: "limestone-rocks-layered", tarName: "limestone-rocks-layered.kit.tar", material: "limestone-rock-layered" },
  placement: "Each rock's foot runs `bury` metres below y = 0 so it meets uneven ground. Scree lies loose on any terrain and declares `collision: \"none\"`; every other piece carries `collisionMesh`, a closed outward-wound triangle mesh that leaves the soft apron out.",
};
export const LIMESTONE_RELEASE = LIMESTONE_KIT.release;
export const LIMESTONE_MATERIAL = LIMESTONE_KIT.material;
export const LIMESTONE_DESCRIPTOR_ATTACHMENT = LIMESTONE_KIT.descriptorAttachment;
export const limestoneKey = (part: LimestonePart) => bakedRockKey(LIMESTONE_KIT, part);

export function createLimestoneSpec({ part, scriptSha256, outcropSha256, inputSha256, blenderVersion }: {
  part: LimestonePart; scriptSha256: string; outcropSha256: string; inputSha256: Record<string, string>; blenderVersion: string;
}) {
  return createBakedRockSpec(LIMESTONE_KIT, { part, recipeSha256: { script: scriptSha256, outcrop: outcropSha256 }, inputSha256, blenderVersion });
}

export const buildLimestoneRocks = (options: { outDir: string; surface?: RockSurface; log?: (line: string) => void }) => buildBakedRockKit(LIMESTONE_KIT, options);

if (import.meta.main) await runBakedRockKitCli("scripts/build-limestone-rocks.ts", LIMESTONE_KIT);
