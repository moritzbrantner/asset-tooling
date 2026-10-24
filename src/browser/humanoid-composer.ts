// Composes a humanoid bundle character from its `humanoid-appearance-v1` and `humanoid-sockets-v2` attachments
// in plain three.js (#127 humanoid editing journey, docs/animation-viewer.md#editing-the-processed-character).
// The bundle variant supplies the skinned body and outfit, hair and armour entries are parented under their
// sockets, and the clips of the `default` variant play on every variant through the shared joint names.
// Presentation only: it reads the bundle's declarations and never invents a fit.
import { Group, PropertyBinding, Quaternion, type AnimationClip, type Material, type Mesh, type MeshStandardMaterial, type Object3D } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { characterAsset, type CharacterInstance } from "./three-character.ts";

type Rgba = [number, number, number, number];
export type HumanoidAppearance = {
  schema: "humanoid-appearance-v1";
  character: string;
  skins: { id: string; label: string; variant: string }[];
  parts: { id: string; nodes: string[]; defaultVisible: boolean }[];
  hair: { id: string; entry: string; socket: string; textures: { id: string; variant: string }[]; tintMaterials: string[]; requires?: Record<string, boolean> }[];
  tints: { id: string; baseColorFactor: Rgba; texture: string }[];
  eyebrows?: { nodes: string[]; tintMaterials: string[]; followsHairTint: boolean };
  outfits: {
    id: string; label: string; variant: string;
    skins?: { id: string; variant: string }[];
    armor?: { entry: string; pieces: { node: string; socket: string; hides: string[] }[] };
    base?: { outfit: string; hidden: string[] };
    garments?: { id: string; nodes: string[]; hides: string[] }[];
    faction?: { materials: string[]; defaultBaseColorFactor: Rgba };
  }[];
  levelsOfDetail: { level: string; of: string; variant: string; triangles: number }[];
  /** #348: face, eyes, nose and mouth options as morph weights on `nodes`, for the character variants in `variants`. */
  face?: {
    nodes: string[]; variants: string[]; unsupported: { variants: string[]; reason: string };
    features: { id: string; label: string; default: string; options: { id: string; label: string; morphs: Record<string, number> }[] }[];
  };
};
export type HumanoidSockets = { sockets: { id: string; joint: string; translation: number[]; rotation: number[] }[] };

/** One editable look. `hairColor` is a tint id or, untinted, a hair texture id; `face` maps each face feature to its option. */
export type HumanoidSelection = {
  skin: string; outfit: string; hood: boolean; hair: string | null; hairColor: string; lod: string; faction: string; face: Record<string, string>;
};

/** Loads one bundle entry (key + variant) as parsed glTF; the caller caches and declares the files. */
export type EntryLoader = (key: string, variant: string) => Promise<GLTF>;

const LOD0 = "lod0";
const HOOD = "outfit.hood";

export function defaultSelection(appearance: HumanoidAppearance): HumanoidSelection {
  const outfit = appearance.outfits[0]!;
  return {
    skin: appearance.skins[0]!.id,
    outfit: outfit.id,
    hood: appearance.parts.find((part) => part.id === HOOD)?.defaultVisible ?? false,
    hair: null,
    hairColor: appearance.tints[0]?.id ?? "",
    lod: LOD0,
    faction: factorToHex(outfit.faction?.defaultBaseColorFactor),
    face: Object.fromEntries((appearance.face?.features ?? []).map((feature) => [feature.id, feature.default])),
  };
}

/** The morph weights of the selected face options, or why they cannot be applied to `variant`. */
export function faceMorphs(appearance: HumanoidAppearance, selection: HumanoidSelection, variant: string): { morphs: Record<string, number> } | { problem: string } {
  const morphs: Record<string, number> = {};
  const features = appearance.face?.features ?? [];
  for (const [id, choice] of Object.entries(selection.face)) {
    const feature = features.find((candidate) => candidate.id === id);
    const option = feature?.options.find((candidate) => candidate.id === choice);
    if (!feature || !option) return { problem: `unknown face option ${id}=${choice}` };
    Object.assign(morphs, option.morphs);
  }
  if (Object.keys(morphs).length && !appearance.face!.variants.includes(variant)) {
    return { problem: `face options need a full-detail character; ${variant}: ${appearance.face!.unsupported.reason}` };
  }
  return { morphs };
}

/** Hair colour choices: every tint, then each hair texture that no tint is drawn over. */
export function hairColors(appearance: HumanoidAppearance): { id: string; label: string }[] {
  const tinted = new Set(appearance.tints.map((tint) => tint.texture));
  const textures = [...new Set(appearance.hair.flatMap((hair) => hair.textures.map((texture) => texture.id)))].filter((id) => !tinted.has(id));
  return [
    ...appearance.tints.map((tint) => ({ id: tint.id, label: `${tint.id.replace(/^tint\./, "")} tint` })),
    ...textures.map((id) => ({ id, label: `${id} texture, untinted` })),
  ];
}

/** The base variant of an outfit and skin, before levels of detail. */
export function baseVariant(appearance: HumanoidAppearance, selection: HumanoidSelection): string {
  const outfit = appearance.outfits.find((candidate) => candidate.id === selection.outfit);
  if (!outfit) throw new Error(`unknown outfit ${selection.outfit}`);
  if (outfit.skins) {
    const skin = outfit.skins.find((candidate) => candidate.id === selection.skin);
    if (!skin) throw new Error(`outfit ${outfit.id} has no ${selection.skin} variant`);
    return skin.variant;
  }
  // The archer outfit is the base character itself; its skins are the character skins.
  const skin = appearance.skins.find((candidate) => candidate.id === selection.skin);
  if (!skin) throw new Error(`unknown skin ${selection.skin}`);
  return skin.variant;
}

export function variantFor(appearance: HumanoidAppearance, selection: HumanoidSelection): string {
  const base = baseVariant(appearance, selection);
  if (selection.lod === LOD0) return base;
  const level = appearance.levelsOfDetail.find((candidate) => candidate.of === base && candidate.level === selection.lod);
  if (!level) throw new Error(`variant ${base} has no ${selection.lod}`);
  return level.variant;
}

/**
 * Why a selection cannot be composed, or null. `hasHood` says whether the selected variant carries the hood
 * part; a hairstyle that requires the hood off is incompatible while it is shown.
 */
export function incompatibility(appearance: HumanoidAppearance, selection: HumanoidSelection, hasHood: boolean): string | null {
  if (!selection.hair) return null;
  const hair = appearance.hair.find((candidate) => candidate.id === selection.hair);
  if (!hair) return `unknown hairstyle ${selection.hair}`;
  for (const [part, required] of Object.entries(hair.requires ?? {})) {
    const shown = part === HOOD ? hasHood && selection.hood : false;
    if (shown !== required) return `${hair.id} requires ${part} ${required ? "on" : "off"}; turn the hood ${required ? "on" : "off"} first`;
  }
  return null;
}

export type ComposedCharacter = CharacterInstance & { variant: string; triangles: number; hasHood: boolean };

const sanitized = (name: string) => PropertyBinding.sanitizeNodeName(name);
const byName = (root: Object3D, name: string) => root.getObjectByName(sanitized(name));

function factorToHex(factor: Rgba | undefined): string {
  if (!factor) return "#808080";
  // Factors are linear; the colour input is sRGB.
  const encode = (value: number) => {
    const srgb = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, srgb)) * 255).toString(16).padStart(2, "0");
  };
  return `#${encode(factor[0])}${encode(factor[1])}${encode(factor[2])}`;
}

function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((node) => { if ((node as Mesh).isMesh) found.push(node as Mesh); });
  return found;
}

/** Gives every mesh of `root` whose material is named in `names` its own copy of that material, and returns the copies. */
function ownMaterials(root: Object3D, names: string[], owned: Material[]): MeshStandardMaterial[] {
  const copies: MeshStandardMaterial[] = [];
  for (const mesh of meshes(root)) {
    const material = mesh.material as Material;
    if (Array.isArray(material) || !names.includes(material.name)) continue;
    const copy = material.clone() as MeshStandardMaterial;
    owned.push(copy);
    copies.push(copy);
    mesh.material = copy;
  }
  return copies;
}

/** Composes one posable character for `selection`. Fails, without side effects, on a missing entry, node or socket. */
export async function composeHumanoid({ appearance, sockets, selection, clips, load }: {
  appearance: HumanoidAppearance; sockets: HumanoidSockets; selection: HumanoidSelection; clips: AnimationClip[]; load: EntryLoader;
}): Promise<ComposedCharacter> {
  const outfit = appearance.outfits.find((candidate) => candidate.id === selection.outfit);
  if (!outfit) throw new Error(`unknown outfit ${selection.outfit}`);
  const variant = variantFor(appearance, selection);
  const face = faceMorphs(appearance, selection, variant);
  if ("problem" in face) throw new Error(face.problem);
  const body = await load(appearance.character, variant);
  const hair = selection.hair ? appearance.hair.find((candidate) => candidate.id === selection.hair) : undefined;
  if (selection.hair && !hair) throw new Error(`unknown hairstyle ${selection.hair}`);
  const tint = appearance.tints.find((candidate) => candidate.id === selection.hairColor);
  const textureId = tint ? tint.texture : selection.hairColor;
  const hairTexture = hair?.textures.find((texture) => texture.id === textureId);
  if (hair && !hairTexture) throw new Error(`${hair.id} has no ${textureId} texture`);
  const hairGltf = hair && hairTexture ? await load(hair.entry, hairTexture.variant) : undefined;
  const armorGltf = outfit.armor ? await load(outfit.armor.entry, "default") : undefined;

  const instance = characterAsset(body, clips).createInstance();
  const { root } = instance;
  const owned: Material[] = [];
  const hoodNodes = (appearance.parts.find((part) => part.id === HOOD)?.nodes ?? []).map((name) => byName(root, name)).filter((node) => node !== undefined);
  const hasHood = hoodNodes.length > 0;
  const problem = incompatibility(appearance, selection, hasHood);
  if (problem) throw new Error(problem);
  for (const node of hoodNodes) node.visible = selection.hood;
  if (appearance.face && appearance.face.variants.includes(variant)) {
    for (const name of appearance.face.nodes) {
      const node = byName(root, name);
      if (!node) throw new Error(`${variant} has no face node ${name}`);
      for (const mesh of meshes(node)) {
        const dictionary = mesh.morphTargetDictionary, influences = mesh.morphTargetInfluences;
        if (!dictionary || !influences) throw new Error(`${variant} face node ${name} has no morph targets`);
        influences.fill(0);
        for (const [target, weight] of Object.entries(face.morphs)) {
          const index = dictionary[target];
          if (index === undefined) throw new Error(`${variant} face node ${name} lacks the morph target ${target}`);
          influences[index] = weight;
        }
      }
    }
  }
  for (const name of [...(outfit.base?.hidden ?? []), ...(outfit.garments ?? []).flatMap((garment) => garment.hides)]) {
    const node = byName(root, name);
    if (node) node.visible = false;
  }

  const socketGroup = (id: string) => {
    const socket = sockets.sockets.find((candidate) => candidate.id === id);
    if (!socket) throw new Error(`socket ${id} is not declared in humanoid-sockets`);
    const joint = byName(root, socket.joint);
    if (!joint) throw new Error(`socket ${id} names joint ${socket.joint}, which ${variant} lacks`);
    const group = new Group();
    group.name = `socket:${id}`;
    group.position.fromArray(socket.translation);
    group.quaternion.copy(new Quaternion().fromArray(socket.rotation));
    joint.add(group);
    return group;
  };

  if (outfit.armor && armorGltf) {
    for (const piece of outfit.armor.pieces) {
      const source = byName(armorGltf.scene, piece.node);
      if (!source) throw new Error(`${outfit.armor.entry} has no piece ${piece.node}`);
      socketGroup(piece.socket).add(source.clone());
      for (const name of piece.hides) { const node = byName(root, name); if (node) node.visible = false; }
    }
  }
  if (outfit.faction) {
    for (const material of ownMaterials(root, outfit.faction.materials, owned)) material.color.set(selection.faction);
  }
  if (hair && hairGltf) {
    const attached = hairGltf.scene.clone();
    socketGroup(hair.socket).add(attached);
    if (tint) {
      for (const material of ownMaterials(attached, hair.tintMaterials, owned)) material.color.setRGB(tint.baseColorFactor[0], tint.baseColorFactor[1], tint.baseColorFactor[2]);
      const brows = appearance.eyebrows;
      if (brows?.followsHairTint) {
        for (const name of brows.nodes) {
          const node = byName(root, name);
          if (!node) continue;
          for (const material of ownMaterials(node, brows.tintMaterials, owned)) material.color.setRGB(tint.baseColorFactor[0], tint.baseColorFactor[1], tint.baseColorFactor[2]);
        }
      }
    }
  }

  let triangles = 0;
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !node.visible) return;
    let ancestor: Object3D | null = node;
    while (ancestor) { if (!ancestor.visible) return; ancestor = ancestor.parent; }
    const geometry = mesh.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;
  });
  return {
    root, variant, hasHood, triangles,
    seek: instance.seek,
    dispose() { instance.dispose(); for (const material of owned) material.dispose(); },
  };
}
