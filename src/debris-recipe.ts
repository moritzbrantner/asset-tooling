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
 * Pre-fractured debris for breakable props (#319 for mmorpg#288): adapters/blender/debris.py cuts the placed prop with
 * fixed planes into a few chunks that keep its materials and textures. The chunks ship as the `debris` variant of the
 * same bundle entry. A plane's point is in fractions of the prop's bounds, and its normal is in the placed glTF frame.
 * The #318 building pieces use the same recipe for the debris of their destruction (src/damage-recipe.ts).
 */
export type DebrisPlane = { point: [number, number, number]; normal: [number, number, number] };
export const DEBRIS_VARIANT = "debris";
/** Chunks whose box is smaller than this share of the prop's bounds volume are dropped. */
export const DEBRIS_MINIMUM_SHARE = 0.01;
export const DEBRIS_PLANES = Object.freeze({
  // Three tilted planes through the middle: eight irregular corner chunks of the crate.
  crate: [
    { point: [0.55, 0.5, 0.5], normal: [1, 0.15, 0.1] },
    { point: [0.5, 0.45, 0.5], normal: [0.1, 1, -0.2] },
    { point: [0.5, 0.5, 0.4], normal: [-0.15, 0.1, 1] },
  ],
  // Three nearly vertical planes through the barrel's axis: six wedges of staves and hoops.
  barrel: [
    { point: [0.5, 0.5, 0.5], normal: [0.966, 0.05, 0.259] },
    { point: [0.5, 0.5, 0.5], normal: [-0.259, -0.05, 0.966] },
    { point: [0.5, 0.5, 0.5], normal: [0.707, 0.03, -0.707] },
  ],
  // Three slanted cuts along the fence: both posts with their rail stubs and the loose rail pieces between them.
  fence: [
    { point: [0.28, 0.5, 0.5], normal: [1, 0.25, 0] },
    { point: [0.55, 0.5, 0.5], normal: [1, -0.3, 0] },
    { point: [0.8, 0.5, 0.5], normal: [1, 0.2, 0] },
  ],
  // #318 building pieces: what falls when a piece is destroyed. Walls break into panels and beam pieces.
  wall: [
    { point: [0.3, 0.5, 0.5], normal: [1, 0.2, 0] },
    { point: [0.7, 0.5, 0.5], normal: [1, -0.25, 0] },
    { point: [0.5, 0.45, 0.5], normal: [0.15, 1, 0] },
  ],
  "wall-plain": [
    { point: [0.35, 0.5, 0.5], normal: [1, 0.3, 0] },
    { point: [0.68, 0.5, 0.5], normal: [1, -0.2, 0] },
    { point: [0.5, 0.55, 0.5], normal: [-0.2, 1, 0] },
  ],
  // The corner post snaps into three lengths.
  corner: [
    { point: [0.5, 0.35, 0.5], normal: [0.4, 1, 0.2] },
    { point: [0.5, 0.7, 0.5], normal: [-0.3, 1, 0.3] },
  ],
  roof: [
    { point: [0.5, 0.5, 0.5], normal: [1, 0.1, 0.05] },
    { point: [0.5, 0.5, 0.35], normal: [0.1, 0.05, 1] },
    { point: [0.5, 0.5, 0.7], normal: [-0.1, 0.05, 1] },
  ],
  floor: [
    { point: [0.35, 0.5, 0.5], normal: [1, 0, 0.2] },
    { point: [0.7, 0.5, 0.5], normal: [1, 0, -0.3] },
    { point: [0.5, 0.5, 0.5], normal: [0.15, 0, 1] },
  ],
} satisfies Record<string, DebrisPlane[]>);

/** Split one placed GLB into debris chunks through the pinned Blender backend; returns the GLB and the chunk observations. */
export async function generateDebris(root: string, source: AssetRef, name: string, planes: readonly DebrisPlane[]) {
  const script = await readBlenderRecipeSource("debris.py");
  const workspace = path.join(root, "debris", name);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "debris.py"), script.bytes);
  const bytes = await resolveAssetObject(root, source);
  await writeFile(path.join(workspace, "source.glb"), bytes);
  const spec = parseAssetSpec({
    schemaVersion: 1, assetId: `debris.${name}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "debris.py", sha256: script.sha256 }, source: { path: "source.glb", sha256: sha256Bytes(bytes) } }, models: {},
    parameters: { blenderVersion: script.blenderVersion, arguments: { schemaVersion: 1, name, planes, minimumShare: DEBRIS_MINIMUM_SHARE } },
    output: { path: "debris.glb" }, reproducibility: { expected: "exact" },
  });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "debris.glb")), kind: "mesh", mediaType: "model/gltf-binary",
    metadata: { debris: name, source: source.sha256 } })).asset;
  return { glb, observations: (generated.receipt.observations as Record<string, any>).script as Record<string, any> };
}
