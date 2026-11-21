// Build the resident clothing kit (#560, docs/resident-clothing.md): everyday garments for Greyhaven's adults,
// teenagers and children, as attachable skinned pieces, published as its own rolling release:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-resident-clothing.ts [--textures full|half] --out <directory>
// adapters/blender/resident_clothing.py runs once per fit (the adult male and female, the four young residents) on the
// catalogued Quaternius Peasant outfit, read as the fit target and never shipped, and returns every piece of that fit
// skinned to the fit's rig at rest. Each piece variant is split into its own scene, given its #391 accessory chains,
// lighting attributes and KTX2 textures. <directory> becomes the object-store root; the bundle is exported to
// <directory>/bundle and packed to <directory>/resident-clothing.kit.tar. No game places the kit yet.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Logger, NodeIO, type Document } from "@gltf-transform/core";
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
import { addSecondaryChains, type SecondaryChain, type SecondaryChainSpec } from "../src/humanoid-secondary.js";
import { buildKitPart, exportKitBundle, ktx2Asset, runKitCli, triangles, withKtx2Cache } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import { slotKtx2Encoding, TERRAIN_KTX2 } from "../src/ktx2-encodings.js";
import { withLightingAttributes } from "./baked-rock-kit.ts";

type Json = Record<string, any>;
type Rgb = readonly [number, number, number];

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const CLOTHING_RELEASE = "resident-clothing";
export const CLOTHING_TAR_NAME = "resident-clothing.kit.tar";
export const CLOTHING_DESCRIPTOR_SCHEMA = "resident-clothing-kit-descriptor-v1";
export const CLOTHING_DESCRIPTOR_ATTACHMENT = "resident-clothing-descriptor";
export const CLOTHING_KEY_PREFIX = "resident-clothing";
/** The two materials: `cloth` shows the atlas as it is, `cloth.dyed` is tinted by its base colour factor. */
export const CLOTHING_MATERIALS = ["cloth", "cloth.dyed"] as const;
export const CLOTHING_TINTED = "cloth.dyed";
export const CLOTHING_JOINT_COUNT = 65;
const ALLOWED_WARNINGS = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const OUTFITS = "quaternius.modular-character-outfits-fantasy-standard";

export type ClothingFit = "male" | "female" | "teen-boy" | "teen-girl" | "child-boy" | "child-girl";
/**
 * The figures every piece is fitted to, one variant each. The adults are the Ranger figures' Peasant-based variants (the
 * resident outfits); the young residents are their own figures. `nodes` names the figure's mesh nodes a piece may hide.
 */
export const CLOTHING_FITS: Record<ClothingFit, { figure: string; source: string; label: string; nodes: Record<string, string> }> = {
  male: { figure: "humanoid.ranger.male", source: "Male_Peasant", label: "Adult male", nodes: { body: "Male_Peasant_Body", legs: "Male_Peasant_Legs" } },
  female: { figure: "humanoid.ranger.female", source: "Female_Peasant", label: "Adult female", nodes: { body: "Female_Peasant_Body", legs: "Female_Peasant_Legs" } },
  "teen-boy": { figure: "young-residents.kit.teen-boy", source: "Male_Peasant", label: "Teen boy", nodes: { body: "outfit.body", legs: "outfit.legs" } },
  "teen-girl": { figure: "young-residents.kit.teen-girl", source: "Male_Peasant", label: "Teen girl", nodes: { body: "outfit.body", skirt: "skirt" } },
  "child-boy": { figure: "young-residents.kit.child-boy", source: "Male_Peasant", label: "Boy", nodes: { body: "outfit.body", legs: "outfit.legs" } },
  "child-girl": { figure: "young-residents.kit.child-girl", source: "Male_Peasant", label: "Girl", nodes: { body: "outfit.body", skirt: "skirt" } },
};
export const CLOTHING_FIT_NAMES = Object.keys(CLOTHING_FITS) as ClothingFit[];

/**
 * The pieces, in entry order: what each hides on the figure (by role, `CLOTHING_FITS[fit].nodes`), what it must be worn
 * with, the garments a layer is fitted over, and its accessory chains.
 */
export const CLOTHING_PIECES = [
  { id: "smock", label: "Child's smock", hides: ["body"], chains: null },
  { id: "smock.long", label: "Smock dress", hides: ["body", "legs", "skirt"], chains: "skirt" },
  { id: "pinafore", label: "Pinafore", hides: [], chains: "apron", over: ["smock.long"] },
  { id: "shirt", label: "Shirt", hides: [], chains: null, note: "Only its collar, yoke and sleeves are built: wear it under the jerkin." },
  { id: "jerkin", label: "Leather jerkin", hides: ["body"], chains: null, requires: ["shirt"] },
  { id: "chemise", label: "Chemise", hides: [], chains: null, note: "Only its yoke and forearm sleeves are built: wear it under the kirtle." },
  { id: "kirtle", label: "Kirtle", hides: ["body", "legs", "skirt"], chains: "skirt", requires: { female: ["chemise"] } },
  { id: "tunic", label: "Work tunic", hides: ["body"], chains: "skirt" },
  { id: "apron.leather", label: "Smith's leather apron", hides: [], chains: "apron", over: ["tunic", "jerkin", "kirtle"] },
  { id: "apron.half", label: "Linen half-apron", hides: [], chains: "apron", over: ["tunic", "jerkin", "kirtle"] },
  { id: "belt.rope", label: "Rope belt", hides: [], chains: null, over: ["tunic", "kirtle", "jerkin", "smock", "smock.long"] },
  { id: "belt.leather", label: "Leather belt and pouch", hides: [], chains: null, over: ["tunic", "kirtle", "jerkin", "smock", "smock.long"] },
] as const satisfies readonly { id: string; label: string; hides: readonly string[]; chains: "skirt" | "apron" | null; requires?: unknown; over?: readonly string[]; note?: string }[];
export type ClothingPiece = (typeof CLOTHING_PIECES)[number]["id"];

/** Dye tints for `cloth.dyed`, linear base colour factors. */
export const CLOTHING_DYES: Record<string, Rgb> = {
  undyed: [.62, .57, .46], madder: [.5, .09, .05], woad: [.09, .16, .36], weld: [.62, .5, .14], green: [.15, .24, .1], brown: [.24, .14, .08], grey: [.34, .33, .31],
};
/** The ten showcased looks of the mockup (owner decision on #560 Q1). */
export const CLOTHING_LOOKS = [
  { id: "look.child-smock", label: "Child's smock", fit: "child-boy", pieces: ["smock"], dye: "weld" },
  { id: "look.smock-dress", label: "Smock dress and pinafore", fit: "child-girl", pieces: ["smock.long", "pinafore"], dye: "woad" },
  { id: "look.teen-jerkin", label: "Teen jerkin and shirt", fit: "teen-boy", pieces: ["shirt", "jerkin", "belt.leather"], dye: "undyed" },
  { id: "look.teen-kirtle", label: "Teen kirtle", fit: "teen-girl", pieces: ["chemise", "kirtle"], dye: "green" },
  { id: "look.kirtle", label: "Kirtle", fit: "female", pieces: ["chemise", "kirtle", "belt.rope"], dye: "brown" },
  { id: "look.kirtle.poor", label: "Kirtle, patched", fit: "female", pieces: ["chemise.poor", "kirtle.poor", "belt.rope"], dye: "undyed" },
  { id: "look.kirtle.fine", label: "Gown, better-off", fit: "female", pieces: ["chemise", "kirtle.fine", "belt.leather"], dye: "woad" },
  { id: "look.tunic.poor", label: "Work tunic, patched", fit: "male", pieces: ["tunic.poor", "belt.rope"], dye: "undyed" },
  { id: "look.innkeeper", label: "Innkeeper, better-off", fit: "male", pieces: ["tunic.fine", "belt.leather", "apron.half"], dye: "madder" },
  { id: "look.smith", label: "Smith", fit: "male", pieces: ["tunic", "apron.leather"], dye: "brown" },
] as const;

export const clothingKey = (piece: string) => `${CLOTHING_KEY_PREFIX}.${piece}`;
/** A piece's variant name: its fit, then its finish unless plain (`female.poor`). */
export const clothingVariant = (fit: string, finish: string) => finish === "plain" ? fit : `${fit}.${finish}`;

export function createClothingSpec({ fit, scriptSha256, youngSha256, gltfSha256, bufferSha256, blenderVersion }: {
  fit: ClothingFit; scriptSha256: string; youngSha256: string; gltfSha256: string; bufferSha256: string; blenderVersion: string;
}) {
  const source = CLOTHING_FITS[fit].source;
  return blenderScriptSpec({
    assetId: `${CLOTHING_KEY_PREFIX}.kit.${fit}`,
    inputs: {
      script: { path: "resident_clothing.py", sha256: scriptSha256 }, young: { path: "young_residents.py", sha256: youngSha256 },
      gltf: { path: `${source}.gltf`, sha256: gltfSha256 }, buffer: { path: `${source}.bin`, sha256: bufferSha256 },
    },
    blenderVersion, arguments: { schemaVersion: 1, fit }, output: "clothing.glb",
  });
}

const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

/** A piece's chains on one fit (heights are glTF y; the axis is the hips, [x, z]). */
export function clothingChains(kind: "skirt" | "apron" | null, node: string, landmarks: Json): SecondaryChainSpec[] {
  if (!kind) return [];
  const scale = landmarks.height / 1.76;
  const axis: [number, number] = [0, round5(-landmarks.pelvis_y)];
  const top = round5(landmarks.pelvis - .03 * scale);
  const base = { parent: "pelvis", nodes: [node], top, axis, select: { type: "sector" as const, power: 2 }, minSegment: round5(.12 * scale) };
  if (kind === "apron") return [{ ...base, id: "apron", kind: "apron", prefix: "apron", count: 2, direction: 0, rampLength: round5(.1 * scale), swingLimitDegrees: 15 }];
  return ([["front", "f", 0, 3], ["back", "b", 180, 3], ["left", "l", 90, 2], ["right", "r", 270, 2]] as const).map(([side, prefix, direction, count]) => ({
    ...base, id: `skirt.${side}`, kind: "skirt" as const, prefix: `skirt_${prefix}`, count, direction, rampLength: round5(.12 * scale), swingLimitDegrees: 20,
  }));
}

/** One piece variant of a fit's output: its mesh node and skin, with chains and lighting attributes; the rest pruned. */
async function pieceVariant(root: string, asset: AssetRef, node: string, specs: SecondaryChainSpec[]) {
  const io = new NodeIO().setAllowNetwork(false);
  const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
  document.setLogger(new Logger(Logger.Verbosity.ERROR));
  for (const other of document.getRoot().listNodes()) {
    const mesh = other.getMesh();
    if (!mesh || other.getName() === node) continue;
    other.dispose();
    for (const primitive of mesh.listPrimitives()) primitive.dispose();
    mesh.dispose();
  }
  await document.transform(prune({ keepExtras: true }));
  if (!document.getRoot().listNodes().some((entry) => entry.getName() === node && entry.getSkin())) throw new Error(`the recipe output has no skinned ${node}`);
  const chains = specs.length ? addSecondaryChains(document, specs) : [];
  await withLightingAttributes(document);
  const glb = (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: asset.kind, mediaType: asset.mediaType,
    metadata: { operation: "resident-clothing-piece-v1", node, source: asset.sha256, chains: sha256Bytes(Buffer.from(JSON.stringify(specs))) } })).asset;
  return { glb, chains };
}

export async function buildResidentClothing({ outDir, log = () => {}, repositoryRoot = path.resolve(import.meta.dir, "..") }: { outDir: string; log?: (line: string) => void; repositoryRoot?: string }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const [recipe, young] = await Promise.all([readBlenderRecipeSource("resident_clothing.py"), readBlenderRecipeSource("young_residents.py")]);
  const json = async (file: string) => JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8"));
  const [providers, sources, storage] = [await json("catalog/providers.json"), await json("catalog/sources.json"), await json("catalog/storage.json")];
  const rawSources: Json[] = sources.sources;
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const named = (name: string) => {
    const matches = rawSources.filter((source) => source.archiveMember?.archive === OUTFITS && path.posix.basename(source.archiveMember.path) === name);
    if (matches.length !== 1) throw new Error(`'${name}' must be exactly one catalogued member`);
    return matches[0]!;
  };
  const bytesOf = async (sourceId: string) => new Uint8Array(await resolveAssetObject(root, (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: repositoryRoot, objectStoreRoot: root })).asset as never));

  type Variant = { fit: ClothingFit; finish: string; cut: string; node: string; asset: AssetRef; chains: SecondaryChain[]; squeezedFaces: number };
  const variants = new Map<string, Variant[]>(CLOTHING_PIECES.map(({ id }) => [id, []]));
  const fits: Json = {};
  for (const fit of CLOTHING_FIT_NAMES) {
    const { source } = CLOTHING_FITS[fit];
    log(`fit every piece to ${fit} (external.blender.script@1 resident clothing recipe)`);
    const gltf = await bytesOf(named(`${source}.gltf`).id), buffer = await bytesOf(named(`${source}.bin`).id);
    const built = await buildKitPart(root, {
      workspace: path.join(root, "fits", fit), files: { "resident_clothing.py": recipe.bytes, "young_residents.py": young.bytes, [`${source}.gltf`]: gltf, [`${source}.bin`]: buffer },
      spec: createClothingSpec({ fit, scriptSha256: recipe.sha256, youngSha256: young.sha256, gltfSha256: sha256Bytes(gltf), bufferSha256: sha256Bytes(buffer), blenderVersion: recipe.blenderVersion }),
      allowedValidatorWarnings: ALLOWED_WARNINGS,
    });
    const landmarks = built.observations.landmarks as Json;
    for (const record of built.observations.pieces as Json[]) {
      const piece = CLOTHING_PIECES.find(({ id }) => id === record.piece);
      if (!piece) throw new Error(`${fit}: the recipe built an unknown piece ${record.piece}`);
      const { glb, chains } = await pieceVariant(root, built.asset, record.node, clothingChains(piece.chains, record.node, landmarks));
      variants.get(piece.id)!.push({ fit, finish: record.finish, cut: record.cut, node: record.node, asset: glb, chains, squeezedFaces: record.squeezedFaces });
    }
    fits[fit] = { ...CLOTHING_FITS[fit], landmarks: Object.fromEntries(Object.entries(landmarks).map(([key, value]) => [key, round5(value as number)])) };
  }

  for (const look of CLOTHING_LOOKS) for (const node of look.pieces) {
    if (![...variants.values()].flat().some((variant) => variant.fit === look.fit && variant.node === node)) throw new Error(`${look.id}: ${look.fit} has no ${node}`);
  }

  log("encode every texture as KTX2 (ktx create, TERRAIN_KTX2)");
  const delivered = await withKtx2Cache(CLOTHING_RELEASE, async (cache) => {
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

  log("write the resident-clothing descriptor");
  const roleNodes = (fit: ClothingFit, roles: readonly string[]) => roles.map((role) => CLOTHING_FITS[fit].nodes[role]).filter((node): node is string => !!node);
  const pieces = CLOTHING_PIECES.map((piece) => {
    const list = variants.get(piece.id)!;
    if (!list.length) throw new Error(`no fit wears ${piece.id}`);
    const requires = "requires" in piece ? piece.requires : undefined;
    return {
      id: piece.id, entry: clothingKey(piece.id), label: piece.label, source: "authored", ...("note" in piece ? { note: piece.note } : {}),
      ...("over" in piece ? { over: piece.over } : {}),
      variants: list.map(({ fit, finish, cut, node, asset, chains, squeezedFaces }) => {
        const document = documents.get(shipped(asset).sha256)!;
        const needs = Array.isArray(requires) ? requires : (requires as Record<string, readonly string[]> | undefined)?.[fit] ?? [];
        return {
          variant: clothingVariant(fit, finish), fit, finish, cut, node, triangles: triangles(document), squeezedFaces,
          materials: document.getRoot().listMaterials().map((material) => material.getName()).sort(),
          hides: roleNodes(fit, piece.hides), requires: needs,
          ...(chains.length ? { secondary: chains } : {}),
        };
      }),
    };
  });
  const descriptor = {
    schema: CLOTHING_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right",
    rig: {
      joints: CLOTHING_JOINT_COUNT,
      rule: "Each variant is one skinned glTF scene on its fit's 65-joint rig at rest (the joints and rest pose of that figure), plus the piece's own accessory chain joints. Bind its joints to the worn figure's by name and play the figure's clips; the chain joints come with the piece and hang from pelvis. Hide the figure nodes the variant lists in `hides`. Wear `requires` with it. Layers (aprons, the pinafore, belts) are fitted over the garments in `over`, in the same fit.",
      clips: "Adults: the humanoid.ranger clips as they are. Young figures: as for young-residents, the rotation tracks and the pelvis translation scaled by the figure's pelvisScale.",
    },
    fits,
    materials: {
      names: CLOTHING_MATERIALS, tinted: CLOTHING_TINTED,
      rule: "Both materials share one atlas and normal map. `cloth` shows linen, leather, trims, rope and brass as they are; `cloth.dyed` (the wool and the smocks) is tinted by multiplying its base colour factor with a dye.",
      dyes: Object.entries(CLOTHING_DYES).map(([id, color]) => ({ id: `dye.${id}`, baseColorFactor: [...color, 1] })),
    },
    finishes: {
      plain: "the everyday cut and cloth",
      poor: "faded cloth, sewn-on patches and darns, a frayed and uneven hem",
      fine: "dyed fine wool with embroidered hem bands and trimmed cuffs; the adult tunic and kirtle are also a distinct cut (the long tunic and the gown)",
    },
    pieces,
    looks: CLOTHING_LOOKS.map((look) => ({ ...look, tint: { material: CLOTHING_TINTED, dye: `dye.${look.dye}` } })),
    collision: "None: garments ride the figure's character capsule.",
    textures: { ktx2: TERRAIN_KTX2 },
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "resident-clothing-kit-descriptor", mediaType: "application/json" })).asset;

  const selections: Json[] = [], assets: AssetRef[] = [];
  for (const [index, { id }] of CLOTHING_PIECES.entries()) for (const [variantIndex, { fit, finish, asset }] of variants.get(id)!.entries()) {
    selections.push({ key: clothingKey(id), variant: clothingVariant(fit, finish), ...(index === 0 && variantIndex === 0 ? { attachments: [{ name: CLOTHING_DESCRIPTOR_ATTACHMENT }] } : {}) });
    assets.push(shipped(asset));
  }
  const packed = await exportKitBundle(root, {
    tarName: CLOTHING_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets, attachments: [descriptorAsset] } },
  });
  /** Each shipped variant's document, by `<piece>/<variant>`. */
  const variantDocuments = new Map([...variants.entries()].flatMap(([id, list]) => list.map(({ fit, finish, asset }) => [`${id}/${clothingVariant(fit, finish)}`, documents.get(shipped(asset).sha256)!] as const)));
  return {
    ...packed, descriptor, documents: variantDocuments, variants,
    lineage: {
      recipe: { script: "adapters/blender/resident_clothing.py", sha256: recipe.sha256, blenderVersion: recipe.blenderVersion },
      release: CLOTHING_RELEASE, descriptor: descriptorAsset,
      parts: Object.fromEntries([...variants.entries()].flatMap(([id, list]) => list.map(({ fit, finish, asset }) => [`${id}/${clothingVariant(fit, finish)}`, shipped(asset)]))),
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-resident-clothing.ts", CLOTHING_RELEASE, buildResidentClothing, { descriptorFile: true });
