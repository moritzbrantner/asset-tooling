// Finish one asset from its editable source through the reusable finishing recipe (#120, docs/finishing-recipe.md):
//
//   bun scripts/finish-asset.ts <recipe.finish.json> --out <directory>
//
// The recipe file names the source (a catalog source id, resolved through the canonical storage manifest, or a
// first-party authored .blend under assets/authored/), its glTF resources by URI, the finishing parameters and an
// optional placement. <directory> is the object-store root; the Blender workspace (spec, receipt and generation
// cache) is <directory>/work/<name>, and the finished GLB and its lineage report are promoted to
// <directory>/finished/<name>.glb and <name>.finish.json. Rerunning into the same directory reuses an unchanged
// Blender output. Needs the pinned Blender (ASSET_TOOLING_BLENDER) and the hydrated LFS source; no network or GPU.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readAuthoredBlenderSource } from "../src/blender-recipe-source.js";
import { createAssetCatalog } from "../src/catalog.js";
import { readAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { finishAsset, type FinishingFile } from "../src/finishing-recipe.js";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
type Json = Record<string, any>;
export type FinishingRecipeFile = {
  schema: "finish-recipe-v1";
  name: string;
  assetId: string;
  source: { catalog: string } | { authored: string };
  /** glTF only: every buffer/image URI of the source, mapped to its catalog source id. */
  resources?: Record<string, string>;
  place?: { parentName: string };
  parameters: unknown;
};

async function readJson(relative: string): Promise<Json> {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relative), "utf8"));
}

export function parseFinishingRecipeFile(value: unknown): FinishingRecipeFile {
  const recipe = value as FinishingRecipeFile;
  if (!recipe || typeof recipe !== "object" || recipe.schema !== "finish-recipe-v1") throw new Error("recipe schema must be finish-recipe-v1");
  for (const key of Object.keys(recipe)) {
    if (!["schema", "name", "assetId", "source", "resources", "place", "parameters"].includes(key)) throw new Error(`recipe has unknown key '${key}'`);
  }
  if (typeof recipe.assetId !== "string" || !recipe.assetId) throw new Error("recipe.assetId is required");
  const source = recipe.source as Json;
  if (!source || Object.keys(source).length !== 1 || (typeof source.catalog !== "string" && typeof source.authored !== "string")) {
    throw new Error("recipe.source must be { catalog: <source id> } or { authored: <assets/authored/*.blend> }");
  }
  if (recipe.resources !== undefined && ("authored" in source || typeof recipe.resources !== "object" || Array.isArray(recipe.resources))) {
    throw new Error("recipe.resources maps a catalog glTF's URIs to catalog source ids");
  }
  return recipe;
}

/** Resolve a recipe file's declared sources and run the finishing recipe into `outDir`. */
export async function finishRecipeFile(recipePath: string, outDir: string) {
  const recipe = parseFinishingRecipeFile(JSON.parse(await readFile(recipePath, "utf8")));
  const root = path.resolve(outDir);
  let source: FinishingFile;
  const resources: FinishingFile[] = [];
  let provenance: Json;
  if ("authored" in recipe.source) {
    const authored = await readAuthoredBlenderSource(recipe.source.authored);
    source = { path: `source/${path.posix.basename(recipe.source.authored)}`, bytes: authored.bytes };
    provenance = { authored: recipe.source.authored };
  } else {
    const [providers, sources, storage] = await Promise.all([readJson("catalog/providers.json"), readJson("catalog/sources.json"), readJson("catalog/storage.json")]);
    const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
    const read = async (sourceId: string) => (await readAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: REPOSITORY_ROOT })).bytes as Uint8Array;
    const entry = (storage.entries as Json[]).find((candidate) => candidate.sourceId === recipe.source.catalog);
    const basename = entry ? path.posix.basename(entry.path) : `${recipe.source.catalog}.gltf`;
    source = { path: `source/${basename}`, bytes: await read(recipe.source.catalog) };
    for (const [uri, sourceId] of Object.entries(recipe.resources ?? {}).sort(([a], [b]) => a < b ? -1 : 1)) {
      resources.push({ path: path.posix.normalize(`source/${decodeURIComponent(uri)}`), bytes: await read(sourceId) });
    }
    provenance = { catalog: recipe.source.catalog, resources: recipe.resources ?? {} };
  }
  return finishAsset(root, {
    name: recipe.name, assetId: recipe.assetId, workspace: path.join(root, "work", recipe.name), publish: path.join(root, "finished"),
    parameters: recipe.parameters, source, resources, ...(recipe.place ? { place: recipe.place } : {}), provenance,
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = args.indexOf("--out");
  const recipePath = args.find((arg, index) => !arg.startsWith("--") && index !== out + 1);
  if (!recipePath || out < 0 || !args[out + 1]) {
    console.error("usage: bun scripts/finish-asset.ts <recipe.finish.json> --out <directory>");
    process.exit(2);
  }
  const result = await finishRecipeFile(recipePath, args[out + 1]!);
  const name = (result.report as Json).name;
  console.log(JSON.stringify({ status: result.status, cache: result.cache, glb: path.join(args[out + 1]!, "finished", `${name}.glb`), sha256: result.glb.sha256 }));
}
