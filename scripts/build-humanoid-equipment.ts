// Build the humanoid equipment kit (#517, docs/humanoid-equipment.md): the weapons, throwables, archery pieces and
// headwear every Ranger figure holds or wears, once, as their own rolling release:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-humanoid-equipment.ts --out <directory>
// The items are recipe presets (scripts/humanoid-equipment.ts) whose origin is their grip frame, each with its
// `humanoid-item` attachment; a consumer parents them through the figure's sockets descriptor. They ship no textures.
// <directory> becomes the object-store root: the bundle is exported to <directory>/bundle and packed to
// <directory>/humanoid.equipment.tar, and the per-entry downloads (scripts/pack-downloads.ts) and their
// humanoid-equipment.index.json are written next to it, as the Ranger figures publish theirs.
import path from "node:path";
import { availableParallelism } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import pLimit from "p-limit";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { exportKitBundle } from "../src/kit-bundle.js";
import { useSharedGenerationCache } from "./generation-cache.ts";
import { buildEquipmentItems } from "./humanoid-equipment.ts";
import { packDownloads } from "./pack-downloads.ts";

export const EQUIPMENT_RELEASE = "humanoid-equipment";
export const EQUIPMENT_TAR_NAME = "humanoid.equipment.tar";

export async function buildHumanoidEquipment({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const jobs = process.env.ASSET_TOOLING_JOBS ? Number(process.env.ASSET_TOOLING_JOBS) : Math.max(1, availableParallelism() - 1);
  const equipment = await buildEquipmentItems(root, { headwear: true, pool: pLimit(jobs), log });
  const packed = await exportKitBundle(root, {
    tarName: EQUIPMENT_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: equipment.selections },
      inputs: { assets: equipment.assets, attachments: equipment.attachments },
    },
  });
  return { ...packed, selections: equipment.selections, lineage: { release: EQUIPMENT_RELEASE, items: equipment.items } };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-humanoid-equipment.ts --out <directory>");
    process.exit(2);
  }
  // #516: the generation and operation caches outlive --out (ASSET_TOOLING_GENERATION_CACHE_DIR, default .asset-tooling/cache).
  useSharedGenerationCache();
  try {
    const log = (line: string) => console.error(`[equipment] ${line}`);
    const result = await buildHumanoidEquipment({ outDir: args[1]!, log });
    const out = path.resolve(args[1]!);
    await writeFile(path.join(out, "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    const { indexFile } = await packDownloads({ bundleDir: result.bundleDir, outDir: out, name: EQUIPMENT_RELEASE, log: (line) => console.error(`[downloads] ${line}`) });
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, exportRef: result.exportRef, index: indexFile }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
