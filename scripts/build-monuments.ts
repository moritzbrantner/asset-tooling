// Build the monuments kit (docs/monuments.md, #550):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-monuments.ts [--textures full|half] --out <directory>
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/monuments.kit.tar. The steps are in scripts/baked-rock-kit.ts.
import { bakedRockKey, buildBakedRockKit, createBakedRockSpec, runBakedRockKitCli, type BakedRockKit } from "./baked-rock-kit.ts";

/** In the order of the recipe's table, which the atlas's numbered inputs follow. */
export const MONUMENT_PARTS = ["obelisk", "broken-column", "column-drum", "urn", "statue", "memorial-wall", "mausoleum-sealed", "mausoleum-walk-in", "mausoleum-walk-in-roof"] as const;
export type MonumentPart = (typeof MONUMENT_PARTS)[number];
export const MONUMENT_LOD_DISTANCES = [60, 180] as const;
/** The gravestones' stone: the same scans, and its helpers through the recipe's `gravestones` input. */
export const MONUMENT_KIT: BakedRockKit<MonumentPart> = {
  release: "monuments", tarName: "monuments.kit.tar", keyPrefix: "monuments.kit", material: "monument",
  descriptorSchema: "monuments-descriptor-v1", descriptorAttachment: "monuments-descriptor", parts: MONUMENT_PARTS,
  recipe: "adapters/blender/monuments.py",
  recipeInputs: { outcrop: "adapters/blender/cliff_outcrop.py", limestone: "adapters/blender/limestone_rocks.py", gravestones: "adapters/blender/gravestones.py" },
  sources: {
    rockColour: "poly-haven.rock-face-03-diff-2k-jpg",
    rockHeight: "poly-haven.rock-face-03-disp-2k-jpg",
    mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
  },
  lodDistances: MONUMENT_LOD_DISTANCES, scaleLodDistances: true,
  placement: "Fronts face +Z. Solid pieces carry `collisionProxies` boxes; `floor` boxes are walkable steps. mausoleum-walk-in and mausoleum-walk-in-roof share one frame, so place them with the same transform; `interior` on the walk-in names the roof piece and gives the room's volume, for a game that hides the roof while a character is inside.",
};
export const MONUMENT_RELEASE = MONUMENT_KIT.release;
export const MONUMENT_MATERIAL = MONUMENT_KIT.material;
export const MONUMENT_DESCRIPTOR_ATTACHMENT = MONUMENT_KIT.descriptorAttachment;
export const monumentKey = (part: MonumentPart) => bakedRockKey(MONUMENT_KIT, part);

export const createMonumentSpec = (options: Parameters<typeof createBakedRockSpec<MonumentPart>>[1]) => createBakedRockSpec(MONUMENT_KIT, options);
export const buildMonuments = (options: { outDir: string; log?: (line: string) => void }) => buildBakedRockKit(MONUMENT_KIT, options);

if (import.meta.main) await runBakedRockKitCli("scripts/build-monuments.ts", MONUMENT_KIT);
