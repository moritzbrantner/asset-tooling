// Build the Redbrand faction kit (#517, docs/redbrand-kit.md): mmorpg's Redbrand bandits dressed on the male Ranger
// figure, as its own rolling release:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-redbrand-kit.ts --out <directory>
// The Redbrand garments (coat, trousers, sleeves, scarf) and plates (belt, bracers) are hand-authored geometry in
// assets/authored/redbrand-kit.blend. adapters/blender/redbrand.py skins the garments to the Ranger rig and bakes the
// plates' occlusion. The rest of the figure is built the way scripts/build-ranger-character.ts builds the Ranger's
// Peasant-based outfits, from the same catalog members and through the same cached operations:
//   - the Peasant body, less the shirt and legs the garments hide;
//   - the Ranger head with its face morphs;
//   - the age and build keys;
//   - the coat skirt and scarf chains.
// Each figure is a complete character on the Ranger rig, with the same joint names and rest pose. It carries no
// clips: a consumer plays the Ranger default's clips by joint name. Every texture ships as KTX2, encoded like the
// crag kit and the terrain (TERRAIN_KTX2). The redbrand-kit-descriptor-v1 attachment holds the outfit record in the
// shape of the Ranger's humanoid-appearance `outfits[]` entries. <directory> becomes the object-store root; the bundle
// is exported to <directory>/bundle and packed to <directory>/redbrand.kit.tar.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { ARMOR_FACTION } from "../src/armor-recipes.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readAuthoredBlenderSource, readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { runBlenderRecipe } from "../src/blender-recipe-run.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { FACE_MORPH_NODES, addFaceVariants, applyFaceVariants } from "../src/face-variants.js";
import { withoutTextures } from "../src/gltf-without-textures.js";
import { sha256Bytes } from "../src/hash.js";
import { RANGER_OUTFIT_CHAINS, applySecondaryChains, type SecondaryChain } from "../src/humanoid-secondary.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "../src/image-rgba8.js";
import { exportKitBundle, ktx2Asset, runKitCli, single, triangles, withKtx2Cache } from "../src/kit-bundle.js";
import { applyVarietyKeys, authorVarietyKeys } from "../src/male-variety.js";
import type { AssetRef } from "../src/operations.js";
import {
  RANGER_APPEARANCE, RANGER_FIGURES, RANGER_HEAD_RECIPE, RANGER_HIPS, RANGER_PEASANT_OUTFITS, RANGER_TEXTURE_POLICY,
} from "../src/ranger-figure.js";
import { cachedCompose, cachedExtract, cachedImageDecode, cachedImageEncodePng, cachedImport, cachedSubset, cachedTextureResize } from "./cached-operations.ts";
import { TERRAIN_KTX2, slotKtx2Encoding } from "../src/ktx2-encodings.js";
import { useSharedGenerationCache } from "./generation-cache.ts";

type Json = Record<string, any>;

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const REDBRAND_RELEASE = "redbrand-kit";
export const REDBRAND_TAR_NAME = "redbrand.kit.tar";
export const REDBRAND_KEY_PREFIX = "redbrand.kit";
/** The dressed figure: `default` wears the Dark skin, `skin.light` the Light skin. */
export const REDBRAND_OUTFIT_KEY = `${REDBRAND_KEY_PREFIX}.outfit`;
/** The rigid plates, one node per piece, each riding its joint's `<joint>.armor` socket. */
export const REDBRAND_ARMOR_KEY = `${REDBRAND_KEY_PREFIX}.armor`;
export const REDBRAND_SKINS = [{ id: "skin.dark", variant: "default" }, { id: "skin.light", variant: "skin.light" }] as const;
/** The outfit id and label the Ranger's humanoid-appearance used for the same look until #517; the kit's record keeps them. */
export const REDBRAND_OUTFIT_ID = "outfit.redbrand";
export const REDBRAND_OUTFIT_LABEL = "Redbrand";
/** The figure the kit fits, whose rig, sockets and clips it shares (male only, owner answer on #517). */
export const REDBRAND_FIGURE = RANGER_FIGURES.male.key;
export const REDBRAND_GEOMETRY = "assets/authored/redbrand-kit.blend";
export const REDBRAND_DESCRIPTOR_SCHEMA = "redbrand-kit-descriptor-v1";
export const REDBRAND_DESCRIPTOR_ATTACHMENT = "redbrand-descriptor";
export type RedbrandOutput = "plates" | "cloth";
/** The validator warnings a skinned Ranger character legitimately raises, as the Ranger build allows them. */
const POLICY = { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] };
const UBC = "quaternius.universal-base-characters-standard";

export function createRedbrandAssetSpec({ output, scriptSha256, armorSha256, kitSha256, targetSha256, blenderVersion }: {
  output: RedbrandOutput; scriptSha256: string; armorSha256: string; kitSha256: string; targetSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: `${REDBRAND_KEY_PREFIX}.${output}`,
    inputs: {
      script: { path: "redbrand.py", sha256: scriptSha256 }, armor: { path: "armor.py", sha256: armorSha256 },
      kit: { path: "redbrand-kit.blend", sha256: kitSha256 }, target: { path: "target.glb", sha256: targetSha256 },
    },
    blenderVersion, arguments: { schemaVersion: 1, output }, output: "redbrand.glb",
  });
}

/**
 * The male figure's parts the outfit is built from, as the Ranger build makes them (same members, operations and
 * parameters, so the shared cache serves both builds):
 *   - the Peasant outfit in both skins;
 *   - the head with its face morphs in both skins;
 *   - the fit target (the Peasant outfit and the plain head on one skeleton);
 *   - the Ranger rig the figure must keep.
 */
export async function redbrandFigureParts(root: string, log: (line: string) => void = () => {}) {
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
  const importGltf = async (entry: { archive: string; path: string }, overrides: Record<string, AssetRef> = {}) => {
    const gltfId = memberId(entry);
    const source = await member(gltfId);
    const document = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
    const uris: string[] = [...(document.buffers ?? []), ...(document.images ?? [])].map((item: Json) => item.uri);
    const resources: AssetRef[] = [];
    for (const uri of uris) resources.push(overrides[uri] ?? await member(resourceId(entry.archive, gltfId, uri)));
    return single(await cachedImport(root, { inputs: { source, resources }, parameters: { resourceUris: uris, policy: POLICY } }));
  };

  log("import the Ranger body and outfit (scene.import.gltf@2), head subset and rig");
  const outfit = await importGltf(shape.outfit);
  const body = await importGltf(shape.body);
  const head = single(await cachedSubset(root, { inputs: { source: body }, parameters: { ...RANGER_HEAD_RECIPE, keepMeshes: [...shape.headMeshes] } }));
  const composed = single(await cachedCompose(root, { inputs: { skeleton: outfit, parts: [head] }, parameters: { policy: POLICY } }));
  const targetRig = single(await cachedExtract(root, { inputs: { source: composed }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
  log("face variants (adapters/blender/face_variants.py)");
  const face = await addFaceVariants(root, head, shape.key);

  // The Light skin, as the Ranger derives it (#116 Q13 = A): the outfit's skin texture gets the body's Dark -> Light
  // per-channel mean and deviation transfer.
  log("Light skin textures");
  const decode = async (texture: AssetRef) => {
    const image = (await storeAssetObject(root, { bytes: await resolveAssetObject(root, texture), kind: "image", mediaType: "image/png" })).asset;
    return parseRgba8Image(await resolveAssetObject(root, single(await cachedImageDecode(root, { inputs: { source: image }, parameters: {} }))));
  };
  const bodyDark = await member(resourceId(UBC, memberId(shape.body), look.skinLight.body.uri));
  const bodyLight = await member(memberId({ archive: UBC, path: look.skinLight.body.member }));
  const regularDark = await member(resourceId(shape.outfit.archive, memberId(shape.outfit), look.skinLight.outfitUri));
  const [dark, light, regular] = [await decode(bodyDark), await decode(bodyLight), await decode(regularDark)];
  const stats = (image: Rgba8Image) => [0, 1, 2].map((channel) => {
    let sum = 0, square = 0, count = 0;
    for (let index = 0; index < image.pixels.length; index += 4) {
      if (image.pixels[index + 3]! === 0) continue;
      const value = image.pixels[index + channel]!;
      sum += value; square += value * value; count += 1;
    }
    const mean = sum / count;
    return { mean, deviation: Math.sqrt(Math.max(square / count - mean * mean, 1e-6)) };
  });
  const from = stats(dark), to = stats(light);
  const pixels = Uint8Array.from(regular.pixels, (value, index) => {
    const channel = index % 4;
    if (channel === 3) return value;
    return Math.max(0, Math.min(255, Math.round((value - from[channel]!.mean) / from[channel]!.deviation * to[channel]!.deviation + to[channel]!.mean)));
  });
  const rgba = (await storeAssetObject(root, { bytes: encodeRgba8Image({ width: regular.width, height: regular.height, pixels }), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE })).asset;
  const regularLight = single(await cachedImageEncodePng(root, { inputs: { source: rgba }, parameters: { compressionLevel: 9 } }));
  const bodyLightGlb = await importGltf(shape.body, { [look.skinLight.body.uri]: bodyLight });
  const headLightBase = single(await cachedSubset(root, { inputs: { source: bodyLightGlb }, parameters: { ...RANGER_HEAD_RECIPE, keepMeshes: [...shape.headMeshes] } }));
  const headLight = (await applyFaceVariants(root, headLightBase, face.authored)).glb;

  log("Peasant outfit in both skins and the fit target");
  const peasant = await importGltf(RANGER_PEASANT_OUTFITS.male);
  const peasantLight = await importGltf(RANGER_PEASANT_OUTFITS.male, { [look.skinLight.outfitUri]: regularLight });
  const fitTarget = single(await cachedCompose(root, { inputs: { skeleton: peasant, parts: [head] }, parameters: { policy: POLICY } }));
  const peasantMeshes = (await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, peasant)))).getRoot().listMeshes().map((mesh) => mesh.getName());
  return { targetRig, face, headLight, peasant, peasantLight, fitTarget, peasantMeshes };
}

/** Fails unless `rig` has exactly `target`'s joints, by name, with the same rest TRS (within 1e-4), as the Ranger checks. */
async function assertSameSkeleton(root: string, target: AssetRef, rig: AssetRef, label: string) {
  const read = async (asset: AssetRef) => JSON.parse((await resolveAssetObject(root, asset)).toString("utf8"));
  const rest = (document: Json) => new Map<string, Json>((document.jointNames as string[]).map((name, index) => [name, document.nodes[index]]));
  const mine = rest(await read(target)), theirs = rest(await read(rig));
  if (mine.size !== theirs.size || [...mine.keys()].some((name) => !theirs.has(name))) throw new Error(`${label}: its joints differ from the Ranger rig`);
  for (const [name, node] of mine) {
    const a = [...(node.translation ?? [0, 0, 0]), ...(node.rotation ?? [0, 0, 0, 1])], b = [...(theirs.get(name)!.translation ?? [0, 0, 0]), ...(theirs.get(name)!.rotation ?? [0, 0, 0, 1])];
    const sign = a.slice(3).reduce((sum, value, k) => sum + value * b[3 + k]!, 0) < 0 ? -1 : 1;
    if (a.some((value, k) => Math.abs(value - (k >= 3 ? sign : 1) * b[k]!) > 1e-4)) throw new Error(`${label}: joint '${name}' rests differently from the Ranger rig`);
  }
}

export async function buildRedbrandKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const script = await readBlenderRecipeSource("redbrand.py");
  const armorScript = await readBlenderRecipeSource("armor.py");
  const kit = await readAuthoredBlenderSource(REDBRAND_GEOMETRY);
  const parts = await redbrandFigureParts(root, log);

  // The recipe reads only the fit target's skeleton and geometry (#516: no target textures).
  const target = await withoutTextures(new Uint8Array(await resolveAssetObject(root, parts.fitTarget)));
  const run = async (output: RedbrandOutput) => {
    log(`skin the authored ${output} (external.blender.script@1 redbrand recipe, scene.import.gltf@2)`);
    const { glb, observations } = await runBlenderRecipe(root, {
      workspace: path.join(root, "redbrand", output),
      files: { "redbrand.py": script.bytes, "armor.py": armorScript.bytes, "redbrand-kit.blend": kit.bytes, "target.glb": target },
      spec: createRedbrandAssetSpec({ output, scriptSha256: script.sha256, armorSha256: armorScript.sha256, kitSha256: kit.sha256,
        targetSha256: sha256Bytes(target), blenderVersion: script.blenderVersion }),
    });
    return { glb: single(await cachedImport(root, { inputs: { source: glb }, parameters: { policy: POLICY } })), observations };
  };
  const plates = await run("plates");
  const cloth = await run("cloth");
  const pieces: Json[] = [...plates.observations.pieces, ...cloth.observations.pieces];
  const hidden = [...new Set(pieces.flatMap((piece) => piece.hides as string[]))].sort();

  // The figures: the Peasant outfit less the hidden nodes, the head and the garments on one skeleton, per skin.
  const { jointNames } = JSON.parse((await resolveAssetObject(root, parts.targetRig)).toString("utf8"));
  const skins = [[REDBRAND_SKINS[0], parts.peasant, parts.face.glb], [REDBRAND_SKINS[1], parts.peasantLight, parts.headLight]] as const;
  const figures: { skin: (typeof REDBRAND_SKINS)[number]; character: AssetRef }[] = [];
  const variety: Json = { transfers: {} };
  let keys: Uint8Array | undefined;
  let chains: SecondaryChain[] = [];
  for (const [skin, outfitSource, headPart] of skins) {
    log(`compose the ${skin.id} figure (scene.subset.skinned.gltf@1, scene.compose.skinned.gltf@1)`);
    const base = single(await cachedSubset(root, {
      inputs: { source: outfitSource }, parameters: { keepJoints: ["root"], minWeight: 1, keepMeshes: parts.peasantMeshes.filter((name) => !hidden.includes(name)), policy: POLICY },
    }));
    const composed = single(await cachedCompose(root, { inputs: { skeleton: base, parts: [headPart, cloth.glb] }, parameters: { policy: POLICY } }));
    const rig = single(await cachedExtract(root, { inputs: { source: composed }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
    if (JSON.stringify(JSON.parse((await resolveAssetObject(root, rig)).toString("utf8")).jointNames) !== JSON.stringify(jointNames)) {
      throw new Error("the Redbrand figure's joints differ from the Ranger rig, so the clips cannot be shared");
    }
    await assertSameSkeleton(root, parts.targetRig, rig, `${REDBRAND_OUTFIT_KEY}/${skin.variant}`);
    let character = single(await cachedTextureResize(root, { inputs: { source: composed }, parameters: { ...RANGER_TEXTURE_POLICY, policy: POLICY } }));
    // #380: the figure and its plates follow the age and build keys, authored once (the skins share the geometry).
    if (!keys) {
      log("age and build keys on the figure and plates (adapters/blender/male_variety.py, #380)");
      const authored = await authorVarietyKeys(root, "kit.redbrand", { mode: "character", source: composed, items: plates.glb });
      keys = authored.bytes;
      variety.authored = authored.observations;
    }
    const keyed = await applyVarietyKeys(root, character, keys, `${REDBRAND_OUTFIT_KEY}/${skin.variant}`);
    variety.transfers[skin.variant] = keyed.transfer;
    // #391: the coat skirt and scarf chains; at rest they deform exactly as before.
    const chained = await applySecondaryChains(root, keyed.glb, RANGER_OUTFIT_CHAINS.redbrand!);
    character = chained.glb;
    chains = chained.chains;
    figures.push({ skin, character });
  }
  const keyedPlates = await applyVarietyKeys(root, plates.glb, keys!, REDBRAND_ARMOR_KEY);
  variety.transfers[REDBRAND_ARMOR_KEY] = keyedPlates.transfer;

  log("encode every texture as KTX2 (ktx create, TERRAIN_KTX2)");
  const delivered = await withKtx2Cache("redbrand-kit", async (cache) => {
    const out: AssetRef[] = [];
    for (const asset of [...figures.map((figure) => figure.character), keyedPlates.glb]) {
      out.push(await ktx2Asset(root, asset, cache, { slotEncoding: slotKtx2Encoding }));
    }
    return out;
  });
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const documents: Document[] = [];
  for (const asset of delivered) documents.push(await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))));

  log("write the redbrand-kit descriptor");
  const garments = (cloth.observations.pieces as Json[]).map((piece) => ({ id: piece.node, nodes: piece.nodes, hides: piece.hides }));
  const outfit = {
    id: REDBRAND_OUTFIT_ID, label: REDBRAND_OUTFIT_LABEL, character: REDBRAND_OUTFIT_KEY,
    skins: REDBRAND_SKINS.map(({ id, variant }) => ({ id, entry: REDBRAND_OUTFIT_KEY, variant })),
    base: { outfit: "Male_Peasant", hidden },
    armor: { entry: REDBRAND_ARMOR_KEY, pieces: (plates.observations.pieces as Json[]).map((piece) => ({ node: piece.node, socket: `${String(piece.joint).toLowerCase()}.armor`, hides: piece.hides })) },
    garments,
    secondary: chains,
    faction: { materials: [ARMOR_FACTION.material], defaultBaseColorFactor: [...ARMOR_FACTION.default, 1] },
  };
  const variants = REDBRAND_SKINS.map((skin) => skin.variant);
  const descriptor = {
    schema: REDBRAND_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right",
    figure: REDBRAND_FIGURE,
    rig: {
      jointCount: jointNames.length, sha256: parts.targetRig.sha256,
      rule: `Every ${REDBRAND_OUTFIT_KEY} variant has the ${REDBRAND_FIGURE} rig's joints, by name, at the same rest pose; it ships no clips and plays the ${REDBRAND_FIGURE} default's clips by joint name. The plates ride the figure's <joint>.armor sockets.`,
    },
    outfits: [outfit],
    // The morph targets each variant carries, so a consumer offers the Ranger's face options and age and build
    // morphs on them (humanoid-appearance `face.variants`, `ages.variants`, `builds.variants`/`entries`).
    morphs: { face: { nodes: [...FACE_MORPH_NODES.male], variants }, variety: { variants, entries: [REDBRAND_ARMOR_KEY] } },
    assets: [
      ...figures.map(({ skin }, index) => ({ key: REDBRAND_OUTFIT_KEY, variant: skin.variant, skin: skin.id, triangles: triangles(documents[index]!) })),
      { key: REDBRAND_ARMOR_KEY, variant: "default", triangles: triangles(documents[figures.length]!) },
    ],
    textures: { ktx2: TERRAIN_KTX2, texturePolicy: RANGER_TEXTURE_POLICY },
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "redbrand-descriptor", mediaType: "application/json" })).asset;

  const selections = [
    ...figures.map(({ skin }, index) => ({ key: REDBRAND_OUTFIT_KEY, variant: skin.variant, ...(index === 0 ? { attachments: [{ name: REDBRAND_DESCRIPTOR_ATTACHMENT }] } : {}) })),
    { key: REDBRAND_ARMOR_KEY, variant: "default" },
  ];
  const packed = await exportKitBundle(root, {
    tarName: REDBRAND_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor, documents,
    lineage: {
      recipe: {
        script: "adapters/blender/redbrand.py", sha256: script.sha256, armor: { script: "adapters/blender/armor.py", sha256: armorScript.sha256 },
        geometry: { file: REDBRAND_GEOMETRY, sha256: kit.sha256 }, blenderVersion: script.blenderVersion,
      },
      release: REDBRAND_RELEASE, figure: REDBRAND_FIGURE, fitTarget: parts.fitTarget, rig: parts.targetRig, variety,
      parts: Object.fromEntries([...figures.map(({ skin }, index) => [`${REDBRAND_OUTFIT_KEY}/${skin.variant}`, delivered[index]!] as const), [REDBRAND_ARMOR_KEY, delivered[figures.length]!] as const]),
      descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) {
  // #516: the generation and operation caches outlive --out (ASSET_TOOLING_GENERATION_CACHE_DIR, default .asset-tooling/cache).
  useSharedGenerationCache();
  await runKitCli("scripts/build-redbrand-kit.ts", "redbrand", buildRedbrandKit, { descriptorFile: true });
}
