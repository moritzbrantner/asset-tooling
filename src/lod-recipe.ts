import path from "node:path";
import { resolveAssetObject } from "./asset-store.js";
import { blenderScriptSpec, runBlenderRecipe } from "./blender-recipe-run.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { sha256Bytes } from "./hash.js";
import type { AssetRef } from "./operations.js";

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
  return blenderScriptSpec({
    assetId, inputs: { script: { path: "lod.py", sha256: scriptSha256 }, source: { path: "source.glb", sha256: sourceSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, ratio }, output: "lod.glb",
  });
}

/** Decimate one GLB through the pinned Blender backend; returns the stored GLB and the recipe observations. */
export async function generateLodLevel(root: string, source: AssetRef, ratio: number, label: string) {
  const script = await readBlenderRecipeSource("lod.py");
  const bytes = await resolveAssetObject(root, source);
  return runBlenderRecipe(root, {
    workspace: path.join(root, "lod", label), files: { "lod.py": script.bytes, "source.glb": bytes },
    spec: createLodAssetSpec({ assetId: `lod.${label}`, ratio, scriptSha256: script.sha256, sourceSha256: sha256Bytes(bytes), blenderVersion: script.blenderVersion }),
    metadata: { lod: label, ratio, source: source.sha256 },
  });
}
