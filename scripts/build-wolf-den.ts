// Build the wolf den kit for mmorpg's Wolfrun Den (docs/wolf-den.md, #754):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-wolf-den.ts [--textures full|half] --out <directory>
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/wolf-den.kit.tar. The steps are in scripts/baked-rock-kit.ts.
import { bakedRockKey, buildBakedRockKit, createBakedRockSpec, runBakedRockKitCli, type BakedRockKit } from "./baked-rock-kit.ts";

/** In the order of the recipe's table, which the atlas's numbered inputs follow. */
export const WOLF_DEN_PARTS = ["den-mouth", "bone-scatter", "bedding-patch"] as const;
export type WolfDenPart = (typeof WOLF_DEN_PARTS)[number];
export const WOLF_DEN_LOD_DISTANCES = [60, 180] as const;
/** The rounded boulder scan for the rock, the terrain's moss and the forest floor for earth and bedding. */
export const WOLF_DEN_KIT: BakedRockKit<WolfDenPart> = {
  release: "wolf-den", tarName: "wolf-den.kit.tar", keyPrefix: "wolf-den.kit", material: "wolf-den",
  descriptorSchema: "wolf-den-descriptor-v1", descriptorAttachment: "wolf-den-descriptor", parts: WOLF_DEN_PARTS,
  recipe: "adapters/blender/wolf_den.py", recipeInputs: { outcrop: "adapters/blender/cliff_outcrop.py", limestone: "adapters/blender/limestone_rocks.py" },
  sources: {
    rockColour: "poly-haven.rock-boulder-dry-diff-2k-jpg",
    rockHeight: "poly-haven.rock-boulder-dry-disp-2k-jpg",
    mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
    groundColour: "poly-haven.forrest-ground-01-diff-2k-jpg",
  },
  lodDistances: WOLF_DEN_LOD_DISTANCES, scaleLodDistances: true,
  placement: "The den mouth faces +Z. Its bank runs `bury` metres below y = 0 and its apron sinks under the terrain at its rim. den-mouth carries `collisionProxies` boxes from the ground up (the two jambs, and the bank over the mouth, which closes it: the hollow is dressing, not a walk-in space); a resting wolf belongs on the bedding in front, about (0.1, 0, 1.2). bone-scatter and bedding-patch are walk-on ground dressing and declare `collision: \"none\"`.",
};
export const WOLF_DEN_RELEASE = WOLF_DEN_KIT.release;
export const WOLF_DEN_MATERIAL = WOLF_DEN_KIT.material;
export const WOLF_DEN_DESCRIPTOR_ATTACHMENT = WOLF_DEN_KIT.descriptorAttachment;
export const wolfDenKey = (part: WolfDenPart) => bakedRockKey(WOLF_DEN_KIT, part);

export const createWolfDenSpec = (options: Parameters<typeof createBakedRockSpec<WolfDenPart>>[1]) => createBakedRockSpec(WOLF_DEN_KIT, options);
export const buildWolfDen = (options: { outDir: string; log?: (line: string) => void }) => buildBakedRockKit(WOLF_DEN_KIT, options);

if (import.meta.main) await runBakedRockKitCli("scripts/build-wolf-den.ts", WOLF_DEN_KIT);
