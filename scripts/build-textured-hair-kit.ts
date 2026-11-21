// Build the textured hair kit (#557, docs/textured-hair-kit.md): curly, coily and braided hairstyles as attachable
// skinned pieces on the shared `Head` joint, fitted to the male and female heads, as their own rolling release:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-textured-hair-kit.ts --out <directory>
// The pieces are original: adapters/blender/textured_hair.py grows them on each head from the catalogued CC0 Universal
// Base Characters body (read as the fit target, never shipped). Every piece is split into its own scene, skinned to a
// `Head` joint at that figure's head rest pose (the inverse of its `head.hair` socket), given its accessory chains, and
// ships its textures as KTX2. Each entry has a `male` and a `female` variant; the young residents wear the same pieces
// scaled about `Head` (`young` in the descriptor). <directory> becomes the object-store root; the bundle is exported to
// <directory>/bundle and packed to <directory>/textured-hair.kit.tar. No game places the kit yet.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Logger, MathUtils, NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { addSecondaryChains, invert, type SecondaryChain, type SecondaryChainSpec } from "../src/humanoid-secondary.js";
import { buildKitPart, exportKitBundle, ktx2Asset, runKitCli, triangles, withKtx2Cache } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import { RANGER_FEMALE_SOCKETS_DESCRIPTOR, RANGER_FIGURES, RANGER_HAIR_TINTS, RANGER_SOCKETS_DESCRIPTOR } from "../src/ranger-figure.js";
import { slotKtx2Encoding, TERRAIN_KTX2 } from "../src/ktx2-encodings.js";
import { bindToHead } from "./build-hair-kit.ts";

type Json = Record<string, any>;

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const TEXTURED_HAIR_RELEASE = "textured-hair-kit";
export const TEXTURED_HAIR_TAR_NAME = "textured-hair.kit.tar";
export const TEXTURED_HAIR_DESCRIPTOR_SCHEMA = "textured-hair-kit-descriptor-v1";
export const TEXTURED_HAIR_DESCRIPTOR_ATTACHMENT = "textured-hair-descriptor";
export const TEXTURED_HAIR_HEAD_JOINT = "Head";
export const TEXTURED_HAIR_SOCKET = "head.hair";
/** The tintable material (one shared atlas); `hair.tie` keeps its leather colour. */
export const TEXTURED_HAIR_MATERIAL = "MI_Hair_Textured";
export const TEXTURED_HAIR_TIE = "hair.tie";
const ALLOWED_WARNINGS = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const UBC = "quaternius.universal-base-characters-standard";

export type TexturedHairFit = "male" | "female";
/** The heads every piece is fitted to: each is one variant of every entry. */
export const TEXTURED_HAIR_FITS: Record<TexturedHairFit, { figure: string; sockets: string; body: string }> = {
  male: { figure: RANGER_FIGURES.male.key, sockets: RANGER_SOCKETS_DESCRIPTOR, body: "Superhero_Male_FullBody" },
  female: { figure: RANGER_FIGURES.female.key, sockets: RANGER_FEMALE_SOCKETS_DESCRIPTOR, body: "Superhero_Female_FullBody" },
};
export const TEXTURED_HAIR_VARIANTS = Object.keys(TEXTURED_HAIR_FITS) as TexturedHairFit[];

/**
 * The young residents (#556) carry the adult heads uniformly scaled about the `Head` rest of their rig (`PROFILES` in
 * adapters/blender/young_residents.py). Their rig is the male one for boys and girls alike, so a girl's female head was
 * scaled about the male `Head`: a piece attaches under the young `Head` joint through the male `head.hair` socket,
 * scaled by `scale`, whichever fit it is. Measured from the young-residents release: each figure's head over the adult
 * head it came from (ear width and crown height).
 */
export const TEXTURED_HAIR_YOUNG: Record<string, { fit: TexturedHairFit; scale: number }> = {
  "young-residents.kit.teen-boy": { fit: "male", scale: 0.945 },
  "young-residents.kit.teen-girl": { fit: "female", scale: 0.89 },
  "young-residents.kit.child-boy": { fit: "male", scale: 0.906 },
  "young-residents.kit.child-girl": { fit: "female", scale: 0.898 },
};
/** The socket every young figure attaches through: its rig's (the male) `head.hair`. */
export const TEXTURED_HAIR_YOUNG_SOCKET_FIT: TexturedHairFit = "male";

/** The pieces, in entry order. */
export const TEXTURED_HAIR_PIECES = [
  { id: "hair.short-coils", label: "Short coils", headwear: true },
  { id: "hair.rounded-afro", label: "Rounded afro", headwear: false },
  { id: "hair.cornrows", label: "Cornrows", headwear: true },
  { id: "hair.box-braids", label: "Box braids", headwear: true },
  { id: "hair.box-braids-tied", label: "Box braids, tied back", headwear: true },
  { id: "hair.loose-curls", label: "Loose curls", headwear: true },
  { id: "hair.curly-bun", label: "Curly bun", headwear: false },
] as const;
export type TexturedHairPiece = (typeof TEXTURED_HAIR_PIECES)[number]["id"];

/** The vertical axis [x, z] the chains' directions are measured round (the head, as the Ranger's hair chains). */
const HEAD_AXIS: [number, number] = [0, -0.02];

/** A piece's accessory chains on one fit, from the recipe's landmarks (heights are glTF y). */
export function texturedHairChains(id: string, landmarks: { earTop: number; earBottom: number }, tie?: number[]): SecondaryChainSpec[] {
  const base = { kind: "hair" as const, parent: TEXTURED_HAIR_HEAD_JOINT, nodes: [id], axis: HEAD_AXIS };
  if (id === "hair.box-braids") {
    // Left, right and back: the loose braids swing in three hanks, the scalp stays on Head.
    return ([["hair.braids.back", "braids_back", 180], ["hair.braids.left", "braids_left", 90], ["hair.braids.right", "braids_right", 270]] as const).map(([chain, prefix, direction]) => ({
      ...base, id: chain, prefix, top: round5(landmarks.earBottom), count: 3, minSegment: 0.05, direction, select: { type: "sector" as const, power: 2 }, rampLength: 0.04, swingLimitDegrees: 15,
    }));
  }
  if (id === "hair.box-braids-tied") {
    if (!tie) throw new Error("the tied braids need their tie point");
    return [{ ...base, id: "hair.tail", prefix: "hair_tail", top: round5(tie[1]! - 0.01), count: 2, minSegment: 0.05, direction: 180, axis: [round5(tie[0]!), round5(tie[2]!)],
      select: { type: "radius", radius: 0.045 }, rampLength: 0.02, swingLimitDegrees: 25 }];
  }
  if (id === "hair.loose-curls") {
    return [{ ...base, id: "hair.curls.back", prefix: "curls_back", top: round5(landmarks.earBottom + 0.01), count: 2, minSegment: 0.04, direction: 180,
      select: { type: "sector", power: 2 }, rampLength: 0.03, swingLimitDegrees: 12 }];
  }
  return [];
}
const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

export function createTexturedHairSpec({ fit, scriptSha256, gltfSha256, bufferSha256, blenderVersion }: {
  fit: TexturedHairFit; scriptSha256: string; gltfSha256: string; bufferSha256: string; blenderVersion: string;
}) {
  const body = TEXTURED_HAIR_FITS[fit].body;
  return blenderScriptSpec({
    assetId: `textured-hair.kit.${fit}`,
    inputs: { script: { path: "textured_hair.py", sha256: scriptSha256 }, body: { path: `${body}.gltf`, sha256: gltfSha256 }, buffer: { path: `${body}.bin`, sha256: bufferSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, fit }, output: "hair.glb",
  });
}

/** A figure's head rest transform: the inverse of its `head.hair` socket. */
export async function texturedHairHeadRest(fit: TexturedHairFit) {
  const descriptor = JSON.parse(await readFile(path.resolve(import.meta.dir, "..", TEXTURED_HAIR_FITS[fit].sockets), "utf8"));
  const socket = (descriptor.sockets as Json[]).find((entry) => entry.id === TEXTURED_HAIR_SOCKET);
  if (!socket || socket.joint !== TEXTURED_HAIR_HEAD_JOINT) throw new Error(`${fit}: no ${TEXTURED_HAIR_SOCKET} socket on ${TEXTURED_HAIR_HEAD_JOINT}`);
  const matrix = MathUtils.compose(socket.translation, socket.rotation, [1, 1, 1], new Array(16) as never) as unknown as number[];
  const translation: [number, number, number] = [0, 0, 0], rotation: [number, number, number, number] = [0, 0, 0, 1], scale: [number, number, number] = [1, 1, 1];
  MathUtils.decompose(invert(matrix) as never, translation, rotation, scale);
  return { translation, rotation, bindMatrix: matrix, socket: { translation: socket.translation as number[], rotation: socket.rotation as number[] } };
}

/** One piece of the recipe's output: its mesh node, skinned to the head with its chains; everything else pruned. */
async function piece(root: string, asset: AssetRef, name: string, head: Awaited<ReturnType<typeof texturedHairHeadRest>>, specs: SecondaryChainSpec[]) {
  const io = new NodeIO().setAllowNetwork(false);
  const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
  document.setLogger(new Logger(Logger.Verbosity.ERROR));
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || node.getName() === name) continue;
    node.dispose();
    for (const primitive of mesh.listPrimitives()) primitive.dispose();
    mesh.dispose();
  }
  await document.transform(prune({ keepExtras: true }));
  if (!document.getRoot().listNodes().some((node) => node.getName() === name)) throw new Error(`the recipe output has no piece ${name}`);
  bindToHead(document, head);
  const chains = specs.length ? addSecondaryChains(document, specs) : [];
  const glb = (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: asset.kind, mediaType: asset.mediaType,
    metadata: { operation: "textured-hair-kit-piece-v1", piece: name, source: asset.sha256, chains: sha256Bytes(Buffer.from(JSON.stringify(specs))) } })).asset;
  return { glb, chains };
}

export async function buildTexturedHairKit({ outDir, log = () => {}, repositoryRoot = path.resolve(import.meta.dir, "..") }: { outDir: string; log?: (line: string) => void; repositoryRoot?: string }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const recipe = await readBlenderRecipeSource("textured_hair.py");
  const json = async (file: string) => JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8"));
  const [providers, sources, storage] = [await json("catalog/providers.json"), await json("catalog/sources.json"), await json("catalog/storage.json")];
  const rawSources: Json[] = sources.sources;
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const named = (name: string) => {
    const matches = rawSources.filter((source) => source.archiveMember?.archive === UBC && source.archiveMember.path.endsWith(`/Godot - UE/${name}`));
    if (matches.length !== 1) throw new Error(`'${name}' must be exactly one catalogued member`);
    return matches[0]!;
  };
  const bytesOf = async (sourceId: string) => new Uint8Array(await resolveAssetObject(root, (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: repositoryRoot, objectStoreRoot: root })).asset as never));

  type Variant = { fit: TexturedHairFit; asset: AssetRef; chains: SecondaryChain[] };
  const variants = new Map<string, Variant[]>(TEXTURED_HAIR_PIECES.map(({ id }) => [id, []]));
  const fits: Json = {};
  for (const fit of TEXTURED_HAIR_VARIANTS) {
    const { body } = TEXTURED_HAIR_FITS[fit];
    log(`grow the pieces on the ${fit} head (external.blender.script@1 textured hair recipe)`);
    const gltf = await bytesOf(named(`${body}.gltf`).id), buffer = await bytesOf(named(`${body}.bin`).id);
    const built = await buildKitPart(root, {
      workspace: path.join(root, "fits", fit), files: { "textured_hair.py": recipe.bytes, [`${body}.gltf`]: gltf, [`${body}.bin`]: buffer },
      spec: createTexturedHairSpec({ fit, scriptSha256: recipe.sha256, gltfSha256: sha256Bytes(gltf), bufferSha256: sha256Bytes(buffer), blenderVersion: recipe.blenderVersion }),
      allowedValidatorWarnings: ALLOWED_WARNINGS,
    });
    const head = await texturedHairHeadRest(fit);
    const records = new Map((built.observations.pieces as Json[]).map((record) => [record.node as string, record]));
    for (const { id } of TEXTURED_HAIR_PIECES) {
      const record = records.get(id);
      if (!record) throw new Error(`${fit}: the recipe built no ${id}`);
      const { glb, chains } = await piece(root, built.asset, id, head, texturedHairChains(id, built.observations.landmarks, record.tie));
      variants.get(id)!.push({ fit, asset: glb, chains });
    }
    fits[fit] = { figure: TEXTURED_HAIR_FITS[fit].figure, socket: { id: TEXTURED_HAIR_SOCKET, ...head.socket }, landmarks: built.observations.landmarks };
  }

  log("encode every texture as KTX2 (ktx create, TERRAIN_KTX2)");
  const delivered = await withKtx2Cache(TEXTURED_HAIR_RELEASE, async (cache) => {
    const out = new Map<string, AssetRef>();
    for (const list of variants.values()) for (const { asset } of list) {
      if (!out.has(asset.sha256)) out.set(asset.sha256, await ktx2Asset(root, asset, cache, { slotEncoding: slotKtx2Encoding }));
    }
    return out;
  });
  const shipped = (asset: AssetRef) => delivered.get(asset.sha256)!;
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const documents = new Map<string, Document>();
  for (const asset of delivered.values()) documents.set(asset.sha256, await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))));

  log("write the textured-hair descriptor");
  const hair = TEXTURED_HAIR_PIECES.map(({ id, label, headwear }) => {
    const list = variants.get(id)!;
    const materials = documents.get(shipped(list[0]!.asset).sha256)!.getRoot().listMaterials().map((material) => material.getName());
    return {
      id, entry: id, label, source: "authored", nodes: [id], socket: TEXTURED_HAIR_SOCKET, joint: TEXTURED_HAIR_HEAD_JOINT,
      joints: [TEXTURED_HAIR_HEAD_JOINT, ...list[0]!.chains.flatMap((chain) => chain.joints)],
      variants: list.map(({ fit }) => fit),
      tintMaterials: materials.filter((name) => name === TEXTURED_HAIR_MATERIAL), fixedMaterials: materials.filter((name) => name !== TEXTURED_HAIR_MATERIAL).sort(),
      hides: [] as string[],
      requires: { "outfit.hood": false },
      fitsUnderHeadwear: headwear,
      ...(list[0]!.chains.length ? { secondary: Object.fromEntries(list.map(({ fit, chains }) => [fit, chains])) } : {}),
      triangles: Object.fromEntries(list.map(({ fit, asset }) => [fit, triangles(documents.get(shipped(asset).sha256)!)])),
    };
  });
  const descriptor = {
    schema: TEXTURED_HAIR_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right",
    rig: {
      joint: TEXTURED_HAIR_HEAD_JOINT, socket: TEXTURED_HAIR_SOCKET,
      rule: `Every piece is skinned to a ${TEXTURED_HAIR_HEAD_JOINT} joint at its fit's rest pose, plus its own chain joints below it. Use the variant named for the figure's head (male or female). Attach the piece's scene to the figure's ${TEXTURED_HAIR_SOCKET} socket (the piece's ${TEXTURED_HAIR_HEAD_JOINT} then lands on the figure's ${TEXTURED_HAIR_HEAD_JOINT}), or bind its joints to a figure on the rig by name. A young resident wears its fit's variant under its own ${TEXTURED_HAIR_HEAD_JOINT} joint through \`young.<figure>.socket\` (its rig's, the male, socket) scaled uniformly by \`young.<figure>.scale\`: local transform = scale(s) × socket.`,
    },
    fits,
    young: Object.fromEntries(Object.entries(TEXTURED_HAIR_YOUNG).map(([figure, entry]) => [figure, { ...entry, socket: fits[TEXTURED_HAIR_YOUNG_SOCKET_FIT].socket }])),
    tints: Object.entries(RANGER_HAIR_TINTS).map(([id, color]) => ({ id: `tint.${id}`, baseColorFactor: [...color, 1] })),
    hair,
    textures: { ktx2: TERRAIN_KTX2 },
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "textured-hair-kit-descriptor", mediaType: "application/json" })).asset;

  const selections: Json[] = [], assets: AssetRef[] = [];
  for (const [index, { id }] of TEXTURED_HAIR_PIECES.entries()) for (const [variantIndex, { fit, asset }] of variants.get(id)!.entries()) {
    selections.push({ key: id, variant: fit, ...(index === 0 && variantIndex === 0 ? { attachments: [{ name: TEXTURED_HAIR_DESCRIPTOR_ATTACHMENT }] } : {}) });
    assets.push(shipped(asset));
  }
  const packed = await exportKitBundle(root, {
    tarName: TEXTURED_HAIR_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor, documents,
    lineage: {
      recipe: { script: "adapters/blender/textured_hair.py", sha256: recipe.sha256, blenderVersion: recipe.blenderVersion },
      release: TEXTURED_HAIR_RELEASE, descriptor: descriptorAsset,
      parts: Object.fromEntries([...variants.entries()].flatMap(([id, list]) => list.map(({ fit, asset }) => [`${id}/${fit}`, shipped(asset)]))),
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-textured-hair-kit.ts", TEXTURED_HAIR_RELEASE, buildTexturedHairKit, { descriptorFile: true });
