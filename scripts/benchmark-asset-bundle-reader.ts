// Repeated read-all comparison for #453. Synthetic valid atlas transport, not a full export/verify benchmark.
// Usage: bun scripts/benchmark-asset-bundle-reader.ts --runs 5
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createAssetRef } from "../src/operations.js";
import { sha256Bytes } from "../src/hash.js";
import { createAssetBundleReader, readAssetBundleAsset, SPRITE_ATLAS_BUNDLE_PROFILE, type SpriteAtlasBundleManifest } from "../src/asset-bundle.js";
import { RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { SPRITE_ATLAS_MEDIA_TYPE } from "../src/sprite-atlas-operations.js";

const count = 256, resourceCount = 3584;
const flagIndex = process.argv.indexOf("--runs");
const runs = flagIndex < 0 ? 5 : Number(process.argv[flagIndex + 1]);
if (!Number.isInteger(runs) || runs < 1 || runs > 15) throw new Error("--runs must be 1..15");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-reader-bench-"));
  try {
    await mkdir(path.join(directory, "assets"));
    const atlasBytes = Buffer.from("synthetic atlas payload; reader checks hash and byte length only");
    const source = createAssetRef({ kind: "sprite-atlas", mediaType: SPRITE_ATLAS_MEDIA_TYPE,
      sha256: sha256Bytes(atlasBytes), byteLength: atlasBytes.length, metadata: {} });
    const atlasPath = `assets/${source.sha256}.atlas.json`;
    await writeFile(path.join(directory, atlasPath), atlasBytes);
    const png = createAssetRef({ kind: "image", mediaType: "image/png", sha256: "f".repeat(64), byteLength: 1, metadata: {} });
    const resources = Array.from({ length: resourceCount }, (_, i) => {
      const ref = createAssetRef({ kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
        sha256: i.toString(16).padStart(64, "0"), byteLength: 1, metadata: {} });
      return { source: ref, path: `assets/${ref.sha256}.rgba.json` };
    });
    const keys = Array.from({ length: count }, (_, i) => `sprite.${i.toString().padStart(3, "0")}`);
    const manifest: SpriteAtlasBundleManifest = {
      schemaVersion: 2, profile: SPRITE_ATLAS_BUNDLE_PROFILE,
      assets: keys.map(key => ({ key, variant: "default", source, path: atlasPath,
        image: { source: png, path: `assets/${png.sha256}.png` } })), resources,
    };
    const legacy = async () => {
      let bytes = 0;
      for (const key of keys) bytes += (await readAssetBundleAsset(directory, manifest, key, "default")).length;
      return bytes;
    };
    const indexed = async () => {
      const reader = createAssetBundleReader(directory, manifest);
      let bytes = 0;
      for (const key of keys) bytes += (await reader.readAsset(key, "default")).length;
      return bytes;
    };
    const samples = { legacyMs: [] as number[], indexedMs: [] as number[] };
    const expectedBytes = keys.length * atlasBytes.length;
    // Warm both alternatives before measuring and alternate the order across repetitions.
    if (await legacy() !== expectedBytes || await indexed() !== expectedBytes) throw new Error("warmup mismatch");
    const time = async (fn: () => Promise<number>) => {
      const start = performance.now();
      if (await fn() !== expectedBytes) throw new Error("read-all result mismatch");
      return Number((performance.now() - start).toFixed(3));
    };
    for (let i = 0; i < runs; i++) {
      if (i % 2 === 0) { samples.legacyMs.push(await time(legacy)); samples.indexedMs.push(await time(indexed)); }
      else { samples.indexedMs.push(await time(indexed)); samples.legacyMs.push(await time(legacy)); }
    }
    console.log(JSON.stringify({ profile: SPRITE_ATLAS_BUNDLE_PROFILE, assets: count, resources: resourceCount,
      note: "valid transport shape with synthetic resources; timings include per-read filesystem access and hashes, not atlas payload validation or package verification",
      runs, medianMs: { legacy: median(samples.legacyMs), indexed: median(samples.indexedMs) }, samples }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
