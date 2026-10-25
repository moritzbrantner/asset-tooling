import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { parseAssetSpec } from "./schema.js";

/**
 * Soldier and knight armour fitted to a base character's rest pose (#117, adapters/blender/armor.py).
 * `plates` is a static GLB of rigid pieces, one node per piece, in the character's rest model space; each piece
 * rides one joint through that joint's `<joint>.armor` socket. `cloth` is a GLB of garments skinned to the target's
 * own joints, composed into the character with `scene.compose.skinned.gltf@1`.
 *
 * The resident kits (#376) use the same fitting for plain clothes: the farmer's smock, the innkeeper's apron and the
 * monk's habit, each with a belt as its one rigid piece. The facial hair moved to `male-variety.ts` (#380).
 *
 * The class kits (#379) are the seven mmorpg class starter outfits in the Greyhaven Marshal's style: long robes,
 * jerkins over straight work trousers, hoods, mantles, cloaks and long sleeves cut from or fitted to the Peasant base,
 * each with a recolourable `class` colour slot.
 */
export type ArmorClassKit = "class.warden" | "class.ranger" | "class.arcanist" | "class.necromancer" | "class.rogue" | "class.cleric" | "class.druid";
export type ArmorOutfitKit = "soldier" | "knight" | "farmer" | "innkeeper" | "monk" | ArmorClassKit;
export type ArmorKit = ArmorOutfitKit;
export type ArmorOutput = "plates" | "cloth";
export type ArmorParameters = { schemaVersion: 1; kit: ArmorKit; output: ArmorOutput };
/** The class starter outfits (#379), in mmorpg's class order. */
export const ARMOR_CLASS_KITS: readonly ArmorClassKit[] = ["class.warden", "class.ranger", "class.arcanist", "class.necromancer", "class.rogue", "class.cleric", "class.druid"];
/** The kits that dress the Peasant base as an outfit variant, in bundle order. */
export const ARMOR_OUTFIT_KITS: readonly ArmorOutfitKit[] = ["soldier", "knight", "farmer", "innkeeper", "monk", ...ARMOR_CLASS_KITS];
export const ARMOR_KITS: readonly ArmorKit[] = ARMOR_OUTFIT_KITS;
/** Outfit labels for the appearance descriptor. */
export const ARMOR_KIT_LABELS = {
  soldier: "Soldier", knight: "Knight", farmer: "Farmer", innkeeper: "Innkeeper", monk: "Monk",
  "class.warden": "Warden", "class.ranger": "Ranger", "class.arcanist": "Arcanist", "class.necromancer": "Necromancer",
  "class.rogue": "Rogue", "class.cleric": "Cleric", "class.druid": "Druid",
} as const satisfies Record<ArmorOutfitKit, string>;
/** The class kits' hood garments: shown as the `outfit.hood` part, so hair that needs the hood off hides under them. */
export const ARMOR_CLASS_HOODS: readonly string[] = ["class.ranger.hood", "class.rogue.hood", "class.necromancer.hood"];
/** The class kits' recolourable class colour material (its default colour is in the cloth receipt, `classTrim`). */
export const ARMOR_CLASS_MATERIAL = "class";
/** The Necromancer's pale grey skin (#379), offered with its outfit only. */
export const ARMOR_GREY_SKIN_KITS: readonly ArmorOutfitKit[] = ["class.necromancer"];
/** The kits whose cloth carries the recolourable faction slot. */
export const ARMOR_FACTION_KITS: readonly ArmorOutfitKit[] = ["soldier", "knight"];
export const ARMOR_OUTPUTS: readonly ArmorOutput[] = ["plates", "cloth"];
/** The base mesh nodes the armour is fitted over (the Male_Peasant outfit, owner answers #117 Q1/Q10). */
export const ARMOR_BASE_NODES = ["Male_Peasant_Arms", "Male_Peasant_Body", "Male_Peasant_Feet", "Male_Peasant_Legs"] as const;
/** The material slot a consumer recolours for the faction (owner answer #117 Q11), with its default linear colour. */
export const ARMOR_FACTION = { material: "faction", default: [0.25, 0.04, 0.04] } as const;
/** The rigid pieces ride these joints; each has a `<joint>.armor` socket (lowercase joint) that is the inverse of its rest transform. */
export const ARMOR_JOINTS = [
  "Head", "spine_03", "pelvis", "clavicle_l", "clavicle_r", "upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r",
  "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r",
] as const;

export function normalizeArmorParameters(value: unknown): ArmorParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("armor parameters must be a plain object");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== 3 || p.schemaVersion !== 1) throw new Error("armor requires exactly schemaVersion 1, kit and output");
  if (!ARMOR_KITS.includes(p.kit as ArmorKit)) throw new Error(`armor kit must be one of ${ARMOR_KITS.join(", ")}`);
  if (!ARMOR_OUTPUTS.includes(p.output as ArmorOutput)) throw new Error("armor output must be plates or cloth");
  return { schemaVersion: 1, kit: p.kit as ArmorKit, output: p.output as ArmorOutput };
}

export async function readArmorRecipeSource() {
  return readBlenderRecipeSource("armor.py");
}

export function createArmorAssetSpec({ assetId, parameters, scriptSha256, targetSha256, blenderVersion }: {
  assetId: string; parameters: unknown; scriptSha256: string; targetSha256: string; blenderVersion: string;
}) {
  if (!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("armor Blender version must be exact");
  return parseAssetSpec({
    schemaVersion: 1, assetId, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "armor.py", sha256: scriptSha256 }, target: { path: "target.glb", sha256: targetSha256 } }, models: {},
    parameters: { blenderVersion, arguments: normalizeArmorParameters(parameters) },
    output: { path: "armor.glb" }, reproducibility: { expected: "exact" },
  });
}
