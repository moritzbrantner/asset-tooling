// One external.blender.script@1 run (#424): write the recipe's files and spec into a workspace, generate, and
// store the output. Every Blender recipe builder (the kits, the item and LOD recipes) builds its spec with
// blenderScriptSpec and runs it with runBlenderRecipe instead of repeating the spec/generate/store sequence.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { storeAssetObject } from "./asset-store.js";
import { canonicalJson } from "./canonical.js";
import { generateAsset } from "./core.js";
import type { blenderScriptSpec } from "./blender-script-spec.js";
import type { AssetRef } from "./operations.js";

type Json = Record<string, any>;

export { blenderScriptSpec, type BlenderSpecInput } from "./blender-script-spec.js";

/**
 * Run one Blender recipe: write `files` (the recipe and every declared input, by workspace-relative path) and the
 * spec into `workspace`, generate, then store the spec's output GLB in the object store under `root`. Returns the
 * stored GLB and the recipe's observations.
 */
export async function runBlenderRecipe(root: string, { workspace, spec, files, kind = "mesh", metadata }: {
  workspace: string; spec: ReturnType<typeof blenderScriptSpec>; files: Record<string, Uint8Array>; kind?: string; metadata?: Json;
}): Promise<{ glb: AssetRef; observations: Json }> {
  await mkdir(workspace, { recursive: true });
  for (const [file, bytes] of Object.entries(files)) await writeFile(path.join(workspace, file), bytes);
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const bytes = await readFile(path.join(workspace, spec.output.path));
  const glb = (await storeAssetObject(root, { bytes, kind, mediaType: "model/gltf-binary", ...(metadata ? { metadata } : {}) })).asset;
  return { glb, observations: (generated.receipt.observations as Json).script as Json };
}
