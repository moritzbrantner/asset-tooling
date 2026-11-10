// What a built gltf-resources kit bundle costs: its download, the textures it holds on the GPU and, per entry, draws
// and triangles. A kit's material count matters most: batched scenery draws once per material in the main pass, so each
// extra material is an extra draw there (docs/asset-bundles.md#kit-costs).
//   bun scripts/report-kit-costs.ts --bundle <dir> [--budget <release>]
// Read-only. With --budget it exits 1 when the kit is over KIT_BUDGETS[release], the `budget` in releases/<release>.json.
// Kits without a budget are only reported.
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { ImageUtils } from "@gltf-transform/core";
import { ktx2Size } from "./pack-downloads.ts";
import { readReleaseData } from "./release-data.ts";

export const KIT_COST_SCHEMA = "kit-cost-report-v1";

export type KitBudget = { materials: number; textureMemoryBytes: number; downloadBytes: number };
const MB = 1024 * 1024;
/**
 * Limits per rolling release, checked when a release is published: the `budget` in its releases/<release>.json
 * (scripts/release-data.ts). Kits packed into atlases have their real limits; the others are held at what they cost
 * when these limits were set (2026-11-08), so they can only get cheaper.
 */
export const KIT_BUDGETS: Record<string, KitBudget> = Object.fromEntries(
  readReleaseData(path.resolve(import.meta.dir, "..")).flatMap(([name, { budget }]) => budget
    ? [[name, { materials: budget.materials, textureMemoryBytes: budget.textureMemoryMB * MB, downloadBytes: budget.downloadMB * MB }]]
    : []),
);

export type KitEntryCost = { key: string; variant: string; materials: number; drawCalls: number; triangles: number };
export type KitCost = {
  schema: typeof KIT_COST_SCHEMA; entries: KitEntryCost[]; materials: string[]; textures: number; textureMemoryBytes: number; downloadBytes: number;
  maxima: { drawCalls: number; triangles: number };
};

type Gltf = {
  materials?: { name?: string }[]; meshes?: { primitives: { indices?: number; mode?: number; attributes: { POSITION?: number } }[] }[];
  nodes?: { mesh?: number }[]; accessors?: { count: number }[];
};
type Resource = { path: string; mediaType?: string };
type Manifest = { assets: { key: string; variant: string; path: string; resources?: Resource[] }[] };

/** The cost of the built bundle at `bundleDir`, from its manifest, glTF files and KTX2 headers. */
export async function kitCost(bundleDir: string): Promise<KitCost> {
  const manifest = JSON.parse(await readFile(path.join(bundleDir, "manifest.json"), "utf8")) as Manifest;
  const entries: KitEntryCost[] = [];
  const materials = new Set<string>();
  const files = new Set<string>();
  const textures = new Map<string, string>();
  for (const asset of manifest.assets) {
    const gltf = JSON.parse(await readFile(path.join(bundleDir, asset.path), "utf8")) as Gltf;
    files.add(asset.path);
    for (const resource of asset.resources ?? []) {
      files.add(resource.path);
      if (resource.mediaType?.startsWith("image/")) textures.set(resource.path, resource.mediaType);
    }
    gltf.materials?.forEach((material, index) => materials.add(material.name ?? `${asset.key}#${index}`));
    let drawCalls = 0, triangles = 0;
    for (const node of gltf.nodes ?? []) {
      for (const primitive of node.mesh === undefined ? [] : gltf.meshes?.[node.mesh]?.primitives ?? []) {
        drawCalls += 1;
        const accessor = primitive.indices ?? primitive.attributes.POSITION;
        if ((primitive.mode ?? 4) === 4 && accessor !== undefined) triangles += gltf.accessors![accessor]!.count / 3;
      }
    }
    entries.push({ key: asset.key, variant: asset.variant, materials: gltf.materials?.length ?? 0, drawCalls, triangles });
  }
  let textureMemoryBytes = 0;
  for (const [file, mediaType] of textures) {
    // As pack-downloads.ts estimates it: Basis transcodes to a 1-byte-per-texel block format, and mips add a third.
    // A PNG or JPEG uploads uncompressed, at 4 bytes per texel.
    const bytes = new Uint8Array(await readFile(path.join(bundleDir, file)));
    const [width, height] = mediaType === "image/ktx2" ? Object.values(ktx2Size(bytes)) as [number, number] : ImageUtils.getSize(bytes, mediaType)!;
    textureMemoryBytes += Math.round((width * height * (mediaType === "image/ktx2" ? 4 : 16)) / 3);
  }
  let downloadBytes = 0;
  for (const file of files) downloadBytes += (await stat(path.join(bundleDir, file))).size;
  return {
    schema: KIT_COST_SCHEMA, entries, materials: [...materials].sort(), textures: textures.size, textureMemoryBytes, downloadBytes,
    maxima: { drawCalls: Math.max(0, ...entries.map((entry) => entry.drawCalls)), triangles: Math.max(0, ...entries.map((entry) => entry.triangles)) },
  };
}

/** Every way `cost` exceeds `budget`, empty when it fits. */
export function kitBudgetViolations(cost: KitCost, budget: KitBudget): string[] {
  const over: string[] = [];
  if (cost.materials.length > budget.materials) over.push(`${cost.materials.length} materials (${cost.materials.join(", ")}), limit ${budget.materials}`);
  if (cost.textureMemoryBytes > budget.textureMemoryBytes) over.push(`${(cost.textureMemoryBytes / MB).toFixed(1)} MB of GPU textures, limit ${(budget.textureMemoryBytes / MB).toFixed(1)} MB`);
  if (cost.downloadBytes > budget.downloadBytes) over.push(`${(cost.downloadBytes / MB).toFixed(1)} MB download, limit ${(budget.downloadBytes / MB).toFixed(1)} MB`);
  return over;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const bundle = option("--bundle");
  if (!bundle) {
    console.error("Usage: bun scripts/report-kit-costs.ts --bundle <dir> [--budget <release>]");
    process.exit(2);
  }
  const cost = await kitCost(path.resolve(bundle));
  const release = option("--budget");
  const budget = release ? KIT_BUDGETS[release] : undefined;
  if (release && !budget) {
    console.error(`no budget for '${release}'`);
    process.exit(2);
  }
  const violations = budget ? kitBudgetViolations(cost, budget) : [];
  console.log(JSON.stringify({ ...cost, entries: cost.entries.length, ...(release ? { budget: release, violations } : {}) }, null, 2));
  if (violations.length > 0) process.exit(1);
}
