// Turn a built gltf-resources-v1 bundle into per-entry downloads for a rolling release (Atlas Decision 7.1.5; owner
// decisions 2026-10-18: per-variant downloads, EXT_meshopt_compression and KTX2/Basis textures):
//   bun scripts/pack-downloads.ts --bundle <dir> --out <dir> --name <release name> [--clips <key>/<variant>]
// For every manifest entry (key, variant) it writes `<key>.<variant>.gltf` and `<key>.<variant>.bin`. The .bin
// is meshopt-compressed (EXT_meshopt_compression with KHR_mesh_quantization). The textures become shared,
// content-addressed `tex-<hash>.ktx2` files (KHR_texture_basisu): UASTC with Zstandard for normal maps, ETC1S
// (BasisLZ) for colour (sRGB) and for the data maps (ORM, roughness, occlusion), all with mipmaps. With `--clips`,
// that entry's animations go into one shared `<key>.clips.glb` (joints and clips, no meshes), and every download is
// clip-less. Characters that share the skeleton play the clips by joint name. The bundle's JSON attachments are
// copied as `<key>.<variant>.<attachment>.json`. `<name>.index.json` lists each download's files and bytes, so
// a consumer fetches only what it uses. KTX2 encoding needs KTX-Software's `ktx` CLI (ASSET_TOOLING_KTX, or `ktx`
// on PATH).
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { NodeIO, type Document, type Texture } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";
import { meshopt, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { readAssetBundleGltf, type GltfResourcesBundleManifest } from "../src/asset-bundle.js";
import { sha256Bytes } from "../src/hash.js";
import { canonicalJson } from "../src/canonical.js";

type Json = Record<string, any>;
export type TextureEncoding = "uastc" | "etc1s-srgb" | "etc1s-linear";
export const DOWNLOAD_INDEX_SCHEMA = "asset-downloads-v1";

/** The KTX2 encoding of a texture by the slots that use it: normals UASTC, colour sRGB ETC1S, data linear ETC1S. */
export function textureEncoding(slots: ReadonlySet<string>): TextureEncoding {
  if (slots.has("normalTexture")) return "uastc";
  if (slots.has("baseColorTexture") || slots.has("emissiveTexture")) return "etc1s-srgb";
  return "etc1s-linear";
}

/** Pixel size of a KTX2 file's base level, from its header (identifier, vkFormat, typeSize, pixelWidth, pixelHeight). */
export function ktx2Size(bytes: Uint8Array): { width: number; height: number } {
  const identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 28 || identifier.some((value, index) => bytes[index] !== value)) throw new Error("not a KTX2 file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(20, true), height: view.getUint32(24, true) };
}

function triangleCount(document: Document): number {
  let triangles = 0;
  for (const node of document.getRoot().listNodes()) {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const count = primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
      triangles += primitive.getMode() === 4 ? count / 3 : 0;
    }
  }
  return triangles;
}

/** The nearest power of two: block-compressed GPU formats and full mip chains need it (#124). */
export function powerOfTwo(value: number): number {
  return 2 ** Math.max(0, Math.round(Math.log2(value)));
}

export function ktxArguments(encoding: TextureEncoding, input: string, output: string, size?: { width: number; height: number }): string[] {
  const common = ["create", "--generate-mipmap", ...(size ? ["--width", String(size.width), "--height", String(size.height)] : [])];
  if (encoding === "uastc") {
    return [...common, "--format", "R8G8B8A8_UNORM", "--assign-tf", "linear", "--encode", "uastc", "--uastc-quality", "2", "--zstd", "18", input, output];
  }
  const srgb = encoding === "etc1s-srgb";
  return [...common, "--format", srgb ? "R8G8B8A8_SRGB" : "R8G8B8A8_UNORM", "--assign-tf", srgb ? "srgb" : "linear",
    "--encode", "basis-lz", "--clevel", "2", "--qlevel", "160", input, output];
}

function textureSlots(document: Document): Map<Texture, Set<string>> {
  const slots = new Map<Texture, Set<string>>();
  for (const material of document.getRoot().listMaterials()) {
    for (const [slot, texture] of [
      ["baseColorTexture", material.getBaseColorTexture()], ["normalTexture", material.getNormalTexture()],
      ["metallicRoughnessTexture", material.getMetallicRoughnessTexture()], ["occlusionTexture", material.getOcclusionTexture()],
      ["emissiveTexture", material.getEmissiveTexture()],
    ] as const) {
      if (!texture) continue;
      if (!slots.has(texture)) slots.set(texture, new Set());
      slots.get(texture)!.add(slot);
    }
  }
  return slots;
}

export async function packDownloads({ bundleDir, outDir, name, clips, log = () => {} }: {
  bundleDir: string; outDir: string; name: string; clips?: string; log?: (line: string) => void;
}) {
  const ktx = process.env.ASSET_TOOLING_KTX ?? "ktx";
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  const manifest = JSON.parse(await readFile(path.join(bundleDir, "manifest.json"), "utf8")) as GltfResourcesBundleManifest;
  await mkdir(outDir, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pack-downloads-"));
  const encoded = new Map<string, string>(); // `${png sha256}:${encoding}` -> ktx2 file name
  const encodings: Record<string, TextureEncoding> = {};
  const written = async (file: string, bytes: Uint8Array | Buffer) => { await writeFile(path.join(outDir, file), bytes); return file; };
  const size = async (file: string) => (await stat(path.join(outDir, file))).size;
  const entries: Json[] = [];
  let clipsFile: string | undefined;
  try {
    for (const asset of manifest.assets) {
      const id = `${asset.key}/${asset.variant}`;
      const { gltf, resources } = await readAssetBundleGltf(bundleDir, manifest, asset.key, asset.variant);
      const document = await io.readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries([...resources].map(([uri, bytes]) => [uri, new Uint8Array(bytes)])) });
      const root = document.getRoot();
      if (clips === id && root.listAnimations().length > 0) {
        // The shared clips: the skeleton's nodes and every animation, without meshes, skins or materials.
        const clipDocument = await io.readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries([...resources].map(([uri, bytes]) => [uri, new Uint8Array(bytes)])) });
        for (const node of clipDocument.getRoot().listNodes()) { node.setMesh(null); node.setSkin(null); }
        for (const mesh of clipDocument.getRoot().listMeshes()) mesh.dispose();
        for (const skin of clipDocument.getRoot().listSkins()) skin.dispose();
        for (const material of clipDocument.getRoot().listMaterials()) material.dispose();
        for (const texture of clipDocument.getRoot().listTextures()) texture.dispose();
        for (const accessor of clipDocument.getRoot().listAccessors()) if (accessor.listParents().every((parent) => parent === clipDocument.getRoot())) accessor.dispose();
        await clipDocument.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
        clipsFile = await written(`${asset.key}.clips.glb`, await io.writeBinary(clipDocument));
        log(`clips ${clipsFile} (${root.listAnimations().length} clips)`);
      }
      if (clips) {
        for (const animation of root.listAnimations()) {
          for (const channel of animation.listChannels()) channel.dispose();
          for (const sampler of animation.listSamplers()) { sampler.getInput()?.dispose(); sampler.getOutput()?.dispose(); sampler.dispose(); }
          animation.dispose();
        }
        // Empty named leaves include equipment grip frames used by real consumers.
        await document.transform(prune({ keepLeaves: true }));
      }
      // Textures: shared KTX2 files, encoded once per source image and encoding.
      const textureFiles: string[] = [];
      const slots = textureSlots(document);
      if (root.listTextures().length > 0) document.createExtension(KHRTextureBasisu).setRequired(true);
      for (const texture of root.listTextures()) {
        const png = texture.getImage()!;
        const encoding = textureEncoding(slots.get(texture) ?? new Set());
        const cacheKey = `${sha256Bytes(png)}:${encoding}`;
        let file = encoded.get(cacheKey);
        if (!file) {
          const input = path.join(scratch, `${encoded.size}.png`), output = path.join(scratch, `${encoded.size}.ktx2`);
          await writeFile(input, png);
          // Non-power-of-two images (for example a 1008 x 981 flower sheet) are resampled to the nearest power of two:
          // they otherwise decode black on WebGL's block-compressed path.
          const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
          const [width, height] = [view.getUint32(16), view.getUint32(20)];
          const target = { width: powerOfTwo(width), height: powerOfTwo(height) };
          const resize = target.width !== width || target.height !== height ? target : undefined;
          const run = Bun.spawnSync([ktx, ...ktxArguments(encoding, input, output, resize)], { stdout: "pipe", stderr: "pipe" });
          if (run.exitCode !== 0) throw new Error(`ktx create failed for ${id} texture '${texture.getName()}': ${run.stderr.toString()}`);
          const bytes = await readFile(output);
          file = await written(`tex-${sha256Bytes(bytes).slice(0, 16)}.ktx2`, bytes);
          encoded.set(cacheKey, file);
          encodings[file] = encoding;
        }
        texture.setImage(await readFile(path.join(outDir, file))).setMimeType("image/ktx2").setURI(file);
        textureFiles.push(file);
      }
      await document.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
      const base = `${asset.key}.${asset.variant}`;
      for (const buffer of root.listBuffers()) buffer.setURI(`${base}.bin`);
      const { json, resources: out } = await io.writeJSON(document);
      const files = [await written(`${base}.gltf`, Buffer.from(JSON.stringify(json)))];
      for (const [uri, bytes] of Object.entries(out)) if (uri.endsWith(".bin")) files.push(await written(uri, bytes));
      for (const attachment of asset.attachments ?? []) {
        files.push(await written(`${base}.${attachment.name}.json`, await readFile(path.join(bundleDir, attachment.path))));
      }
      const unique = [...new Set(textureFiles)].sort();
      const bytes = (await Promise.all([...files, ...unique].map(size))).reduce((sum, value) => sum + value, 0);
      // #124: what the entry costs at runtime, separately from its download bytes. GPU memory is estimated from the
      // KTX2 headers: Basis transcodes to a 1-byte-per-texel block format (BC7/ETC2/ASTC 4x4), and an RGBA8 fallback
      // would take 4 bytes per texel; a full mip chain adds a third.
      const gpu = { compressedBytes: 0, rgba8FallbackBytes: 0 };
      for (const file of unique) {
        const { width, height } = ktx2Size(await readFile(path.join(outDir, file)));
        gpu.compressedBytes += Math.round(width * height * 4 / 3);
        gpu.rgba8FallbackBytes += Math.round(width * height * 4 * 4 / 3);
      }
      const drawCalls = root.listNodes().reduce((sum, node) => sum + (node.getMesh()?.listPrimitives().length ?? 0), 0);
      entries.push({ key: asset.key, variant: asset.variant, files, textures: unique, bytes,
        runtime: { textureMemoryEstimate: gpu, materials: root.listMaterials().length, drawCalls, triangles: triangleCount(document) },
        ...(clips && asset.key === clips.split("/")[0] && clipsFile ? { clips: clipsFile } : {}) });
      log(`${id}: ${(bytes / 1e6).toFixed(2)} MB (${files.length} files, ${unique.length} textures)`);
    }
    const index = {
      schema: DOWNLOAD_INDEX_SCHEMA, release: name,
      decoders: { mesh: "EXT_meshopt_compression (three.js: GLTFLoader.setMeshoptDecoder(MeshoptDecoder))", textures: "KHR_texture_basisu (three.js: GLTFLoader.setKTX2Loader(new KTX2Loader().setTranscoderPath(...).detectSupport(renderer)))" },
      ...(clipsFile ? { clips: { file: clipsFile, bytes: await size(clipsFile), binding: "play on any entry of the same key by joint name" } } : {}),
      textureEncodings: Object.fromEntries(Object.entries(encodings).sort()),
      entries,
    };
    const indexFile = await written(`${name}.index.json`, Buffer.from(`${canonicalJson(index)}\n`));
    return { index, indexFile };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2), option = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const bundleDir = option("--bundle"), outDir = option("--out"), name = option("--name");
  if (!bundleDir || !outDir || !name) {
    console.error("Usage: bun scripts/pack-downloads.ts --bundle <dir> --out <dir> --name <release name> [--clips <key>/<variant>]");
    process.exit(2);
  }
  const clips = option("--clips");
  const { index, indexFile } = await packDownloads({ bundleDir: path.resolve(bundleDir), outDir: path.resolve(outDir), name, ...(clips ? { clips } : {}), log: (line) => console.error(`[downloads] ${line}`) });
  console.log(JSON.stringify({ index: indexFile, entries: index.entries.length }, null, 2));
}
