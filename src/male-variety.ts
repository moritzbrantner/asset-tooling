import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { canonicalJson } from "./canonical.js";
import { generateAsset } from "./core.js";
import { transferMorphTargets } from "./face-variants.js";
import { withoutTextures } from "./gltf-without-textures.js";
import { sha256Bytes } from "./hash.js";
import type { AssetRef } from "./operations.js";
import { blenderScriptSpec, type BlenderSpecInput } from "./blender-script-spec.js";

/**
 * Male character variety (#380): one rig with age and build morph targets that the outfits, armour plates, hair and
 * facial hair follow, a height range, skin tones, painted head skins (middle-aged, aged, weathered, stubble) and the
 * hand-modelled hairstyles and beards. The keys are authored in Blender (adapters/blender/male_variety.py,
 * hair_beards.py); only the morph targets come back onto the shipped assets (`transferMorphTargets`).
 */
export const VARIETY_AGES = Object.freeze([
  { id: "age.base", label: "Adult", morphs: {}, skin: "base" },
  { id: "age.young", label: "Young", morphs: { "age.young": 1 }, skin: "base" },
  { id: "age.middle", label: "Middle-aged", morphs: { "age.middle": 1 }, skin: "middle" },
  { id: "age.old", label: "Old", morphs: { "age.old": 1 }, skin: "aged" },
  { id: "age.weathered", label: "Weathered", morphs: { "age.weathered": 1 }, skin: "weathered" },
] as const);
export const VARIETY_BUILDS = Object.freeze([
  { id: "build.lean", label: "Lean", morphs: { "build.lean": 1 } },
  { id: "build.average", label: "Average", morphs: {} },
  { id: "build.heavy", label: "Heavy", morphs: { "build.heavy": 1 } },
] as const);
export const VARIETY_AGE_TARGETS: readonly string[] = Object.freeze(["age.young", "age.middle", "age.old", "age.weathered"]);
export const VARIETY_BUILD_TARGETS: readonly string[] = Object.freeze(["build.lean", "build.heavy"]);
/** Zero influence is neutral; normalized sliders blend one endpoint from .5 towards 0 or 1. */
export const PHYSIQUE_TARGETS = Object.freeze({
  frame: ["frame.narrow", "frame.broad"],
  muscularity: ["muscularity.soft", "muscularity.defined"],
  shoulderWidth: ["shoulders.narrow", "shoulders.broad"],
  waistWidth: ["waist.narrow", "waist.wide"],
  hipWidth: ["hips.narrow", "hips.wide"],
  gluteFullness: ["glutes.small", "glutes.full"],
  jawProjection: ["jaw.receding", "jaw.projected"],
} as const);
export const FEMALE_BUST_TARGETS = Object.freeze(["bust.small", "bust.full"] as const);
export const VARIETY_BODY_TARGETS: readonly string[] = Object.freeze([...Object.values(PHYSIQUE_TARGETS).flat(), ...VARIETY_BUILD_TARGETS]);
export const VARIETY_MORPH_TARGETS: readonly string[] = Object.freeze([...VARIETY_AGE_TARGETS, ...VARIETY_BODY_TARGETS]);
export const FEMALE_VARIETY_MORPH_TARGETS: readonly string[] = Object.freeze([...VARIETY_AGE_TARGETS, ...Object.values(PHYSIQUE_TARGETS).flat(), ...FEMALE_BUST_TARGETS, ...VARIETY_BUILD_TARGETS]);

export function physiqueAppearance(figure: "male" | "female", variants: readonly string[], entries: readonly string[]) {
  const controls = { ...PHYSIQUE_TARGETS, ...(figure === "female" ? { bustFullness: FEMALE_BUST_TARGETS } : {}) };
  return {
    figure, variants: [...variants], entries: [...entries],
    controls: Object.fromEntries(Object.entries(controls).map(([id, targets]) => [id,
      { min: 0, max: 1, default: 0.5, lower: targets[0], upper: targets[1] }])),
    // These mix the authored fields, rather than swapping static figures. Existing face choices remain independent.
    ...(figure === "female" ? { presets: [
      { id: "slender", label: "Slender", morphs: { "frame.narrow": .55, "build.lean": .45, "bust.small": .3, "waist.narrow": .25 } },
      { id: "athletic", label: "Athletic", morphs: { "muscularity.defined": .7, "shoulders.broad": .25, "build.lean": .25 } },
      { id: "curvy", label: "Curvy", morphs: { "bust.full": .45, "waist.narrow": .25, "hips.wide": .4, "glutes.full": .4 } },
      { id: "voluptuous", label: "Voluptuous", morphs: { "bust.full": 1, "hips.wide": .65, "glutes.full": .7, "build.heavy": .15 } },
      { id: "fuller", label: "Fuller figured", morphs: { "build.heavy": .7, "frame.broad": .3, "bust.full": .5, "waist.wide": .25, "hips.wide": .4 } },
    ] } : {}),
  };
}
/** The height range: a uniform scale of the character root (male_variety.HEIGHTS). */
export const VARIETY_HEIGHTS = Object.freeze({ min: 0.91, max: 1.09, default: 1 });
/** Skin tones: linear base-colour factors over the Light skin's skin materials (male_variety.SKIN_TONES). */
export const VARIETY_SKIN_TONES = Object.freeze([
  { id: "tone.fair", label: "Fair", baseColorFactor: [1.05, 1, 0.97, 1] },
  { id: "tone.light", label: "Light", baseColorFactor: [1, 1, 1, 1] },
  { id: "tone.olive", label: "Olive", baseColorFactor: [0.8, 0.72, 0.55, 1] },
  { id: "tone.tan", label: "Tan", baseColorFactor: [0.68, 0.52, 0.38, 1] },
  { id: "tone.brown", label: "Brown", baseColorFactor: [0.42, 0.29, 0.2, 1] },
  { id: "tone.deep", label: "Deep", baseColorFactor: [0.24, 0.16, 0.11, 1] },
] as const);
export const VARIETY_SKIN_MATERIALS = Object.freeze(["MI_Superhero_Male", "MI_Regular_Male"]);
/** The hand-modelled hairstyles (adapters/blender/hair_beards.py), one entry each with one `hair-1` variant. */
export const VARIETY_HAIRSTYLES = Object.freeze(["hair.balding", "hair.receding", "hair.swept", "hair.tied"] as const);
export type VarietyHairstyle = typeof VARIETY_HAIRSTYLES[number];
/** The hand-modelled facial hair (one entry); they replace the #376 kit beards under the same names. */
export const VARIETY_BEARDS = Object.freeze({
  "beard.full": "Full beard", "beard.short": "Short beard", "beard.long": "Long beard", "beard.goatee": "Goatee",
  "beard.moustache": "Moustache", "beard.walrus": "Walrus moustache",
} as const);
export const VARIETY_FACIAL_HAIR_ENTRY = "facial-hair.beards";
/** The painted head skins (adapters/blender/skin_overlays.py): one material per skin, age and stubble shade. */
export const VARIETY_HEAD_SKIN_ENTRY = "skin.head";
export const VARIETY_HEAD_SKIN_SIZE = 1024;
export const VARIETY_HEAD_SKINS = Object.freeze(["skin.dark", "skin.light"] as const);
/** Matching tolerance of the key transfer (see transferMorphTargets: the composed characters re-pose at the neck). */
export const VARIETY_MATCH_TOLERANCE = 3e-3;
export const VARIETY_STUBBLE_SHADES = Object.freeze({ "tint.black": "dark", "tint.brown": "dark", "tint.blond": "light", "tint.grey": "light" } as const);

type Json = any;

async function runRecipe(root: string, { script, label, inputs, parameters, output }: {
  script: string; label: string; inputs: Record<string, Uint8Array | string>; parameters: Json; output: string;
}) {
  const source = await readBlenderRecipeSource(script);
  const workspace = path.join(root, "variety", label);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, script), source.bytes);
  const declared: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = { script: { path: script, sha256: source.sha256 } };
  for (const [name, value] of Object.entries(inputs)) {
    // A string names another packaged recipe source (a Python input loaded with inputs.load_source).
    const bytes = typeof value === "string" ? (await readBlenderRecipeSource(value)).bytes : value;
    const file = typeof value === "string" ? value : `${name}.glb`;
    await writeFile(path.join(workspace, file), bytes);
    declared[name] = { path: file, sha256: sha256Bytes(bytes) };
  }
  const spec = blenderScriptSpec({ assetId: `variety.${label}`, inputs: declared, blenderVersion: source.blenderVersion, arguments: parameters, output });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  return { bytes: new Uint8Array(await readFile(path.join(workspace, output))), observations: (generated.receipt.observations as Json).script as Json };
}

/**
 * Authors age, build and local physique keys for either figure in Blender on a copy of a character variant (and its armour plates), or on an item
 * worn on `body` (hair, plates; `age` adds the age keys, for facial hair). Returns the authored GLB to transfer from.
 */
export async function authorVarietyKeys(root: string, label: string, { mode, source, items, body, age = false, figure = "male", bodyMorphScale = 1 }: {
  mode: "character" | "item"; source: AssetRef; items?: AssetRef; body?: AssetRef; age?: boolean; figure?: "male" | "female"; bodyMorphScale?: number;
}) {
  // Only the authored morph targets come back (applyVarietyKeys), so Blender gets the geometry without textures (#516).
  const geometry = async (asset: AssetRef) => withoutTextures(new Uint8Array(await resolveAssetObject(root, asset)));
  const inputs: Record<string, Uint8Array | string> = { source: await geometry(source), face: "face_variants.py" };
  if (items) inputs.items = await geometry(items);
  if (body) inputs.body = await geometry(body);
  return runRecipe(root, { script: "male_variety.py", label, inputs, output: "keys.glb",
    parameters: { schemaVersion: 1, mode, figure, ...(age ? { age } : {}), ...(bodyMorphScale !== 1 ? { bodyMorphScale } : {}) } });
}

/** `asset` with the age and build morph targets of `authored` (by node name and vertex position). */
export async function applyVarietyKeys(root: string, asset: AssetRef, authored: Uint8Array, label: string) {
  const { glb, transfer } = await transferMorphTargets(new Uint8Array(await resolveAssetObject(root, asset)), authored, FEMALE_VARIETY_MORPH_TARGETS, { label, tolerance: VARIETY_MATCH_TOLERANCE });
  const stored = (await storeAssetObject(root, { bytes: glb, kind: asset.kind, mediaType: asset.mediaType,
    metadata: { operation: "male-variety-v1", source: asset.sha256, authored: sha256Bytes(authored) } })).asset;
  return { glb: stored, transfer };
}

/** One hand-modelled hairstyle, or the facial-hair entry, fitted to `body` and wearing `material`'s MI_Hair_1. */
export async function buildHairPiece(root: string, piece: VarietyHairstyle | typeof VARIETY_FACIAL_HAIR_ENTRY, body: AssetRef, material: AssetRef) {
  const { bytes, observations } = await runRecipe(root, { script: "hair_beards.py", label: piece, output: "piece.glb",
    parameters: { schemaVersion: 1, piece },
    inputs: { body: new Uint8Array(await resolveAssetObject(root, body)), material: new Uint8Array(await resolveAssetObject(root, material)),
      variety: "male_variety.py", face: "face_variants.py" } });
  const glb = (await storeAssetObject(root, { bytes: Buffer.from(bytes), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return { glb, observations };
}

/** The `skin.head` entry: the painted head skins of the Dark (`dark`) and Light (`light`) characters. */
export async function buildHeadSkins(root: string, dark: AssetRef, light: AssetRef) {
  const { bytes, observations } = await runRecipe(root, { script: "skin_overlays.py", label: "skin.head", output: "skins.glb",
    parameters: { schemaVersion: 1, size: VARIETY_HEAD_SKIN_SIZE },
    inputs: { dark: new Uint8Array(await resolveAssetObject(root, dark)), light: new Uint8Array(await resolveAssetObject(root, light)), face: "face_variants.py" } });
  const glb = (await storeAssetObject(root, { bytes: Buffer.from(bytes), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return { glb, observations };
}

/** The painted head-skin materials of the `skin.head` entry, by skin, age skin and stubble shade. */
export function headSkinMaterials() {
  const ages = [...new Set(VARIETY_AGES.map((age) => age.skin))];
  return VARIETY_HEAD_SKINS.flatMap((skin) => ages.flatMap((age) => [undefined, "dark", "light"].flatMap((stubble) => {
    if (age === "base" && !stubble) return [];
    return [{ skin, age, ...(stubble ? { stubble } : {}), material: `${skin}.${age}${stubble ? `.stubble.${stubble}` : ""}` }];
  })));
}

/**
 * The #380 sections of the `humanoid-appearance-v1` descriptor: ages and builds as morph weights (on every
 * full-detail character variant and on the armour, hair and facial-hair entries listed in `entries`), the height
 * range, the skin tones and the painted head skins.
 */
export function varietyAppearance({ variants, entries, head, eyebrows }: {
  variants: readonly string[]; entries: readonly string[]; head: string; eyebrows: string;
}) {
  return {
    ages: {
      default: "age.base", nodes: [head, eyebrows], followers: [VARIETY_FACIAL_HAIR_ENTRY], variants: [...variants],
      options: VARIETY_AGES.map(({ id, label, morphs, skin }) => ({ id, label, morphs: { ...morphs }, skin })),
    },
    builds: {
      default: "build.average", nodes: "every mesh node", entries: [...entries], variants: [...variants],
      options: VARIETY_BUILDS.map(({ id, label, morphs }) => ({ id, label, morphs: { ...morphs } })),
    },
    heights: { ...VARIETY_HEIGHTS, apply: "a uniform scale of the character root; attached items follow" },
    skinTones: { skin: "skin.light", materials: [...VARIETY_SKIN_MATERIALS], tones: VARIETY_SKIN_TONES.map((tone) => ({ ...tone, baseColorFactor: [...tone.baseColorFactor] })) },
    headSkins: {
      entry: VARIETY_HEAD_SKIN_ENTRY, material: VARIETY_SKIN_MATERIALS[0], stubbleShades: { ...VARIETY_STUBBLE_SHADES },
      textures: headSkinMaterials(),
    },
  };
}
