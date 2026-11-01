// Greyhaven terrain ground materials for mmorpg#525: seven CC0 Poly Haven PBR layers, each a 1 m tiling quad whose
// material carries the colour (with height in alpha), normal and AO/roughness/metal maps. See docs/greyhaven-terrain.md.
// All input bytes come from the hydrated, verified catalog; this build never downloads and needs no Blender.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Document, NodeIO, TextureInfo } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { executeGltfTextureResizeOperation } from "../src/gltf-texture-resize-operations.js";
import { executeImageDecodeOperation, executeImageEncodePngOperation } from "../src/image-codec-operations.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "../src/image-rgba8.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const TERRAIN_DESCRIPTOR_SCHEMA = "greyhaven-terrain-descriptor-v1";
export const TERRAIN_DESCRIPTOR_ATTACHMENT = "terrain-descriptor";
export const TERRAIN_TAR_NAME = "greyhaven.terrain.tar";
/**
 * The ground layers. tileMetres is the real-world edge Poly Haven gives for the scan (api.polyhaven.com/info/<id>
 * `dimensions`, millimetres / 1000, rounded to 0.01): one texture repeat covers that many metres of ground.
 */
export const TERRAIN_LAYERS = [
  { layer: "grass", polyHavenId: "forrest_ground_01", tileMetres: 2 },
  { layer: "forest", polyHavenId: "forest_leaves_02", tileMetres: 3 },
  { layer: "path", polyHavenId: "rocky_trail", tileMetres: 2 },
  { layer: "gravel", polyHavenId: "rocks_ground_02", tileMetres: 2 },
  { layer: "rock", polyHavenId: "rock_face_03", tileMetres: 2.7 },
  { layer: "mud", polyHavenId: "brown_mud_02", tileMetres: 1.3 },
  { layer: "sand", polyHavenId: "sand_01", tileMetres: 1.5 },
] as const;
/** The Poly Haven 2K JPG maps each layer reads, by catalog source-id suffix. */
export const TERRAIN_MAPS = ["diff", "nor-gl", "arm", "disp"] as const;
export const terrainKey = (layer: string) => `greyhaven.terrain.${layer}`;
export const terrainSourceId = (polyHavenId: string, map: (typeof TERRAIN_MAPS)[number]) =>
  `poly-haven.${polyHavenId.replaceAll("_", "-")}-${map}-2k-jpg`;
export const TERRAIN_TEXTURE_POLICY = {
  maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512 },
  default: 1024,
} as const;
/** Height percentiles that map to alpha 128 and 255. */
export const TERRAIN_HEIGHT_PERCENTILES = [0.01, 0.99] as const;
const POLICY = { allowedValidatorWarnings: [] as string[] };

/**
 * Base-colour alpha from a height map's red channel (RGBA8 pixels): h is the height normalised so its 1st percentile
 * maps to 0 and its 99th to 1 (clamped), and alpha = round(255 * (0.5 + 0.5 * h)), so alpha lies in 128..255.
 */
export function terrainHeightAlpha(heightRgba: Uint8Array): { alpha: Uint8Array; low: number; high: number } {
  const count = heightRgba.length / 4;
  const histogram = new Uint32Array(256);
  for (let index = 0; index < count; index += 1) histogram[heightRgba[index * 4]!]! += 1;
  const percentile = (fraction: number) => {
    const target = fraction * count;
    let cumulative = 0;
    for (let value = 0; value < 256; value += 1) {
      cumulative += histogram[value]!;
      if (cumulative >= target) return value;
    }
    return 255;
  };
  const [low, high] = TERRAIN_HEIGHT_PERCENTILES.map(percentile) as [number, number];
  const span = Math.max(high - low, 1);
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value += 1) {
    const h = Math.min(1, Math.max(0, (value - low) / span));
    table[value] = Math.round(255 * (0.5 + 0.5 * h));
  }
  const alpha = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) alpha[index] = table[heightRgba[index * 4]!]!;
  return { alpha, low, high };
}

const srgbToLinear = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** Mean RGB of an sRGB RGBA8 image in linear light, to 4 decimals. */
export function linearMeanColor({ pixels }: Rgba8Image): [number, number, number] {
  const table = Float64Array.from({ length: 256 }, (_, value) => srgbToLinear(value));
  const sum = [0, 0, 0];
  const count = pixels.length / 4;
  for (let index = 0; index < count; index += 1) for (let c = 0; c < 3; c += 1) sum[c] += table[pixels[index * 4 + c]!]!;
  return sum.map((value) => Number((value / count).toFixed(4))) as [number, number, number];
}

/**
 * The normal and AO/roughness/metal JPEG encoding: FFmpeg's MJPEG at qscale 2 with full 4:4:4 chroma, about libjpeg
 * quality 92 in size (the Poly Haven normal sources are 4:4:4 too).
 */
export const TERRAIN_JPEG = { encoder: "ffmpeg-mjpeg", qscale: 2, pixelFormat: "yuvj444p" } as const;
function encodeJpeg(png: Uint8Array, key: string): Uint8Array {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-f", "png_pipe", "-i", "pipe:0", "-frames:v", "1", "-pix_fmt", TERRAIN_JPEG.pixelFormat,
    "-c:v", "mjpeg", "-q:v", String(TERRAIN_JPEG.qscale), "-f", "image2pipe", "pipe:1"], { input: png, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${key}: JPEG encode failed: ${result.error?.message ?? result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}

function single(result: AssetOperationResult): AssetRef {
  const ref = result.outputs.output;
  if (!ref || Array.isArray(ref)) throw new Error("asset operation returned no single output");
  return ref;
}

/** A 1 m x 1 m quad on the XZ plane facing +Y, UV 0..1 (u along +X, v along +Z), tangent +X. */
function quad(document: Document) {
  const buffer = document.createBuffer();
  const accessor = (type: "VEC2" | "VEC3" | "VEC4" | "SCALAR", array: Float32Array | Uint16Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  return document.createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5])))
    .setAttribute("NORMAL", accessor("VEC3", new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0])))
    .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])))
    .setAttribute("TANGENT", accessor("VEC4", new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1])))
    .setIndices(accessor("SCALAR", new Uint16Array([0, 3, 2, 0, 2, 1])));
}

export async function buildGreyhavenTerrain(outDir: string, log: (message: string) => void = () => {}) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const io = new NodeIO();
  const decode = async (asset: AssetRef) => {
    const image = single(await executeImageDecodeOperation(root, { inputs: { source: asset } }));
    return parseRgba8Image(new Uint8Array(await resolveAssetObject(root, image)));
  };
  const built = [];
  for (const entry of TERRAIN_LAYERS) {
    const key = terrainKey(entry.layer);
    log(`${key}: ${entry.polyHavenId}`);
    const maps = {} as Record<(typeof TERRAIN_MAPS)[number], { sourceId: string; asset: AssetRef }>;
    for (const map of TERRAIN_MAPS) {
      const sourceId = terrainSourceId(entry.polyHavenId, map);
      const imported = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
      // Decoding takes image assets, so the verified bytes are re-stored under that kind.
      const bytes = await resolveAssetObject(root, imported);
      maps[map] = { sourceId, asset: (await storeAssetObject(root, { bytes, kind: "image", mediaType: "image/jpeg" })).asset };
    }
    const colour = await decode(maps.diff.asset);
    const height = await decode(maps.disp.asset);
    if (colour.width !== height.width || colour.height !== height.height) throw new Error(`${key}: colour and height sizes differ`);
    const { alpha, low, high } = terrainHeightAlpha(height.pixels);
    const pixels = new Uint8Array(colour.pixels);
    for (let index = 0; index < alpha.length; index += 1) pixels[index * 4 + 3] = alpha[index]!;
    const rgba = (await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width: colour.width, height: colour.height, pixels }), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    })).asset;
    const basePng = await resolveAssetObject(root, single(await executeImageEncodePngOperation(root, { inputs: { source: rgba } })));

    // The full-resolution source GLB; scene.textures.resize.gltf@1 then brings every map to the policy edge as PNG.
    const document = new Document();
    const texture = (name: string, image: Uint8Array, mimeType: string) => document.createTexture(name).setImage(image).setMimeType(mimeType);
    const arm = texture(`${entry.layer}-arm`, new Uint8Array(await resolveAssetObject(root, maps.arm.asset)), "image/jpeg");
    const material = document.createMaterial(entry.layer)
      .setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(1)
      .setAlphaMode("MASK").setAlphaCutoff(0.5)
      .setBaseColorTexture(texture(`${entry.layer}-base`, new Uint8Array(basePng), "image/png"))
      .setNormalTexture(texture(`${entry.layer}-normal`, new Uint8Array(await resolveAssetObject(root, maps["nor-gl"].asset)), "image/jpeg"))
      .setMetallicRoughnessTexture(arm)
      .setOcclusionTexture(arm);
    for (const info of [material.getBaseColorTextureInfo(), material.getNormalTextureInfo(), material.getMetallicRoughnessTextureInfo(), material.getOcclusionTextureInfo()]) {
      info!.setWrapS(TextureInfo.WrapMode.REPEAT).setWrapT(TextureInfo.WrapMode.REPEAT)
        .setMinFilter(TextureInfo.MinFilter.LINEAR_MIPMAP_LINEAR).setMagFilter(TextureInfo.MagFilter.LINEAR);
    }
    const mesh = document.createMesh(key).addPrimitive(quad(document).setMaterial(material));
    const node = document.createNode(key).setMesh(mesh);
    document.getRoot().setDefaultScene(document.createScene(key).addChild(node));
    const source = (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: "scene", mediaType: "model/gltf-binary" })).asset;
    const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source }, parameters: { policy: POLICY } }));
    const asset = single(await executeGltfTextureResizeOperation(root, { inputs: { source: imported }, parameters: { ...TERRAIN_TEXTURE_POLICY, policy: POLICY } }));

    // The shipped base-colour texture: its linear mean lets clients re-centre the detail on the game's palette.
    const resized = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
    const shipped = resized.getRoot().listMaterials()[0]!;
    const shippedBase = shipped.getBaseColorTexture()!;
    const expected = [[shippedBase, 1024], [shipped.getNormalTexture()!, 1024], [shipped.getMetallicRoughnessTexture()!, 512]] as const;
    for (const [shippedTexture, edge] of expected) {
      const size = shippedTexture.getSize();
      if (shippedTexture.getMimeType() !== "image/png" || size?.[0] !== edge || size[1] !== edge) throw new Error(`${key}: expected a ${edge}px PNG, got ${shippedTexture.getMimeType()} ${size}`);
    }
    const basePacked = (await storeAssetObject(root, { bytes: shippedBase.getImage()!, kind: "image", mediaType: "image/png" })).asset;
    const meanColor = linearMeanColor(await decode(basePacked));
    // Size: the normal and AO/roughness/metal maps ship as 4:4:4 JPEG; the base colour stays PNG for its height alpha.
    for (const jpeg of [shipped.getNormalTexture()!, shipped.getMetallicRoughnessTexture()!]) {
      jpeg.setImage(encodeJpeg(jpeg.getImage()!, key)).setMimeType("image/jpeg");
    }
    const delivered = (await storeAssetObject(root, { bytes: await io.writeBinary(resized), kind: "scene", mediaType: "model/gltf-binary" })).asset;
    built.push({
      entry, key, asset: delivered, meanColor,
      provenance: {
        license: "CC0-1.0", authors: sources.sources.find((item: { id: string }) => item.id === maps.diff.sourceId)?.metadata?.author,
        evidenceUrl: `https://polyhaven.com/a/${entry.polyHavenId}`,
        sources: Object.fromEntries(TERRAIN_MAPS.map((map) => [map, { id: maps[map].sourceId, sha256: maps[map].asset.sha256 }])),
        heightPercentiles: { low, high },
      },
    });
  }
  const descriptor = {
    schema: TERRAIN_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y",
    encoding: {
      baseColor: "PNG; RGB = Poly Haven colour (sRGB); A = round(255 * (0.5 + 0.5 * h)), h = height normalised from its 1st (0) to 99th (1) percentile, clamped",
      metallicRoughness: "JPEG; R = ambient occlusion, G = roughness, B = metal (Poly Haven arm); also the occlusion texture",
      normal: "JPEG; OpenGL (+Y) tangent-space normal",
      jpeg: TERRAIN_JPEG,
      meanColor: "mean RGB of the shipped base-colour texture in linear light",
    },
    texturePolicy: TERRAIN_TEXTURE_POLICY,
    layers: built.map(({ entry, key, meanColor, provenance }) => ({
      key, variant: "default", layer: entry.layer, polyHavenId: entry.polyHavenId, tileMetres: entry.tileMetres, meanColor, provenance,
    })),
  };
  const attachment = (await storeAssetObject(root, {
    bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "descriptor", mediaType: "application/json", metadata: { schema: TERRAIN_DESCRIPTOR_SCHEMA },
  })).asset;
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: {
      profile: GLTF_RESOURCES_BUNDLE_PROFILE,
      assets: built.map(({ key }, index) => ({ key, variant: "default", ...(index === 0 ? { attachments: [{ name: TERRAIN_DESCRIPTOR_ATTACHMENT }] } : {}) })),
    },
    inputs: { assets: built.map(({ asset }) => asset), attachments: [attachment] },
  });
  const tar = path.join(root, TERRAIN_TAR_NAME);
  const pack = Bun.spawnSync(["bun", path.join(ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tar], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`bundle packing failed: ${pack.stderr.toString()}`);
  const tarBytes = await readFile(tar);
  const ref = readAssetBundleTar(tarBytes).find((item) => item.path === ASSET_BUNDLE_REF_FILE);
  if (!ref) throw new Error("packed terrain bundle has no export ref");
  await writeFile(path.join(root, ASSET_BUNDLE_REF_FILE), ref.bytes);
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  log(`${TERRAIN_TAR_NAME}: ${(tarBytes.byteLength / 1e6).toFixed(1)} MB`);
  return { bundleDir, tar, byteLength: tarBytes.byteLength, descriptor, manifest: exported.manifest, exportRef: JSON.parse(ref.bytes.toString("utf8")) };
}

if (import.meta.main) {
  const [flag, out, ...extra] = process.argv.slice(2);
  if (flag !== "--out" || !out || extra.length) throw new Error("Usage: bun scripts/build-greyhaven-terrain.ts --out <directory>");
  const built = await buildGreyhavenTerrain(out, console.error);
  console.log(JSON.stringify({ tar: built.tar, byteLength: built.byteLength, exportRef: built.exportRef }, null, 2));
}
