import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { parseAssetSpec } from "./schema.js";

/**
 * Soldier and knight armour fitted to a base character's rest pose (#117, adapters/blender/armor.py).
 * `plates` is a static GLB of rigid pieces, one node per piece, in the character's rest model space; each piece
 * rides one joint through that joint's `<joint>.armor` socket. `cloth` is a GLB of garments skinned to the target's
 * own joints, composed into the character with `scene.compose.skinned.gltf@1`.
 */
export type ArmorKit = "soldier" | "knight";
export type ArmorOutput = "plates" | "cloth";
export type ArmorParameters = { schemaVersion: 1; kit: ArmorKit; output: ArmorOutput };
export const ARMOR_KITS: readonly ArmorKit[] = ["soldier", "knight"];
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
  if (!ARMOR_KITS.includes(p.kit as ArmorKit)) throw new Error("armor kit must be soldier or knight");
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
