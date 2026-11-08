// Build the hair and beard kit (#517, docs/hair-kit.md): attachable skinned pieces on the male Ranger head joints, as
// their own rolling release:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-hair-kit.ts --out <directory>
// The hand-modelled hairstyles and beards are authored geometry in assets/authored/hair-kit.blend; the pack hairstyles
// (Hair_Buzzed, Hair_SimpleParted, Hair_Long) stay recipe-built from the catalog, because a third-party mesh stays out
// of the .blend (Decision 3.1.3). Every piece gets the Ranger's build keys (facial hair also the age keys) through the
// same operations as the Ranger build, is skinned to a `Head` joint at the head's rest pose with its accessory chain
// joints below it, and ships its textures as KTX2. A piece attaches to any male figure on the Ranger rig through the
// existing `head.hair` and `head.armor` sockets (they are the inverse of the head's rest transform, so the piece's
// `Head` lands on the figure's `Head`), or by binding its joints to the figure's by name. <directory> becomes the
// object-store root; the bundle is exported to <directory>/bundle and packed to <directory>/hair.kit.tar.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Logger, MathUtils, NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readAuthoredBlenderSource, readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { runBlenderRecipe } from "../src/blender-recipe-run.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { RANGER_BEARD_CHAINS, RANGER_HAIR_CHAINS, addSecondaryChains, invert, type SecondaryChain, type SecondaryChainSpec } from "../src/humanoid-secondary.js";
import { exportKitBundle, ktx2Asset, runKitCli, single, triangles, withKtx2Cache } from "../src/kit-bundle.js";
import { VARIETY_AGE_TARGETS, VARIETY_BEARDS, VARIETY_BUILD_TARGETS, VARIETY_HAIRSTYLES, applyVarietyKeys, authorVarietyKeys } from "../src/male-variety.js";
import type { AssetRef } from "../src/operations.js";
import {
  RANGER_APPEARANCE, RANGER_FIGURES, RANGER_HAIR_TINTS, RANGER_HEAD_RECIPE, RANGER_HIPS, RANGER_PEASANT_OUTFITS, RANGER_SOCKETS_DESCRIPTOR,
  RANGER_TEXTURE_POLICY, mergeStaticGltfJson,
} from "./build-ranger-character.ts";
import { redbrandTextureEncoding } from "./build-redbrand-kit.ts";
import { cachedCompose, cachedExtract, cachedImport, cachedSubset, cachedTextureResize } from "./cached-operations.ts";
import { TERRAIN_KTX2 } from "./build-greyhaven-terrain.ts";
import { useSharedGenerationCache } from "./generation-cache.ts";

type Json = Record<string, any>;
type AuthoredOutput = "hair" | "beards";

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const HAIR_RELEASE = "hair-kit";
export const HAIR_TAR_NAME = "hair.kit.tar";
export const HAIR_GEOMETRY = "assets/authored/hair-kit.blend";
export const HAIR_DESCRIPTOR_SCHEMA = "hair-kit-descriptor-v1";
export const HAIR_DESCRIPTOR_ATTACHMENT = "hair-descriptor";
/** The figure whose rig and sockets the pieces share (male only: the hand-modelled pieces are fitted to the male head). */
export const HAIR_FIGURE = RANGER_FIGURES.male.key;
/** The joint every piece is skinned to. */
export const HAIR_HEAD_JOINT = "Head";
export const HAIR_SOCKET = "head.hair";
export const BEARD_SOCKET = "head.armor";
/** The `hair-1`/`hair-2` variants of a pack hairstyle; a hand-modelled style and a beard ship their own one variant. */
export const HAIR_PACK_VARIANTS = ["hair-1", "hair-2"] as const;
export const HAIR_AUTHORED_VARIANT = "hair-1";
export const BEARD_VARIANT = "default";
/** The hairstyles' tintable material prefix (the leather tie of `hair.tied` keeps its colour). */
const TINT_PREFIX = "MI_Hair";
const POLICY = { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] };
const UBC = "quaternius.universal-base-characters-standard";
const UBC_HAIR_DIR = "Universal Base Characters[Standard]/Hairstyles/Origin at 0/glTF (Godot)";
const hairKey = (style: string) => `hair.${style.replace(/^Hair_/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;

/** A pack hairstyle's entry key, as the Ranger's descriptor names it. */
export const HAIR_PACK_STYLES = RANGER_APPEARANCE.male.hair.map((style) => ({ style, key: hairKey(style) }));

export function createHairKitAssetSpec({ output, scriptSha256, kitSha256, materialSha256, blenderVersion }: {
  output: AuthoredOutput; scriptSha256: string; kitSha256: string; materialSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: `hair.kit.${output}`,
    inputs: {
      script: { path: "hair_kit.py", sha256: scriptSha256 }, kit: { path: "hair-kit.blend", sha256: kitSha256 },
      material: { path: "material.glb", sha256: materialSha256 },
    },
    blenderVersion, arguments: { schemaVersion: 1, output }, output: "hair.glb",
  });
}

/**
 * What the pieces are fitted against, built like the Ranger build builds it (same members, operations and parameters,
 * so the shared cache serves both builds): the fit target (the Peasant outfit and the plain head on the Ranger skeleton),
 * the Ranger rig and every pack hairstyle as the Ranger imports it, its crown merged in.
 */
export async function hairFitParts(root: string, log: (line: string) => void = () => {}) {
  const shape = RANGER_FIGURES.male, look = RANGER_APPEARANCE.male;
  const repository = path.resolve(import.meta.dir, "..");
  const json = async (file: string) => JSON.parse(await Bun.file(path.join(repository, file)).text());
  const [providers, sources, storage] = [await json("catalog/providers.json"), await json("catalog/sources.json"), await json("catalog/storage.json")];
  const rawSources: Json[] = sources.sources;
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const memberId = ({ archive, path: memberPath }: { archive: string; path: string }) => {
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
    if (matches.length !== 1) throw new Error(`'${memberPath}' must be registered exactly once`);
    return matches[0]!.id as string;
  };
  const resourceId = (archive: string, gltfId: string, uri: string) => {
    const substitutes = rawSources.filter((source) => source.metadata?.substitutesFor?.some((entry: Json) => entry.member === gltfId && entry.uri === uri));
    if (substitutes.length === 1) return substitutes[0]!.id as string;
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === uri);
    if (matches.length !== 1) throw new Error(`URI '${uri}' must resolve to exactly one member`);
    return matches[0]!.id as string;
  };
  const member = async (sourceId: string) =>
    (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: repository, objectStoreRoot: root })).asset as AssetRef;
  const importGltf = async (entry: { archive: string; path: string }) => {
    const gltfId = memberId(entry);
    const source = await member(gltfId);
    const document = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
    const uris: string[] = [...(document.buffers ?? []), ...(document.images ?? [])].map((item: Json) => item.uri);
    const resources: AssetRef[] = [];
    for (const uri of uris) resources.push(await member(resourceId(entry.archive, gltfId, uri)));
    return single(await cachedImport(root, { inputs: { source, resources }, parameters: { resourceUris: uris, policy: POLICY } }));
  };
  log("import the Ranger outfit and body, head subset, rig and fit target");
  const outfit = await importGltf(shape.outfit);
  const body = await importGltf(shape.body);
  const head = single(await cachedSubset(root, { inputs: { source: body }, parameters: { ...RANGER_HEAD_RECIPE, keepMeshes: [...shape.headMeshes] } }));
  const composed = single(await cachedCompose(root, { inputs: { skeleton: outfit, parts: [head] }, parameters: { policy: POLICY } }));
  const targetRig = single(await cachedExtract(root, { inputs: { source: composed }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
  const peasant = await importGltf(RANGER_PEASANT_OUTFITS.male);
  const fitTarget = single(await cachedCompose(root, { inputs: { skeleton: peasant, parts: [head] }, parameters: { policy: POLICY } }));

  log("import the pack hairstyles (scene.import.gltf@2)");
  const hairEntry = (style: string) => ({ archive: UBC, path: `${UBC_HAIR_DIR}/${style}.gltf` });
  const importHair = async (style: string) => {
    const crown = (look.crowns as Record<string, string>)[style];
    if (!crown) return importGltf(hairEntry(style));
    const entries = [hairEntry(style), hairEntry(crown)];
    const merged = await Promise.all(entries.map(async (entry) => {
      const gltfId = memberId(entry), first = await member(gltfId);
      const document = JSON.parse((await resolveAssetObject(root, first)).toString("utf8"));
      const buffer = new Uint8Array(await resolveAssetObject(root, await member(resourceId(UBC, gltfId, document.buffers[0].uri))));
      const images = await Promise.all(document.images.map((image: Json) => member(resourceId(UBC, gltfId, image.uri))));
      return { first, json: document, buffer, images, imageUris: document.images.map((image: Json) => image.uri as string) };
    }));
    const bufferUri = `${style}_${crown}.bin`;
    const packed = mergeStaticGltfJson(merged, bufferUri);
    const { first } = merged[0]!;
    const source = (await storeAssetObject(root, { bytes: Buffer.from(JSON.stringify(packed.json)), kind: first.kind, mediaType: first.mediaType })).asset;
    const buffer = (await storeAssetObject(root, { bytes: Buffer.from(packed.buffer), kind: "buffer", mediaType: "application/octet-stream" })).asset;
    return single(await cachedImport(root, { inputs: { source, resources: [buffer, ...merged.flatMap(({ images }) => images)] },
      parameters: { resourceUris: [bufferUri, ...merged.flatMap(({ imageUris }) => imageUris)], policy: POLICY } }));
  };
  const hair = await Promise.all(HAIR_PACK_STYLES.map(async ({ style, key }) => ({ key, style, imported: await importHair(style) })));
  return { fitTarget, targetRig, hair };
}

/** The head joint's rest world transform: the inverse of the `head.hair` socket, which is the inverse of it. */
export async function headRest() {
  const descriptor = JSON.parse(await readFile(path.resolve(import.meta.dir, "..", RANGER_SOCKETS_DESCRIPTOR), "utf8"));
  const socket = (descriptor.sockets as Json[]).find((entry) => entry.id === HAIR_SOCKET);
  if (!socket || socket.joint !== HAIR_HEAD_JOINT) throw new Error(`the sockets descriptor has no ${HAIR_SOCKET} socket on ${HAIR_HEAD_JOINT}`);
  const matrix = MathUtils.compose(socket.translation, socket.rotation, [1, 1, 1], new Array(16) as never) as unknown as number[];
  const translation: [number, number, number] = [0, 0, 0], rotation: [number, number, number, number] = [0, 0, 0, 1], scale: [number, number, number] = [1, 1, 1];
  MathUtils.decompose(invert(matrix) as never, translation, rotation, scale);
  return { translation, rotation, bindMatrix: matrix };
}

/** Skins every mesh of `document` to a new `Head` joint at the head's rest pose, every vertex fully on it. */
export function bindToHead(document: Document, head: Awaited<ReturnType<typeof headRest>>) {
  const root = document.getRoot();
  const buffer = root.listBuffers()[0] ?? document.createBuffer();
  const joint = document.createNode(HAIR_HEAD_JOINT).setTranslation(head.translation).setRotation(head.rotation);
  (root.getDefaultScene() ?? root.listScenes()[0]!).addChild(joint);
  const ibm = document.createAccessor().setType("MAT4").setArray(new Float32Array(head.bindMatrix)).setBuffer(buffer);
  const skin = document.createSkin(`${HAIR_HEAD_JOINT}-skin`).addJoint(joint).setSkeleton(joint).setInverseBindMatrices(ibm);
  for (const node of root.listNodes()) {
    if (!node.getMesh()) continue;
    if (node.getParentNode()) throw new Error(`piece node ${node.getName()} must be a scene root (it would inherit a transform once skinned)`);
    if (![...node.getTranslation(), ...node.getRotation(), ...node.getScale()].every((value, index) => Math.abs(value - [0, 0, 0, 0, 0, 0, 1, 1, 1, 1][index]!) < 1e-6)) {
      throw new Error(`piece node ${node.getName()} must sit at the origin, as the socket contract assumes`);
    }
    node.setSkin(skin);
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const count = primitive.getAttribute("POSITION")!.getCount();
      const weights = new Float32Array(count * 4);
      for (let index = 0; index < count; index += 1) weights[index * 4] = 1;
      primitive.setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(new Uint16Array(count * 4)).setBuffer(buffer));
      primitive.setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(weights).setBuffer(buffer));
    }
  }
}

/** The piece named `name` alone: its mesh node and materials, everything else pruned. */
async function pieceOf(root: string, asset: AssetRef, name: string) {
  const io = new NodeIO();
  const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
  document.setLogger(new Logger(Logger.Verbosity.ERROR));
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || node.getName() === name) continue;
    node.dispose();
    for (const primitive of mesh.listPrimitives()) {
      for (const target of primitive.listTargets()) target.dispose();
      primitive.dispose();
    }
    mesh.dispose();
  }
  await document.transform(prune({ keepExtras: true }));
  return (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: asset.kind, mediaType: asset.mediaType, metadata: { operation: "hair-kit-piece-v1", piece: name, source: asset.sha256 } })).asset;
}

/** The chains a piece gets, moved from the Ranger's `hair_root`/`beard_root` onto the `Head` joint, each on this piece only. */
export function chainsFor(id: string): SecondaryChainSpec[] {
  const specs = RANGER_HAIR_CHAINS[id] ?? (RANGER_BEARD_CHAINS[0]!.nodes.includes(id) ? RANGER_BEARD_CHAINS.map((spec) => ({ ...spec, nodes: [id], anchor: [id] })) : []);
  return specs.map((spec) => ({ ...spec, parent: HAIR_HEAD_JOINT }));
}

/** `asset` skinned to the head joint with its accessory chains; returns it and the chains that took weight. */
async function bindPiece(root: string, asset: AssetRef, id: string, head: Awaited<ReturnType<typeof headRest>>) {
  const io = new NodeIO().setAllowNetwork(false);
  const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
  bindToHead(document, head);
  const specs = chainsFor(id);
  const chains = specs.length ? addSecondaryChains(document, specs) : [];
  const glb = (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: asset.kind, mediaType: asset.mediaType,
    metadata: { operation: "hair-kit-bind-v1", source: asset.sha256, chains: sha256Bytes(Buffer.from(JSON.stringify(specs))) } })).asset;
  return { glb, chains };
}

export async function buildHairKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const script = await readBlenderRecipeSource("hair_kit.py");
  const kit = await readAuthoredBlenderSource(HAIR_GEOMETRY);
  const parts = await hairFitParts(root, log);
  const head = await headRest();
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const resize = (asset: AssetRef) => cachedTextureResize(root, { inputs: { source: asset }, parameters: { ...RANGER_TEXTURE_POLICY, policy: POLICY } }).then((result) => single(result));

  type Variant = { id: string; asset: AssetRef };
  type Piece = {
    id: string; kind: "hair" | "beard"; label?: string; source: string; socket: string; variants: Variant[]; chains: SecondaryChain[];
    tintMaterials: string[]; fixedMaterials: string[]; nodes: string[]; ages: boolean;
  };
  const pieces: Piece[] = [];
  const materials = async (asset: AssetRef) => (await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, asset)))).getRoot().listMaterials().map((material) => material.getName());
  const meshNodes = async (asset: AssetRef) => (await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, asset)))).getRoot().listNodes().filter((node) => node.getMesh()).map((node) => node.getName()).sort();
  const tint = (names: string[]) => names.filter((name) => name.startsWith(TINT_PREFIX));
  const fixed = (names: string[]) => names.filter((name) => !name.startsWith(TINT_PREFIX)).sort();
  const variety: Json = {};

  // The pack hairstyles: the Ranger's import, resize and build keys, then the head skin.
  for (const { key, style, imported } of parts.hair) {
    log(`build keys on ${key} (adapters/blender/male_variety.py, #380)`);
    const resized = await resize(imported);
    const authored = await authorVarietyKeys(root, key, { mode: "item", source: resized, body: parts.fitTarget });
    variety[key] = authored.observations;
    const keyed = await applyVarietyKeys(root, resized, authored.bytes, key);
    const { glb, chains } = await bindPiece(root, keyed.glb, key, head);
    const names = await materials(glb);
    pieces.push({
      id: key, kind: "hair", source: style, socket: HAIR_SOCKET, variants: HAIR_PACK_VARIANTS.map((id) => ({ id, asset: glb })), chains,
      tintMaterials: tint(names), fixedMaterials: fixed(names), nodes: await meshNodes(glb), ages: false,
    });
  }

  // The hand-modelled pieces: the authored geometry wearing the pack's MI_Hair_1, keyed, resized and split per piece.
  const material = parts.hair.find(({ key }) => key === "hair.buzzed")!.imported;
  const materialBytes = new Uint8Array(await resolveAssetObject(root, material));
  const authored = async (output: AuthoredOutput) => {
    log(`build the authored ${output} (external.blender.script@1 hair kit recipe)`);
    const { glb, observations } = await runBlenderRecipe(root, {
      workspace: path.join(root, "hair-kit", output),
      files: { "hair_kit.py": script.bytes, "hair-kit.blend": kit.bytes, "material.glb": materialBytes },
      spec: createHairKitAssetSpec({ output, scriptSha256: script.sha256, kitSha256: kit.sha256, materialSha256: sha256Bytes(materialBytes), blenderVersion: script.blenderVersion }),
    });
    const imported = single(await cachedImport(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
    log(`build${output === "beards" ? " and age" : ""} keys on the authored ${output} (adapters/blender/male_variety.py, #380)`);
    const keys = await authorVarietyKeys(root, `hair.kit.${output}`, { mode: "item", source: imported, body: parts.fitTarget, age: output === "beards" });
    variety[`hair.kit.${output}`] = keys.observations;
    const keyed = await applyVarietyKeys(root, await resize(imported), keys.bytes, `hair.kit.${output}`);
    return { keyed: keyed.glb, pieces: observations.pieces as Json[] };
  };
  const addAuthored = async (built: Awaited<ReturnType<typeof authored>>, kind: "hair" | "beard", socket: string, variant: string, ids: readonly string[]) => {
    const records = new Map(built.pieces.map((piece) => [piece.node as string, piece]));
    for (const id of ids) {
      const record = records.get(id);
      if (!record) throw new Error(`the authored geometry has no piece ${id}`);
      const asset = await pieceOf(root, built.keyed, id);
      const { glb, chains } = await bindPiece(root, asset, id, head);
      pieces.push({
        id, kind, ...(kind === "beard" ? { label: VARIETY_BEARDS[id as keyof typeof VARIETY_BEARDS] } : {}), source: "authored", socket,
        variants: [{ id: variant, asset: glb }], chains, tintMaterials: tint(record.materials), fixedMaterials: fixed(record.materials),
        nodes: [id], ages: kind === "beard",
      });
    }
  };
  await addAuthored(await authored("hair"), "hair", HAIR_SOCKET, HAIR_AUTHORED_VARIANT, VARIETY_HAIRSTYLES);
  await addAuthored(await authored("beards"), "beard", BEARD_SOCKET, BEARD_VARIANT, Object.keys(VARIETY_BEARDS));

  log("encode every texture as KTX2 (ktx create, TERRAIN_KTX2)");
  const delivered = await withKtx2Cache("hair-kit", async (cache) => {
    const out = new Map<string, AssetRef>();
    for (const piece of pieces) for (const { asset } of piece.variants) {
      if (!out.has(asset.sha256)) out.set(asset.sha256, await ktx2Asset(root, asset, cache, { slotEncoding: redbrandTextureEncoding }));
    }
    return out;
  });
  const shipped = (asset: AssetRef) => delivered.get(asset.sha256)!;
  const documents = new Map<string, Document>();
  for (const asset of delivered.values()) documents.set(asset.sha256, await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))));

  log("write the hair-kit descriptor");
  const record = (piece: Piece) => ({
    id: piece.id, entry: piece.id, kind: piece.kind, ...(piece.label ? { label: piece.label } : {}), source: piece.source, nodes: piece.nodes,
    socket: piece.socket, joint: HAIR_HEAD_JOINT,
    joints: [HAIR_HEAD_JOINT, ...piece.chains.flatMap((chain) => chain.joints)],
    variants: piece.variants.map(({ id }) => id),
    tintMaterials: piece.tintMaterials, fixedMaterials: piece.fixedMaterials,
    // No piece covers head geometry: the head mesh, eyes and eyebrows stay as they are.
    hides: [] as string[],
    ...(piece.kind === "hair" ? { requires: { "outfit.hood": false } } : {}),
    ...(piece.chains.length ? { secondary: piece.chains } : {}),
    morphs: { build: VARIETY_BUILD_TARGETS, ...(piece.ages ? { age: VARIETY_AGE_TARGETS } : {}) },
    triangles: triangles(documents.get(shipped(piece.variants[0]!.asset).sha256)!),
  });
  const tints = Object.entries(RANGER_HAIR_TINTS).map(([id, color]) => ({ id: `tint.${id}`, baseColorFactor: [...color, 1] }));
  const { jointNames } = JSON.parse((await resolveAssetObject(root, parts.targetRig)).toString("utf8"));
  const descriptor = {
    schema: HAIR_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right",
    figure: HAIR_FIGURE,
    rig: {
      jointCount: jointNames.length, sha256: parts.targetRig.sha256, joint: HAIR_HEAD_JOINT, sockets: [HAIR_SOCKET, BEARD_SOCKET],
      rule: `Every piece is skinned to a ${HAIR_HEAD_JOINT} joint at the ${HAIR_FIGURE} rig's rest pose, plus its own chain joints below it. Attach the piece's scene to the figure's socket (the piece's ${HAIR_HEAD_JOINT} then lands on the figure's ${HAIR_HEAD_JOINT}), or bind its joints to a figure on the rig by name.`,
    },
    tints,
    hair: pieces.filter((piece) => piece.kind === "hair").map(record),
    facialHair: { followsHairTint: true, tints, options: pieces.filter((piece) => piece.kind === "beard").map(record) },
    morphs: { build: VARIETY_BUILD_TARGETS, age: VARIETY_AGE_TARGETS },
    textures: { ktx2: TERRAIN_KTX2, texturePolicy: RANGER_TEXTURE_POLICY },
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "hair-kit-descriptor", mediaType: "application/json" })).asset;

  // A pack hairstyle's two variant names carry the same asset, so the bundle stores it once.
  const selections: Json[] = [], assets: AssetRef[] = [];
  for (const [pieceIndex, piece] of pieces.entries()) for (const [variantIndex, { id, asset }] of piece.variants.entries()) {
    selections.push({ key: piece.id, variant: id, ...(pieceIndex === 0 && variantIndex === 0 ? { attachments: [{ name: HAIR_DESCRIPTOR_ATTACHMENT }] } : {}) });
    assets.push(shipped(asset));
  }
  const packed = await exportKitBundle(root, {
    tarName: HAIR_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor, documents, pieces,
    lineage: {
      recipe: { script: "adapters/blender/hair_kit.py", sha256: script.sha256, geometry: { file: HAIR_GEOMETRY, sha256: kit.sha256 }, blenderVersion: script.blenderVersion },
      release: HAIR_RELEASE, figure: HAIR_FIGURE, fitTarget: parts.fitTarget, rig: parts.targetRig, variety, descriptor: descriptorAsset,
      parts: Object.fromEntries(pieces.flatMap((piece) => piece.variants.map(({ id, asset }) => [`${piece.id}/${id}`, shipped(asset)]))),
    },
  };
}

if (import.meta.main) {
  // #516: the generation and operation caches outlive --out (ASSET_TOOLING_GENERATION_CACHE_DIR, default .asset-tooling/cache).
  useSharedGenerationCache();
  await runKitCli("scripts/build-hair-kit.ts", "hair-kit", buildHairKit, { descriptorFile: true });
}
