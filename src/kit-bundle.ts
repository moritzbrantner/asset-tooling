// Shared pieces of the scripted kit builders (#424): run every part's Blender recipe and import it, measure the
// imported documents, export the bundle and pack the release tar. Each scripts/build-<kit>.ts keeps only its
// constants, its spec and its descriptor.
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { ImageUtils, NodeIO, type Document, type Texture } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { ktxArguments, powerOfTwo, textureEncoding, type TextureEncoding } from "../scripts/pack-downloads.ts";
import { exportAssetBundle } from "./asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, packAssetBundle } from "./asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { runBlenderRecipe } from "./blender-recipe-run.js";
import type { blenderScriptSpec } from "./blender-script-spec.js";
import { canonicalJson } from "./canonical.js";
import { executeGltfProductionImportOperation } from "./gltf-production-operations.js";
import type { AssetOperationResult, AssetRef } from "./operations.js";

type Json = Record<string, any>;
export type Vec3 = [number, number, number];

/** The single AssetRef an operation wrote to `port`. */
export function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

/** Round to 6 decimals, without negative zero. */
export const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };
export const round3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

/** World-space AABB of every mesh node in the document, or of the mesh node named `nodeName`. */
export function documentBounds(document: Document, nodeName?: string): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || (nodeName !== undefined && node.getName() !== nodeName)) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      const p: number[] = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        for (let k = 0; k < 3; k += 1) {
          const w = m[k]! * p[0]! + m[4 + k]! * p[1]! + m[8 + k]! * p[2]! + m[12 + k]!;
          min[k] = Math.min(min[k]!, w); max[k] = Math.max(max[k]!, w);
        }
      }
    }
  }
  if (!Number.isFinite(min[0]!)) throw new Error(`no mesh geometry${nodeName ? ` for node '${nodeName}'` : ""}`);
  return { min: round3(min), max: round3(max) };
}

/** The rounded world translation of the empty (mesh-less) node `name`. */
export function emptyTranslation(document: Document, name: string): Vec3 {
  const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === name && !candidate.getMesh());
  if (!node) throw new Error(`empty node '${name}' is missing`);
  return round3(node.getWorldTranslation());
}

/** Triangle count of every primitive in the document. */
export function triangles(document: Document) {
  let count = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")!.getCount()) / 3;
  }
  return count;
}

/** A kit part: the asset that enters the bundle, its document and the recipe's observations. */
export type KitPart = { asset: AssetRef; document: Document; observations: Json };

/**
 * Run one part's recipe and import its GLB through scene.import.gltf@2. `use: "imported"` (the default) bundles
 * the imported asset; `use: "source"` bundles the recipe's GLB as written, with the import only as validation.
 */
export async function buildKitPart(root: string, { workspace, spec, files, use = "imported", allowedValidatorWarnings = [] }: {
  workspace: string; spec: ReturnType<typeof blenderScriptSpec>; files: Record<string, Uint8Array>; use?: "imported" | "source";
  allowedValidatorWarnings?: string[];
}): Promise<KitPart> {
  const { glb, observations } = await runBlenderRecipe(root, { workspace, spec, files });
  const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings } } }));
  const asset = use === "imported" ? imported : glb;
  return { asset, document: await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, asset))), observations };
}

/**
 * The shared descriptor entry of the modular kits (crypt, shrine, outpost, settlement props): key, role, the
 * kit's own `fields`, triangles, footprint, bounds and collision proxies, then every `extras` observation the
 * recipe declared.
 */
export function kitEntry({ key, role, fields, document, observations, extras }: {
  key: string; role: string; fields: Json; document: Document; observations: Json; extras: readonly string[];
}): Json {
  const bounds = documentBounds(document);
  const entry: Json = {
    key, role, ...fields, triangles: triangles(document),
    footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1] - bounds.min[1]) },
    bounds, collisionProxies: observations.collisionProxies,
  };
  for (const extra of extras) if (observations[extra] !== undefined) entry[extra] = observations[extra];
  return entry;
}

/** Sort descriptor entries by key. */
export const byKey = (a: Json, b: Json) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/**
 * Pack an exported bundle into `<root>/<tarName>` (+ `.sha256`), as scripts/pack-asset-bundle.ts does, and write
 * the export ref next to it.
 */
export async function packReleaseTar(root: string, bundleDir: string, tarName: string) {
  const packed = await packAssetBundle(bundleDir);
  const tar = path.join(root, tarName);
  await writeFile(tar, packed.tar);
  await writeFile(`${tar}.sha256`, `${packed.sha256}  ${tarName}\n`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, `${canonicalJson(packed.ref)}\n`);
  return { tar, tarSha256: packed.sha256, tarByteLength: packed.tar.byteLength, exportRef: packed.ref as Json, exportRefPath };
}

type KitBuildResult = { bundleDir: string; tar: string; tarSha256: string; tarByteLength: number; exportRef: Json; lineage: Json; descriptor: Json };

/** Texture resolution modes of a build, as a scale on every texture's edge when it is encoded to KTX2. `full` is what ships. */
export const KIT_TEXTURE_MODES = { full: 1, half: 0.5 } as const;
export type KitTextureMode = keyof typeof KIT_TEXTURE_MODES;
let kitTextureMode: KitTextureMode = "full";

/** Selects the mode of the KTX2 encoding in this process. */
export function setKitTextureMode(mode: KitTextureMode) {
  kitTextureMode = mode;
}

/** Removes `--textures <mode>` from `argv`, selects that mode and returns it. */
export function takeKitTextureMode(argv: string[]): KitTextureMode {
  const at = argv.indexOf("--textures");
  if (at < 0) return kitTextureMode;
  const mode = argv.splice(at, 2)[1] as KitTextureMode;
  if (!(mode in KIT_TEXTURE_MODES)) throw new Error(`--textures must be one of ${Object.keys(KIT_TEXTURE_MODES).join(", ")}`);
  setKitTextureMode(mode);
  return mode;
}

/** The power-of-two size an image of `width` x `height` is encoded at in the selected mode. */
export function kitTextureTarget(width: number, height: number) {
  const scale = KIT_TEXTURE_MODES[kitTextureMode];
  return { width: powerOfTwo(Math.max(1, Math.round(width * scale))), height: powerOfTwo(Math.max(1, Math.round(height * scale))) };
}

/**
 * The `[--textures full|half] --out <directory>` command line every kit builder shares: build, write `lineage.json` (and
 * with `descriptorFile`, `descriptor.json`) next to the tar, and print the bundle, tar and export ref plus `summary`.
 */
export async function runKitCli<R extends KitBuildResult>(script: string, label: string, build: (options: { outDir: string; log: (line: string) => void }) => Promise<R>,
  { descriptorFile = false, summary = () => ({}) }: { descriptorFile?: boolean; summary?: (result: R) => Json } = {}) {
  const textures = takeKitTextureMode(process.argv);
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error(`Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun ${script} [--textures full|half] --out <directory>`);
    process.exit(2);
  }
  try {
    const result = await build({ outDir: args[1]!, log: (line) => console.error(`[${label}] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify({ ...result.lineage, ...(textures === "full" ? {} : { textures }) }, null, 2)}\n`);
    if (descriptorFile) await writeFile(path.join(path.resolve(args[1]!), "descriptor.json"), `${JSON.stringify(result.descriptor, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef, ...summary(result) }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

/** Export the kit bundle to `<root>/bundle` and pack it to `<root>/<tarName>`. */
export async function exportKitBundle(root: string, { invocation, tarName, log = () => {} }: {
  invocation: Parameters<typeof exportAssetBundle>[2]; tarName: string; log?: (line: string) => void;
}) {
  const bundleDir = path.join(root, "bundle");
  log(`export ${(invocation?.parameters as Json | undefined)?.profile} bundle`);
  await exportAssetBundle(root, bundleDir, invocation);
  log(`pack release tar ${tarName}`);
  return { bundleDir, ...(await packReleaseTar(root, bundleDir, tarName)) };
}

/**
 * The KTX2 encoding of a kit texture by the slots that use it (`textureEncoding`, scripts/pack-downloads.ts): normals
 * UASTC, colour ETC1S sRGB, data ETC1S linear. A base colour that an alpha-masked or blended material reads (foliage
 * cut-outs) is UASTC sRGB instead, because ETC1S's shared endpoints fray the alpha edge.
 */
export function kitTextureEncoding(slots: ReadonlySet<string>, alphaMasked: boolean): TextureEncoding {
  const encoding = textureEncoding(slots);
  return alphaMasked && encoding === "etc1s-srgb" && slots.has("baseColorTexture") ? "uastc-srgb" : encoding;
}

/** Shared state of one kit's KTX2 pass: a scratch directory and each distinct image's encoding, by hash and encoding. */
export type Ktx2Cache = { scratch: string; encoded: Map<string, Uint8Array> };

/**
 * `asset` with every texture as KTX2 (KHR_texture_basisu, required, full mip chains), stored as a new asset. Each
 * distinct image and encoding is encoded once across the kit (`cache`), so the bundle still stores every texture
 * once. `slotEncoding` overrides `kitTextureEncoding`. A non-power-of-two image is resampled to the nearest power of
 * two, as scripts/pack-downloads.ts does.
 */
export async function ktx2Asset(root: string, asset: AssetRef, cache: Ktx2Cache,
  { slotEncoding }: { slotEncoding?: (slots: ReadonlySet<string>, alphaMasked: boolean) => TextureEncoding } = {}): Promise<AssetRef> {
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
  const slots = new Map<Texture, { slots: Set<string>; alphaMasked: boolean }>();
  for (const material of document.getRoot().listMaterials()) {
    const alphaMasked = material.getAlphaMode() !== "OPAQUE";
    for (const [slot, texture] of [
      ["baseColorTexture", material.getBaseColorTexture()], ["normalTexture", material.getNormalTexture()],
      ["metallicRoughnessTexture", material.getMetallicRoughnessTexture()], ["occlusionTexture", material.getOcclusionTexture()],
      ["emissiveTexture", material.getEmissiveTexture()],
    ] as const) {
      if (!texture) continue;
      const used = slots.get(texture) ?? { slots: new Set(), alphaMasked: false };
      used.slots.add(slot);
      if (slot === "baseColorTexture") used.alphaMasked ||= alphaMasked;
      slots.set(texture, used);
    }
  }
  if (slots.size === 0) return asset;
  for (const [texture, used] of slots) {
    const mimeType = texture.getMimeType();
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error(`kit texture '${texture.getName()}' is ${mimeType}, not PNG or JPEG`);
    const encoding = (slotEncoding ?? kitTextureEncoding)(used.slots, used.alphaMasked);
    const image = texture.getImage()!;
    const key = `${sha256Bytes(image)}:${encoding}`;
    let ktx2 = cache.encoded.get(key);
    if (!ktx2) {
      const input = path.join(cache.scratch, `${cache.encoded.size}.${mimeType === "image/png" ? "png" : "jpg"}`);
      const output = path.join(cache.scratch, `${cache.encoded.size}.ktx2`);
      await writeFile(input, image);
      const [width, height] = ImageUtils.getSize(image, mimeType)!;
      const target = kitTextureTarget(width, height);
      const resize = target.width !== width || target.height !== height ? target : undefined;
      const run = Bun.spawnSync([process.env.ASSET_TOOLING_KTX ?? "ktx", ...ktxArguments(encoding, input, output, resize)], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(`ktx create failed for ${texture.getName()}: ${run.stderr.toString()}`);
      ktx2 = new Uint8Array(await readFile(output));
      cache.encoded.set(key, ktx2);
    }
    texture.setImage(ktx2).setMimeType("image/ktx2");
  }
  document.createExtension(KHRTextureBasisu).setRequired(true);
  return (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: asset.kind, mediaType: "model/gltf-binary" })).asset;
}

/** Run `encode` with a fresh KTX2 cache whose scratch directory is removed afterwards. */
export async function withKtx2Cache<T>(label: string, encode: (cache: Ktx2Cache) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), `${label}-ktx2-`));
  try {
    return await encode({ scratch, encoded: new Map() });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Every asset of a kit with its textures as KTX2 (`ktx2Asset`), sharing one cache, in order. */
export async function ktx2Assets(root: string, label: string, assets: readonly AssetRef[]): Promise<AssetRef[]> {
  return withKtx2Cache(label, async (cache) => {
    const delivered: AssetRef[] = [];
    for (const asset of assets) delivered.push(await ktx2Asset(root, asset, cache));
    return delivered;
  });
}
