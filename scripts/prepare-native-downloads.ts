// Decode selected, already-acquired packed entries for standard native glTF import.
// glTF Transform/meshoptimizer and Khronos KTX-Software own the codecs, not the game.
import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dequantize } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";

type Entry = { key: string; variant: string; files: string[]; textures: string[]; clips?: string };
type Index = { schema: "asset-downloads-v1"; release: string; entries: Entry[] };
function fileName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && path.basename(value) === value;
}
function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return fileName(entry.key) && fileName(entry.variant) &&
    Array.isArray(entry.files) && entry.files.every(fileName) && Array.isArray(entry.textures) && entry.textures.every(fileName) &&
    (entry.clips === undefined || fileName(entry.clips));
}
function indexOf(value: unknown): Index {
  if (typeof value !== "object" || value === null) throw new Error("download index must be an object");
  const index = value as Record<string, unknown>;
  if (index.schema !== "asset-downloads-v1" || typeof index.release !== "string" || !Array.isArray(index.entries) || !index.entries.every(isEntry)) {
    throw new Error("unsupported or malformed download index");
  }
  return { schema: "asset-downloads-v1", release: index.release, entries: index.entries };
}
async function sameFile(file: string, bytes: Uint8Array): Promise<boolean> {
  try { return (await readFile(file)).equals(bytes); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Network-free preparation. Inputs and their rolling release/source/license metadata stay intact. */
export async function prepareNativeDownloads(options: {
  index: string; entries: readonly string[]; outDir: string; ktx?: string;
}) {
  const index = indexOf(JSON.parse(await readFile(options.index, "utf8")));
  if (options.entries.length === 0 || new Set(options.entries).size !== options.entries.length) {
    throw new Error("select at least one entry, without duplicates");
  }
  const selected = options.entries.map((name) => {
    const matches = index.entries.filter((entry) => `${entry.key}/${entry.variant}` === name);
    if (matches.length !== 1) throw new Error(`download index must declare exactly one ${name}`);
    return matches[0]!;
  });
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const directory = path.dirname(path.resolve(options.index));
  const output = path.resolve(options.outDir);
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(path.join(output, ".native-downloads-"));
  const decodedTextures = new Map<string, Uint8Array>();
  const preparedClips = new Set<string>();
  const results: { key: string; variant: string; file: string; changed: boolean; clips?: string }[] = [];
  try {
    for (const entry of selected) {
      if (entry.clips) await readFile(path.join(directory, entry.clips));
      const scenes = entry.files.filter((file) => file.endsWith(".gltf"));
      if (scenes.length !== 1) throw new Error(`${entry.key}/${entry.variant} must have one glTF file`);
      const resourceFiles = [...new Set([...entry.files, ...entry.textures])].filter((file) => file !== scenes[0]);
      const resources = Object.fromEntries(await Promise.all(resourceFiles.map(async (file) => [file, await readFile(path.join(directory, file))])));
      // NodeIO validates glTF semantics; only resources declared by this entry are supplied.
      const document = await io.readJSON({ json: JSON.parse(await readFile(path.join(directory, scenes[0]!), "utf8")), resources });
      for (const texture of document.getRoot().listTextures()) {
        if (texture.getMimeType() !== "image/ktx2") continue;
        const uri = texture.getURI();
        if (!entry.textures.includes(uri)) throw new Error(`undeclared Basis texture ${uri}`);
        let png = decodedTextures.get(uri);
        if (!png) {
          const target = path.join(scratch, `${uri}.png`);
          const run = Bun.spawnSync([options.ktx ?? process.env.ASSET_TOOLING_KTX ?? "ktx", "extract", "--transcode", "rgba8", path.join(directory, uri), target], { stdout: "pipe", stderr: "pipe" });
          if (run.exitCode !== 0) throw new Error(`KTX extraction failed for ${uri}: ${run.stderr.toString()}`);
          png = await readFile(target);
          decodedTextures.set(uri, png);
        }
        texture.setImage(png).setMimeType("image/png").setURI(`${uri}.png`);
      }
      for (const extension of document.getRoot().listExtensionsUsed()) {
        if (extension.extensionName === "KHR_texture_basisu" || extension.extensionName === "EXT_meshopt_compression") extension.dispose();
      }
      await document.transform(dequantize());
      const bytes = await io.writeBinary(document);
      const file = `${entry.key}.${entry.variant}.native.glb`;
      const destination = path.join(output, file);
      const changed = !await sameFile(destination, bytes);
      if (changed) {
        const temporary = path.join(scratch, file);
        await writeFile(temporary, bytes);
        await rename(temporary, destination);
      }
      // The animation-only library is compressed too; decode it once, still shared by joint name.
      const nativeClips = entry.clips?.replace(/\.glb$/, ".native.glb");
      if (entry.clips && nativeClips && !preparedClips.has(entry.clips)) {
        const library = await io.readBinary(await readFile(path.join(directory, entry.clips)));
        for (const extension of library.getRoot().listExtensionsUsed()) {
          if (extension.extensionName === "EXT_meshopt_compression") extension.dispose();
        }
        await library.transform(dequantize());
        const libraryBytes = await io.writeBinary(library);
        const target = path.join(output, nativeClips);
        if (!await sameFile(target, libraryBytes)) {
          const temporary = path.join(scratch, nativeClips);
          await writeFile(temporary, libraryBytes);
          await rename(temporary, target);
        }
        preparedClips.add(entry.clips);
      }
      results.push({ key: entry.key, variant: entry.variant, file, changed, ...(nativeClips ? { clips: nativeClips } : {}) });
    }
    return { release: index.release, entries: results };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const index = option("--index"), outDir = option("--out"), entries = option("--entries");
  if (!index || !outDir || !entries) {
    console.error("Usage: bun scripts/prepare-native-downloads.ts --index <local index.json> --entries <key/variant,...> --out <dir>");
    process.exit(2);
  }
  console.log(JSON.stringify(await prepareNativeDownloads({ index, outDir, entries: entries.split(",") }), null, 2));
}
