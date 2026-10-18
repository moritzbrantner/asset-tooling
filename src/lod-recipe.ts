import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { canonicalJson } from "./canonical.js";
import { sha256Bytes } from "./hash.js";
import { generateAsset } from "./core.js";
import type { AssetRef } from "./operations.js";
import { parseAssetSpec } from "./schema.js";

/**
 * Source-derived levels of detail (#123, owner answer A): LOD0 is the source; `lod1` keeps about half the triangles
 * and `lod2` about a fifth (a quarter for characters, so faces and hands stay readable). Each level is Blender's
 * edge-collapse Decimate (adapters/blender/lod.py) and ships as a `lod1`/`lod2` variant of the same bundle entry.
 * The switch distances are hints for consumers, which choose their own selection.
 */
export type LodLevel = "lod1" | "lod2";
export const LOD_RATIOS = Object.freeze({
  static: Object.freeze({ lod1: 0.5, lod2: 0.2 }),
  character: Object.freeze({ lod1: 0.5, lod2: 0.25 }),
}) satisfies Record<"static" | "character", Record<LodLevel, number>>;
export const LOD_LEVELS: readonly LodLevel[] = ["lod1", "lod2"];
/** Suggested camera distances in metres at which a consumer may switch to each level. */
export const LOD_SWITCH_DISTANCE_HINTS = Object.freeze({ lod1: 15, lod2: 35 }) satisfies Record<LodLevel, number>;

export function createLodAssetSpec({ assetId, ratio, scriptSha256, sourceSha256, blenderVersion }: {
  assetId: string; ratio: number; scriptSha256: string; sourceSha256: string; blenderVersion: string;
}) {
  if (!(ratio >= 0.05 && ratio < 1)) throw new Error("lod ratio must be in 0.05..1");
  return parseAssetSpec({
    schemaVersion: 1, assetId, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "lod.py", sha256: scriptSha256 }, source: { path: "source.glb", sha256: sourceSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, ratio } }, output: { path: "lod.glb" }, reproducibility: { expected: "exact" },
  });
}

/** Decimate one GLB through the pinned Blender backend; returns the stored GLB and the recipe observations. */
export async function generateLodLevel(root: string, source: AssetRef, ratio: number, label: string) {
  const script = await readBlenderRecipeSource("lod.py");
  const workspace = path.join(root, "lod", label);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "lod.py"), script.bytes);
  const bytes = await resolveAssetObject(root, source);
  await writeFile(path.join(workspace, "source.glb"), bytes);
  const spec = createLodAssetSpec({ assetId: `lod.${label}`, ratio, scriptSha256: script.sha256, sourceSha256: sha256Bytes(bytes), blenderVersion: script.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "lod.glb")), kind: "mesh", mediaType: "model/gltf-binary",
    metadata: { lod: label, ratio, source: source.sha256 } })).asset;
  return { glb, observations: (generated.receipt.observations as Record<string, any>).script as Record<string, any> };
}
