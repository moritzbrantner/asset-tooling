// The Ranger figures' shared definition: the catalog members each figure is built from, its appearance sources, the
// head subset and hips, the Peasant outfits and the texture policy (docs/humanoid-ranger.md). The Ranger build
// (scripts/build-ranger-character.ts) and the kits fitted to its figures (hair-kit, redbrand-kit) all read it here, so
// a kit's release sources are these constants and not the whole Ranger build (#517).
type Json = Record<string, any>;
const POLICY = { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] };

export const RANGER_MEMBERS = {
  body: { archive: "quaternius.universal-base-characters-standard", path: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf" },
  outfit: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf" },
  clips: { archive: "quaternius.universal-animation-library-standard", path: "Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb" },
  clips2: { archive: "quaternius.universal-animation-library-2-standard", path: "Universal Animation Library 2 [Standard]/Unreal-Godot/UAL2_Standard.glb" },
} as const;
/** #257: per-slot maximum texture edges for browser delivery; images are never upscaled. */
export const RANGER_TEXTURE_POLICY = {
  maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 },
  default: 1024,
} as const;

/**
 * The Ranger figures (#115, owner answer Q1 = A): the male Ranger, and the female Ranger built from the UBC female
 * body and the Female_Ranger outfit with the same clips, equipment and recipe.
 */
export type RangerFigure = "male" | "female";
export const RANGER_FIGURES = {
  male: { key: "humanoid.ranger.male", body: RANGER_MEMBERS.body, outfit: RANGER_MEMBERS.outfit, headMeshes: ["Face", "Face.001"] },
  female: {
    key: "humanoid.ranger.female",
    body: { archive: "quaternius.universal-base-characters-standard", path: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Female_FullBody.gltf" },
    outfit: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Female_Ranger.gltf" },
    headMeshes: ["Eyebrows", "Eyes"],
  },
} as const satisfies Record<RangerFigure, { key: string; body: { archive: string; path: string }; outfit: { archive: string; path: string }; headMeshes: readonly string[] }>;
export const RANGER_FEMALE_SOCKETS_DESCRIPTOR = "assets/descriptors/humanoid.ranger.female.sockets.json";

/**
 * Appearance (#116, owner answers 2026-10-17: Light and Dark skins, hairstyles per figure, both hair textures,
 * black/brown/blond tints, a toggleable hood). Skin variants re-import the body and outfit with the Light base
 * colours bound to their URIs; the outfit's skin texture has no Light original, so it is derived (Q13 = A).
 */
export const UBC = "quaternius.universal-base-characters-standard";
export const UBC_HAIR_DIR = "Universal Base Characters[Standard]/Hairstyles/Origin at 0/glTF (Godot)";
export const RANGER_APPEARANCE = {
  male: {
    skinLight: { body: { uri: "T_Superhero_Male_Dark.png", member: "Universal Base Characters[Standard]/Base Characters/Textures/T_Superhero_Male_Ligh.png" }, outfitUri: "T_Regular_Male_Dark_BaseColor.png" },
    hood: "Male_Ranger_Head_Hood",
    hair: ["Hair_Buzzed", "Hair_SimpleParted", "Hair_Long"],
    // #336: Hair_Long is only a fringe and a back curtain; the buzzed cap covers its bare crown in the same entry.
    crowns: { Hair_Long: "Hair_Buzzed" } as Record<string, string>,
    eyebrows: "Eyebrows",
  },
  female: {
    skinLight: { body: { uri: "T_Superhero_Female_Dark_BaseColor.png", member: "Universal Base Characters[Standard]/Base Characters/Textures/T_Superhero_Female_Light_BaseColor.png" }, outfitUri: "T_Regular_Female_Dark_BaseColor.png" },
    hood: "Female_Ranger_Head_Hood",
    hair: ["Hair_Long", "Hair_Buns"],
    crowns: {} as Record<string, string>,
    eyebrows: "Eyebrows",
  },
} as const;
/**
 * One glTF from several static source glTFs with one buffer each (#336): every top-level array concatenated with its
 * references rebased, the buffers joined into one (4-byte aligned) named `bufferUri`, and one scene holding every
 * part's root nodes. Image URIs stay as they are and must not collide.
 */
export function mergeStaticGltfJson(parts: readonly { json: Json; buffer: Uint8Array }[], bufferUri: string): { json: Json; buffer: Uint8Array } {
  const out: Json = { asset: parts[0]!.json.asset, scene: 0, scenes: [{ nodes: [] }], buffers: [] };
  const arrays = ["bufferViews", "accessors", "images", "samplers", "textures", "materials", "meshes", "nodes"] as const;
  for (const name of arrays) out[name] = [];
  const uris = new Set<string>(), chunks: Uint8Array[] = [];
  let offset = 0;
  for (const { json: part, buffer } of parts) {
    if (part.skins?.length || part.animations?.length) throw new Error("mergeStaticGltfJson merges static glTFs only");
    if (part.buffers?.length !== 1 || part.buffers[0].byteLength !== buffer.byteLength) throw new Error("each merged glTF part needs exactly its one buffer");
    const base = Object.fromEntries(arrays.map((name) => [name, out[name].length])) as Record<(typeof arrays)[number], number>;
    const copy = (value: unknown) => structuredClone(value) as Json;
    const texture = (info: Json | undefined) => info && { ...info, index: info.index + base.textures };
    for (const image of part.images ?? []) {
      if (uris.has(image.uri)) throw new Error(`merged glTF parts share the URI '${image.uri}'`);
      uris.add(image.uri); out.images.push(copy(image));
    }
    for (const view of part.bufferViews ?? []) out.bufferViews.push({ ...copy(view), buffer: 0, byteOffset: (view.byteOffset ?? 0) + offset });
    for (const accessor of part.accessors ?? []) out.accessors.push({ ...copy(accessor), ...(accessor.bufferView === undefined ? {} : { bufferView: accessor.bufferView + base.bufferViews }) });
    for (const sampler of part.samplers ?? []) out.samplers.push(copy(sampler));
    for (const item of part.textures ?? []) out.textures.push({ ...copy(item), source: item.source + base.images, ...(item.sampler === undefined ? {} : { sampler: item.sampler + base.samplers }) });
    for (const material of part.materials ?? []) {
      const result = copy(material), pbr = result.pbrMetallicRoughness;
      for (const key of ["normalTexture", "occlusionTexture", "emissiveTexture"]) if (result[key]) result[key] = texture(result[key]);
      if (pbr) for (const key of ["baseColorTexture", "metallicRoughnessTexture"]) if (pbr[key]) pbr[key] = texture(pbr[key]);
      out.materials.push(result);
    }
    for (const mesh of part.meshes ?? []) out.meshes.push({ ...copy(mesh), primitives: mesh.primitives.map((primitive: Json) => ({
      ...copy(primitive),
      attributes: Object.fromEntries(Object.entries(primitive.attributes as Record<string, number>).map(([key, index]) => [key, index + base.accessors])),
      ...(primitive.indices === undefined ? {} : { indices: primitive.indices + base.accessors }),
      ...(primitive.material === undefined ? {} : { material: primitive.material + base.materials }),
    })) });
    for (const node of part.nodes ?? []) out.nodes.push({ ...copy(node), ...(node.mesh === undefined ? {} : { mesh: node.mesh + base.meshes }),
      ...(node.children ? { children: node.children.map((child: number) => child + base.nodes) } : {}) });
    for (const root of part.scenes[part.scene ?? 0].nodes) out.scenes[0].nodes.push(root + base.nodes);
    const padded = (buffer.byteLength + 3) & ~3;
    chunks.push(buffer, new Uint8Array(padded - buffer.byteLength));
    offset += padded;
  }
  const joined = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
  out.buffers = [{ uri: bufferUri, byteLength: offset }];
  return { json: out, buffer: joined };
}
/** Hair tints (D4, linear RGB), applied as the base colour factor on top of `T_Hair_1`. */
export const RANGER_HAIR_TINTS = { black: [0.02, 0.02, 0.02], brown: [0.18, 0.09, 0.04], blond: [0.62, 0.48, 0.25], grey: [0.9, 0.9, 0.88] } as const;
/**
 * Outfits (#117, owner answers 2026-10-17): the archer is the Ranger outfit (`default`); the soldier and the knight
 * wear the Peasant outfit under original armour from adapters/blender/armor.py (male figure first, Q8). Each outfit is a
 * character variant with the same skeleton and clips; its rigid plates are one `armor.<kit>` entry whose nodes ride the
 * `<joint>.armor` sockets, and its skinned garments are composed into the variant.
 */
export const RANGER_PEASANT_OUTFITS = {
  male: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Peasant.gltf" },
  // #378: the female Peasant outfit, under the tanner's skirt and apron.
  female: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Female_Peasant.gltf" },
} as const satisfies Record<RangerFigure, { archive: string; path: string }>;

/** The head/face subset of the UBC body (docs/gltf-subset.md, owner option A on #110). */
export const RANGER_HEAD_RECIPE = { keepJoints: ["neck_01", "Head"], minWeight: 0.5, keepMeshes: ["Face", "Face.001"], policy: POLICY };

/** Hips joints whose model-space height is each rig's reference height (`source` = UAL1, `source2` = UAL2). */
export const RANGER_HIPS = { source: "DEF-hips", source2: "pelvis", target: "pelvis" } as const;
/** The male sockets descriptor (hand, stowed, archery, hair, armour and staff sockets; examples/weapons/derive-sockets.ts). */
export const RANGER_SOCKETS_DESCRIPTOR = "assets/descriptors/humanoid.ranger.male.sockets.json";
