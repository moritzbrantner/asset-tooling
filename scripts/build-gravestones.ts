// Build the gravestones kit (docs/gravestones.md, #548):
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-gravestones.ts [--textures full|half] --out <directory>
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/gravestones.kit.tar. The steps are in scripts/baked-rock-kit.ts.
import { bakedRockKey, buildBakedRockKit, createBakedRockSpec, runBakedRockKitCli, type BakedRockKit } from "./baked-rock-kit.ts";

/** In the order of the recipe's table, which the atlas's numbered inputs follow. */
export const GRAVESTONE_PARTS = ["headstone-round", "headstone-shoulder", "headstone-pointed", "headstone-leaning", "headstone-broken", "cross", "ledger", "chest-tomb", "footstone"] as const;
export type GravestonePart = (typeof GRAVESTONE_PARTS)[number];
export const GRAVESTONE_LOD_DISTANCES = [60, 180] as const;
/** Limestone to match the limestone-rocks kit, with moss from the terrain's scan. */
export const GRAVESTONE_KIT: BakedRockKit<GravestonePart> = {
  release: "gravestones", tarName: "gravestones.kit.tar", keyPrefix: "gravestones.kit", material: "gravestone",
  descriptorSchema: "gravestones-descriptor-v1", descriptorAttachment: "gravestones-descriptor", parts: GRAVESTONE_PARTS,
  recipe: "adapters/blender/gravestones.py", recipeInputs: { outcrop: "adapters/blender/cliff_outcrop.py", limestone: "adapters/blender/limestone_rocks.py" },
  sources: {
    rockColour: "poly-haven.rock-face-03-diff-2k-jpg",
    rockHeight: "poly-haven.rock-face-03-disp-2k-jpg",
    mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
  },
  lodDistances: GRAVESTONE_LOD_DISTANCES, scaleLodDistances: true,
  placement: "Fronts face +Z. Upright stones run `bury` metres below y = 0 for uneven ground. Solid pieces carry `collisionProxies` boxes from the ground up; footstone is low enough to step over and declares `collision: \"none\"`, and the fallen top of headstone-broken has no collision of its own.",
};
export const GRAVESTONE_RELEASE = GRAVESTONE_KIT.release;
export const GRAVESTONE_MATERIAL = GRAVESTONE_KIT.material;
export const GRAVESTONE_DESCRIPTOR_ATTACHMENT = GRAVESTONE_KIT.descriptorAttachment;
export const gravestoneKey = (part: GravestonePart) => bakedRockKey(GRAVESTONE_KIT, part);

export const createGravestoneSpec = (options: Parameters<typeof createBakedRockSpec<GravestonePart>>[1]) => createBakedRockSpec(GRAVESTONE_KIT, options);
export const buildGravestones = (options: { outDir: string; log?: (line: string) => void }) => buildBakedRockKit(GRAVESTONE_KIT, options);

if (import.meta.main) await runBakedRockKitCli("scripts/build-gravestones.ts", GRAVESTONE_KIT);
