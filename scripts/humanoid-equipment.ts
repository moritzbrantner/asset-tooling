// The humanoid equipment (docs/humanoid-equipment.md): the weapons, the Rogue's throwables, the archery pieces and the
// male headwear, each a recipe preset whose origin is its grip frame, with a `humanoid-item-v2` attachment naming its
// role. The items fit any figure on the Ranger rig through the sockets descriptor, so they build once for the
// `humanoid-equipment` release (scripts/build-humanoid-equipment.ts, #517) and not inside each figure's bundle.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ARCHERY_PRESETS, ARCHERY_ROLES, createArcheryAssetSpec, readArcheryRecipeSource, type ArcheryPiece } from "../src/archery-recipes.js";
import { storeAssetObject } from "../src/asset-store.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { canonicalJson } from "../src/canonical.js";
import { HEADWEAR_CONTRACT, HEADWEAR_HIDES, HEADWEAR_PRESETS, createHeadwearAssetSpec, readHeadwearRecipeSource, type HeadwearPiece } from "../src/headwear-recipes.js";
import { HUMANOID_ITEM_LOD_METRIC, createHumanoidItemDescriptor, type HumanoidItemDescriptor, type HumanoidItemLods } from "../src/humanoid-sockets.js";
import { generateAsset } from "../src/index.js";
import { LOD_LEVELS } from "../src/lod-recipe.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";
import { WEAPON_LOD_PRESETS, WEAPON_LOD_SCREEN_SIZES, WEAPON_PRESETS, WEAPON_ROLES, createWeaponAssetSpec, readWeaponRecipeSource, type ThrowablePiece, type WeaponParameters, type WeaponPiece } from "../src/weapon-recipes.js";
import { cachedImport } from "./cached-operations.ts";

type Json = Record<string, any>;
const POLICY = { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] };
const DEFAULT_VARIANT = "default";
function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

/**
 * Weapon entries: weapon-recipe presets, parented at runtime through the sockets descriptor. The dagger and the class
 * staffs (#372) are held in `hand_r.weapon` and `hand_r.staff`.
 */
export const RANGER_WEAPONS: readonly { key: string; piece: WeaponPiece }[] = [
  { key: "equipment.sword.arming", piece: "sword.arming" },
  { key: "equipment.shield.heater", piece: "shield.heater" },
  { key: "equipment.dagger.blackened", piece: "dagger.blackened" },
  { key: "equipment.staff.bone", piece: "staff.bone" },
  { key: "equipment.staff.gilded", piece: "staff.gilded" },
  { key: "equipment.staff.gnarled", piece: "staff.gnarled" },
  // #379: the class starter props: the Arcanist's crystal staff and tome (held in `hand_l.shield`), the Cleric's mace.
  { key: "equipment.staff.crystal", piece: "staff.crystal" },
  { key: "equipment.book.tome", piece: "book.tome" },
  { key: "equipment.mace.flanged", piece: "mace.flanged" },
];
/**
 * #467: the Rogue's throwables, drawn from `belt.throwable` into `hand_r.weapon` during Throw_Knife and Throw_Lob (the
 * knife with Grip_Knife_Pinch_R, the flask and bomb with Grip_Flask_R). Each entry ships `default`, `lod1` and `lod2`
 * variants, listed with their screen-size switch points in its `humanoid-item` descriptor.
 */
export const RANGER_THROWABLES: readonly { key: string; piece: ThrowablePiece }[] = [
  { key: "equipment.throwing-knife", piece: "throwing-knife" },
  { key: "equipment.venom-flask", piece: "venom-flask" },
  { key: "equipment.blasting-bomb", piece: "blasting-bomb" },
];
export const RANGER_ITEM_LOD_REFERENCE_FOV_Y = 60;
/** The #457 selection block every item with levels carries (greyhaven-nature-bundle.md#lod-metadata). */
export const RANGER_ITEM_LOD_SELECTION = {
  metric: HUMANOID_ITEM_LOD_METRIC,
  rule: "Use the first level whose minScreenSize is at most the item's projected bounding-sphere diameter divided by the viewport "
    + "height (radius / (distance * tan(fovY / 2))). referenceMaxDistance is the distance in metres at which that level ends at "
    + "referenceFovYDegrees.",
  referenceFovYDegrees: RANGER_ITEM_LOD_REFERENCE_FOV_Y,
} as const;
/** Archery entries (#113 bow slice): archery-recipe presets, parented at runtime through the sockets descriptor. */
export const RANGER_ARCHERY: readonly { key: string; piece: ArcheryPiece }[] = [
  { key: "equipment.bow.long", piece: "bow.long" },
  { key: "equipment.arrow", piece: "arrow" },
  { key: "equipment.quiver.back", piece: "quiver.back" },
  // #389: the crossbow, held in `hand_r.crossbow`.
  { key: "equipment.crossbow", piece: "crossbow" },
  // #760: the Fenwarden's Bow, a named find from the Eastwater Fen: a dark yew recurve on the same grip and nock.
  { key: "equipment.bow.fenwarden", piece: "bow.recurve" },
];
/**
 * Headwear entries (#336, male only): headwear-recipe presets fitted in the male rest model space, parented at runtime
 * through the `head.armor` socket. The appearance descriptor's `headwear` list names each entry and the parts it hides.
 */
export const RANGER_HEADWEAR: readonly { key: string; piece: HeadwearPiece; label: string }[] = [
  { key: "equipment.cap.ranger", piece: "cap.ranger", label: "Ranger's Cap" },
  { key: "equipment.helm.ironcrest", piece: "helm.ironcrest", label: "Ironcrest Helm" },
  { key: "equipment.hat.straw", piece: "hat.straw", label: "Straw Hat" },
];
/**
 * #661: weapon variety and residents' hand tools from the fixed-design `held_items.py` recipe. Each declares the roles
 * the existing sockets accept (`one-hand-weapon`, `staff`, `shield`, `book`, and #735's `load` on `chest.carry`), plus a
 * descriptive second role where it helps (`two-hand-weapon`, `spear`, `tool`, `carried`), and two-handed pieces a
 * `grip.offhand` frame.
 */
export const RANGER_HELD_ITEMS: readonly { key: string; item: string }[] = [
  "sword.footman", "sword.falchion", "sword.longsword", "sword.bastard", "dagger.plain", "dagger.seax",
  "axe.battle", "axe.bearded", "axe.hand", "mace.studded", "mace.morningstar", "warhammer.horseman", "warhammer.maul",
  "spear.leaf", "spear.boar", "staff.quarter", "staff.crook", "shield.round", "shield.buckler", "shield.kite",
  "tool.lantern", "tool.torch", "tool.pitchfork", "tool.hoe", "tool.shovel", "tool.fishing-rod", "tool.wood-axe",
  "tool.hammer", "tool.bucket", "tool.basket", "tool.tankard", "book.ledger", "tool.broom", "tool.walking-stick",
  // #707: the gathering and craft tools the work clips borrowed stand-ins for.
  "tool.pickaxe", "tool.sickle", "tool.skinning-knife", "tool.hand-saw", "tool.mallet", "tool.rake", "tool.scythe",
  // #719: the heavy weapons for the two-handed and spear clips.
  "sword.great", "axe.great", "hammer.great", "polearm.halberd", "polearm.glaive", "spear.pike",
  // #735: the two-handed loads residents carry on `chest.carry`.
  "load.crate", "load.sack", "load.firewood", "load.hay", "load.basket-large", "load.water-jug",
  // #760: Greyhaven's named finds on their family's sockets: Garrick Redbrand's cleaver, the Hollowpine hunter's spear and
  // the Millbrook smith's mace.
  "sword.garricks-cleaver", "spear.hollowpine-hunter", "mace.millbrook-smith",
].map((item) => ({ key: `equipment.${item}`, item }));
/** The roles the Ranger sockets accept, one of which every held item lists first. */
export const SOCKET_ROLES = ["one-hand-weapon", "staff", "shield", "book", "load"] as const;
type HeldObservations = { roles: string[]; frames: Record<string, [number, number, number]>; triangleCount: number; bounds: { min: number[]; max: number[] } };

/** A held item's `humanoid-item-v2` descriptor: its roles, the identity `grip` and any further frames it declares. */
export function heldItemDescriptor(key: string, observations: Pick<HeldObservations, "roles" | "frames">): HumanoidItemDescriptor {
  return createHumanoidItemDescriptor({ item: key, roles: observations.roles, frames: [
    { name: "grip", translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    ...Object.entries(observations.frames).map(([name, translation]) => ({ name, translation, rotation: [0, 0, 0, 1] as [number, number, number, number] })),
  ] });
}

/** Generate one held item through the pinned Blender backend (ASSET_TOOLING_BLENDER) and import it. */
async function buildHeldItem(root: string, item: string) {
  const source = await readBlenderRecipeSource("held_items.py");
  const workspace = path.join(root, "held", item);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "held_items.py"), source.bytes);
  const spec = blenderScriptSpec({ assetId: `held.${item}`, inputs: { script: { path: "held_items.py", sha256: source.sha256 } },
    blenderVersion: source.blenderVersion, arguments: { schemaVersion: 1, item }, output: "held.glb" });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const observations = generated.receipt.observations.script as HeldObservations;
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "held.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return { asset: single(await cachedImport(root, { inputs: { source: glb }, parameters: { policy: POLICY } })), observations };
}

/** Each equipment entry's `humanoid-item-v2` attachment (#264): its role and its `grip` frame. */
export const RANGER_ITEM_ATTACHMENT = "humanoid-item";
/** Every recipe GLB's origin is its grip frame, so `grip` is the identity in the item's scene frame. */
export function rangerItemDescriptor(item: string, role: string, lods?: HumanoidItemLods): HumanoidItemDescriptor {
  return createHumanoidItemDescriptor({ item, roles: [role], frames: [{ name: "grip", translation: [0, 0, 0], rotation: [0, 0, 0, 1] }],
    ...(lods ? { lodSelection: RANGER_ITEM_LOD_SELECTION, lods } : {}) });
}
/** An item's `lods` from its LOD0 bounds and its levels' triangle counts, at the `WEAPON_LOD_SCREEN_SIZES` switch points. */
export function rangerItemLods(bounds: { min: number[]; max: number[] }, levels: readonly { variant: string; triangles: number }[]): HumanoidItemLods {
  const round = (value: number) => Math.round(value * 1e4) / 1e4 + 0;
  const radius = round(Math.hypot(...[0, 1, 2].map((axis) => bounds.max[axis]! - bounds.min[axis]!)) / 2);
  const tan = Math.tan((RANGER_ITEM_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  return {
    boundingSphere: { center: [0, 1, 2].map((axis) => round((bounds.min[axis]! + bounds.max[axis]!) / 2)) as [number, number, number], radius },
    levels: levels.map(({ variant, triangles }, index) => {
      const minScreenSize = index < levels.length - 1 ? WEAPON_LOD_SCREEN_SIZES[index]! : 0;
      return { variant, triangles, minScreenSize, referenceMaxDistance: minScreenSize ? Number((radius / (minScreenSize * tan)).toFixed(2)) : null };
    }),
  };
}

/** Generate one weapon-recipe preset through the pinned Blender backend (ASSET_TOOLING_BLENDER) and store it. */
async function generateWeapon(root: string, piece: WeaponPiece, parameters: WeaponParameters = WEAPON_PRESETS[piece], label: string = piece) {
  const source = await readWeaponRecipeSource();
  const workspace = path.join(root, "weapons", label);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "weapon.py"), source.bytes);
  const spec = createWeaponAssetSpec({ assetId: `weapon.${label}`, parameters, scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const observations = generated.receipt.observations.script as { triangleCount: number; bounds: { min: number[]; max: number[] } };
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "weapon.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return { asset: single(await cachedImport(root, { inputs: { source: glb }, parameters: { policy: POLICY } })), observations };
}

async function buildWeapon(root: string, piece: WeaponPiece) {
  return (await generateWeapon(root, piece)).asset;
}

/** #467: a throwable's `default`, `lod1` and `lod2` (fewer lathe segments, the same frame) and its descriptor `lods`. */
async function buildThrowable(root: string, piece: ThrowablePiece) {
  const levels = [
    { variant: DEFAULT_VARIANT, ...await generateWeapon(root, piece) },
    ...await Promise.all(LOD_LEVELS.map(async (level) =>
      ({ variant: level, ...await generateWeapon(root, piece, WEAPON_LOD_PRESETS[piece][level], `${piece}.${level}`) }))),
  ];
  const lods = rangerItemLods(levels[0]!.observations.bounds, levels.map(({ variant, observations }) => ({ variant, triangles: observations.triangleCount })));
  return { levels: levels.map(({ variant, asset }) => ({ variant, asset })), lods };
}

/** Generate one headwear-recipe preset through the pinned Blender backend and store it. */
export async function buildHeadwear(root: string, piece: HeadwearPiece) {
  const source = await readHeadwearRecipeSource();
  const workspace = path.join(root, "headwear", piece);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "headwear.py"), source.bytes);
  const spec = createHeadwearAssetSpec({ assetId: `headwear.${piece}`, parameters: HEADWEAR_PRESETS[piece], scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "headwear.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return single(await cachedImport(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
}

/** The appearance descriptor's `headwear` list (#336): each piece's entry, socket and the appearance parts it hides. */
export function rangerHeadwearAppearance() {
  return RANGER_HEADWEAR.map(({ key, piece, label }) => ({
    id: key, entry: key, label, socket: HEADWEAR_CONTRACT.socket, hides: [...HEADWEAR_HIDES[piece]],
  }));
}

/** Generate one archery-recipe preset through the pinned Blender backend and import it (the bow keeps its skin). */
async function buildArchery(root: string, piece: ArcheryPiece) {
  const source = await readArcheryRecipeSource();
  const workspace = path.join(root, "archery", piece);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "archery.py"), source.bytes);
  const spec = createArcheryAssetSpec({ assetId: `archery.${piece}`, parameters: ARCHERY_PRESETS[piece], scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "archery.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  return single(await cachedImport(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
}

/** The bundle selections, assets and `humanoid-item` attachments of the equipment, and each item's LOD0 asset. */
export type EquipmentItems = { selections: Json[]; assets: AssetRef[]; attachments: AssetRef[]; items: Record<string, AssetRef> };

/**
 * Build every equipment item in its declared order: the weapons, the archery pieces, the headwear when `headwear` is
 * set (male figures only), then the throwables with their `lod1` and `lod2` variants. The Blender steps run through
 * `pool` (#427). `resize` brings an item's textures to game resolution; the recipes ship none, so it is the identity
 * unless the caller records its resizes.
 */
export async function buildEquipmentItems(root: string, { headwear, pool, log, resize = async (_key, asset) => asset }: {
  headwear: boolean; pool: <T>(task: () => Promise<T>) => Promise<T>; log: (line: string) => void;
  resize?: (key: string, asset: AssetRef) => Promise<AssetRef>;
}): Promise<EquipmentItems> {
  const out: EquipmentItems = { selections: [], assets: [], attachments: [], items: {} };
  const selectItem = async (key: string, role: string, asset: AssetRef, lods?: HumanoidItemLods, descriptor?: HumanoidItemDescriptor) => {
    out.selections.push({ key, variant: DEFAULT_VARIANT, attachments: [{ name: RANGER_ITEM_ATTACHMENT }] });
    out.assets.push(asset);
    const bytes = Buffer.from(`${canonicalJson(descriptor ?? rangerItemDescriptor(key, role, lods))}\n`);
    out.attachments.push((await storeAssetObject(root, { bytes, kind: RANGER_ITEM_ATTACHMENT, mediaType: "application/json" })).asset);
  };
  // The held items build in parallel (#427) and are selected in their declared order.
  const items: { key: string; role: string; build: () => Promise<AssetRef>; resize: boolean }[] = [
    ...RANGER_WEAPONS.map(({ key, piece }) => ({ key, role: WEAPON_ROLES[piece], resize: true, build: () => {
      log(`generate ${piece} (external.blender.script@1 weapon recipe, scene.import.gltf@2)`);
      return buildWeapon(root, piece);
    } })),
    ...RANGER_ARCHERY.map(({ key, piece }) => ({ key, role: ARCHERY_ROLES[piece], resize: true, build: () => {
      log(`generate ${piece} (external.blender.script@1 archery recipe, scene.import.gltf@2)`);
      return buildArchery(root, piece);
    } })),
    ...(headwear ? RANGER_HEADWEAR : []).map(({ key, piece }) => ({ key, role: HEADWEAR_CONTRACT.role, resize: false, build: () => {
      log(`generate ${piece} (external.blender.script@1 headwear recipe, scene.import.gltf@2)`);
      return buildHeadwear(root, piece);
    } })),
  ];
  const throwing = RANGER_THROWABLES.map(({ piece }) => pool(() => {
    log(`generate ${piece} and its lod1/lod2 (external.blender.script@1 weapon recipe, scene.import.gltf@2)`);
    return buildThrowable(root, piece);
  }));
  const holding = RANGER_HELD_ITEMS.map(({ item }) => pool(() => {
    log(`generate ${item} (external.blender.script@1 held-items recipe, scene.import.gltf@2)`);
    return buildHeldItem(root, item);
  }));
  const built = await Promise.all(items.map((item) => pool(item.build)));
  for (const [index, { key, role, resize: resized }] of items.entries()) {
    out.items[key] = built[index]!;
    await selectItem(key, role, resized ? await resize(key, out.items[key]!) : out.items[key]!);
  }
  // #467: the throwables are factor-only (no textures to resize); each level is a variant of its entry.
  for (const [index, { key, piece }] of RANGER_THROWABLES.entries()) {
    const { levels, lods } = await throwing[index]!;
    out.items[key] = levels[0]!.asset;
    await selectItem(key, WEAPON_ROLES[piece], levels[0]!.asset, lods);
    for (const { variant, asset } of levels.slice(1)) {
      out.selections.push({ key, variant });
      out.assets.push(asset);
    }
  }
  // #661: the held items follow every earlier entry, so those keep their order.
  for (const [index, { key }] of RANGER_HELD_ITEMS.entries()) {
    const { asset, observations } = await holding[index]!;
    out.items[key] = asset;
    await selectItem(key, observations.roles[0]!, asset, undefined, heldItemDescriptor(key, observations));
  }
  return out;
}
