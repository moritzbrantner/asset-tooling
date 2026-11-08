// Build the river stone kit for Greyhaven's brook (docs/river-stones.md, #538):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-river-stones.ts [--textures full|half] --out <directory>
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/river-stones.kit.tar. The steps are in scripts/baked-rock-kit.ts.
import { bakedRockKey, buildBakedRockKit, createBakedRockSpec, runBakedRockKitCli, type BakedRockKit } from "./baked-rock-kit.ts";

/** In the order of the recipe's tables, which the atlas's numbered inputs follow. */
export const RIVER_PARTS = ["boulder-1", "boulder-2", "boulder-3", "step-1", "step-2", "bed-1", "bed-2", "bank-1", "bank-2", "bar-1", "bar-2"] as const;
export type RiverPart = (typeof RIVER_PARTS)[number];
export const RIVER_LOD_DISTANCES = [60, 180] as const;
/** The kits' blends use the terrain's scans; these stones take the rounded boulder scan for their surface. */
export const RIVER_KIT: BakedRockKit<RiverPart> = {
  release: "river-stones", tarName: "river-stones.kit.tar", keyPrefix: "river-stones.kit", material: "river-stone",
  descriptorSchema: "river-stones-descriptor-v1", descriptorAttachment: "river-stones-descriptor", parts: RIVER_PARTS,
  recipe: "adapters/blender/river_stones.py", recipeInputs: { outcrop: "adapters/blender/cliff_outcrop.py", limestone: "adapters/blender/limestone_rocks.py" },
  sources: {
    rockColour: "poly-haven.rock-boulder-dry-diff-2k-jpg",
    rockHeight: "poly-haven.rock-boulder-dry-disp-2k-jpg",
    grassColour: "poly-haven.forrest-ground-01-diff-2k-jpg",
    gravelColour: "poly-haven.rocks-ground-02-diff-2k-jpg",
    mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
  },
  lodDistances: RIVER_LOD_DISTANCES,
  placement: "Each piece's foot runs `bury` metres below y = 0. Boulders and stepping stones carry `collisionMesh`, a closed outward-wound triangle mesh; beds, banks and bars are walk-on debris and declare `collision: \"none\"`.",
};
export const RIVER_RELEASE = RIVER_KIT.release;
export const RIVER_MATERIAL = RIVER_KIT.material;
export const RIVER_DESCRIPTOR_ATTACHMENT = RIVER_KIT.descriptorAttachment;
export const riverKey = (part: RiverPart) => bakedRockKey(RIVER_KIT, part);

export const createRiverSpec = (options: Parameters<typeof createBakedRockSpec<RiverPart>>[1]) => createBakedRockSpec(RIVER_KIT, options);
export const buildRiverStones = (options: { outDir: string; log?: (line: string) => void }) => buildBakedRockKit(RIVER_KIT, options);

if (import.meta.main) await runBakedRockKitCli("scripts/build-river-stones.ts", RIVER_KIT);
