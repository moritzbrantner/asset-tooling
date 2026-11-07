/** Opt-in, end-to-end consumer timing: real download packing and optional hydrated Warden export loading. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Document, Logger, NodeIO } from "@gltf-transform/core";

import { exportAssetBundle, GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";

type Measurement = { scenario: string; samplesMs: number[]; medianMs: number; contentSha256: string };
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// Keep machine-readable stdout free of the library's informational per-mesh messages.
Logger.DEFAULT_INSTANCE = new Logger(Logger.Verbosity.ERROR);

function args() {
  const values = process.argv.slice(2);
  const option = (name: string) => { const i = values.indexOf(name); return i < 0 ? undefined : values[i + 1]; };
  const runs = Number(option("--runs") ?? "5");
  const scenes = (option("--scenes") ?? "8,64").split(",").map(Number);
  if (!Number.isSafeInteger(runs) || runs < 3 || runs > 30 || !scenes.length || scenes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 256)) {
    throw new Error("usage: bun scripts/benchmark-bundle-consumers.ts [--runs 3..30] [--scenes 8,64] [--warden <hydrated review directory>] [--source <asset-tooling checkout>]");
  }
  return { runs, scenes, warden: option("--warden"), source: path.resolve(option("--source") ?? repository) };
}

function median(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measure(scenario: string, runs: number, execute: (index: number) => Promise<{ elapsedMs: number; contentSha256: string }>): Promise<Measurement> {
  const expected = (await execute(-1)).contentSha256; // Warmup; its output is also the semantic oracle.
  const samplesMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const result = await execute(i);
    samplesMs.push(Number(result.elapsedMs.toFixed(3)));
    if (result.contentSha256 !== expected) throw new Error(`${scenario} produced different content in run ${i + 1}`);
  }
  return { scenario, samplesMs, medianMs: median(samplesMs), contentSha256: expected };
}

async function gltfFixture(root: string, count: number) {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  document.createScene().addChild(document.createNode("fixture").setMesh(document.createMesh().addPrimitive(document.createPrimitive().setAttribute("POSITION", positions))));
  const bytes = Buffer.from(await new NodeIO().writeBinary(document));
  const source = (await storeAssetObject(root, { bytes, kind: "scene", mediaType: "model/gltf-binary", metadata: { license: "CC0-1.0", sourceId: "bundle-consumer-benchmark" } })).asset;
  const directory = path.join(root, `gltf-bundle-${count}`);
  const assets = Array.from({ length: count }, (_, i) => ({ key: `model.${String(i).padStart(3, "0")}`, variant: "default" }));
  await exportAssetBundle(root, directory, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets },
    inputs: { assets: assets.map(() => source) },
  });
  return directory;
}

async function main() {
  const { runs, scenes, warden, source } = args();
  // A second checkout resolves its own dependency graph and therefore its own default glTF logger.
  if (source !== repository) {
    const { Logger: SourceLogger } = await import(pathToFileURL(path.join(source, "node_modules/@gltf-transform/core/dist/index.js")).href) as typeof import("@gltf-transform/core");
    SourceLogger.DEFAULT_INSTANCE = new SourceLogger(SourceLogger.Verbosity.ERROR);
  }
  // Import the actual source checkout, allowing an unchanged baseline to be measured by this same harness.
  const { packDownloads } = await import(pathToFileURL(path.join(source, "scripts/pack-downloads.ts")).href) as typeof import("./pack-downloads.js");
  const { loadApprovedWardenExport } = await import(pathToFileURL(path.join(source, "src/warden-icon-export.ts")).href) as typeof import("../src/warden-icon-export.js");
  const scratch = await mkdtemp(path.join(tmpdir(), "asset-bundle-consumer-benchmark-"));
  try {
    const measurements: Measurement[] = [];
    for (const count of scenes) {
      const directory = await gltfFixture(scratch, count);
      measurements.push(await measure(`pack-downloads.gltf-${count}-no-textures`, runs, async index => {
        const outDir = path.join(scratch, `packed-${count}-${index}`);
        const start = performance.now();
        const { index: result, indexFile } = await packDownloads({ bundleDir: directory, outDir, name: `fixture-${count}` });
        const elapsedMs = performance.now() - start;
        if (result.entries.length !== count) throw new Error("the packer lost a scene");
        const files = [...new Set([indexFile, ...result.entries.flatMap(entry => [...entry.files, ...entry.textures])])].sort();
        const hashes = await Promise.all(files.map(async file => ({ file, sha256: sha256Bytes(await readFile(path.join(outDir, file))) })));
        return { elapsedMs, contentSha256: sha256Bytes(Buffer.from(canonicalJson(hashes))) };
      }));
    }
    if (warden) {
      const review = path.resolve(warden);
      measurements.push(await measure("warden.approved-load-20-real-pngs", runs, async () => {
        const start = performance.now();
        const loaded = await loadApprovedWardenExport(review);
        const elapsedMs = performance.now() - start;
        if (loaded.images.length !== 20) throw new Error("approved Warden export must contain 20 images");
        return { elapsedMs, contentSha256: sha256Bytes(Buffer.from(loaded.images.map(image => `${image.key}/${image.variant}:${image.sha256}`).join("\n"))) };
      }));
    }
    const git = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, encoding: "utf8" }).trim();
    const fingerprint = async (file: string) => sha256Bytes(await readFile(path.join(source, file)));
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, sourceCommit: git, trackedChanges: dirty.length > 0,
      packerSha256: await fingerprint("scripts/pack-downloads.ts"), wardenLoaderSha256: await fingerprint("src/warden-icon-export.ts"),
      harnessSha256: sha256Bytes(await readFile(fileURLToPath(import.meta.url))),
      environment: { bun: Bun.version, platform: platform(), release: release(), arch: process.arch,
        cpuModel: cpus()[0]?.model ?? "unknown", cpus: cpus().length, memoryBytes: totalmem() },
      runs, scenes, hydratedWarden: Boolean(warden), measurements }, null, 2)}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
