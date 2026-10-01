import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { parseAssetSpec } from "./schema.js";

/** Acquisition is explicit; recipes consume this exact local archive without installing it. */
export const SAPLING_TREE_SOURCE = Object.freeze({
  id: "blender.sapling-tree-gen", version: "0.3.7", license: "GPL-3.0-or-later", byteLength: 36296,
  sha256: "27a478262e1c86612a9c3daffe7f4dce2802f5bc2294033462e5adc6d9c0080f",
  provider: "https://extensions.blender.org/add-ons/sapling-tree-gen/",
  download: "https://extensions.blender.org/download/sha256:27a478262e1c86612a9c3daffe7f4dce2802f5bc2294033462e5adc6d9c0080f/add-on-sapling-tree-gen-v0.3.7.zip?repository=%2Fapi%2Fv1%2Fextensions%2F&blender_version_min=4.4.0",
});
export type TreeParameters = {
  schemaVersion: 1; seed: string; family: "broadleaf" | "conifer"; height: number;
  levels: 2 | 3; primaryBranches: number; secondaryBranches: number; branchAngle: number;
  trunkRatio: number; trunkTaper: number; canopyShape: "rounded" | "conical";
  foliageDensity: number; leafScale: number; curveSegments: number; maxTriangles: number;
  component: "composed" | "trunk" | "branches" | "foliage";
};
const KEYS = ["schemaVersion", "seed", "family", "height", "levels", "primaryBranches", "secondaryBranches", "branchAngle",
  "trunkRatio", "trunkTaper", "canopyShape", "foliageDensity", "leafScale", "curveSegments", "maxTriangles", "component"];
function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "finite"} in ${min}..${max}`);
  }
  return value;
}
export function normalizeTreeParameters(value: unknown): TreeParameters {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("tree parameters must be a plain object");
  // The plain-object boundary permits inspection without trusting the incoming value's shape.
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(p, key))) throw new Error("tree parameters require exactly the declared controls");
  if (p.schemaVersion !== 1) throw new Error("tree schemaVersion must be 1");
  if (typeof p.seed !== "string" || p.seed.length > 10 || !/^(0|[1-9][0-9]*)$/.test(p.seed) || BigInt(p.seed) > 2147483647n) throw new Error("tree seed must be a canonical decimal integer in 0..2147483647");
  if (p.family !== "broadleaf" && p.family !== "conifer") throw new Error("unknown tree family");
  if (p.canopyShape !== "rounded" && p.canopyShape !== "conical") throw new Error("unknown tree canopy shape");
  if (p.component !== "composed" && p.component !== "trunk" && p.component !== "branches" && p.component !== "foliage") throw new Error("unknown tree component");
  if (p.levels !== 2 && p.levels !== 3) throw new Error("tree levels must be 2 or 3");
  const secondaryBranches = number(p.secondaryBranches, "secondaryBranches", 0, 8, true);
  if ((p.levels === 2 && secondaryBranches !== 0) || (p.levels === 3 && secondaryBranches === 0)) throw new Error("secondary branches must match the declared levels");
  return { schemaVersion: 1, seed: p.seed, family: p.family, canopyShape: p.canopyShape, component: p.component, levels: p.levels,
    height: number(p.height, "height", 0.1, 100), primaryBranches: number(p.primaryBranches, "primaryBranches", 1, 32, true), secondaryBranches,
    branchAngle: number(p.branchAngle, "branchAngle", 10, 120), trunkRatio: number(p.trunkRatio, "trunkRatio", 0.005, 0.08),
    trunkTaper: number(p.trunkTaper, "trunkTaper", 0.1, 1), foliageDensity: number(p.foliageDensity, "foliageDensity", 1, 512, true),
    leafScale: number(p.leafScale, "leafScale", 0.005, 1), curveSegments: number(p.curveSegments, "curveSegments", 2, 6, true),
    maxTriangles: number(p.maxTriangles, "maxTriangles", 128, 200000, true) };
}
export async function readTreeRecipeSource() { return readBlenderRecipeSource("tree.py"); }
export function createTreeAssetSpec({ assetId, parameters, scriptSha256, blenderVersion, scriptPath = "tree.py", saplingPath = "sapling.zip", outputPath = "tree.glb" }: {
  assetId: string; parameters: unknown; scriptSha256: string; blenderVersion: string; scriptPath?: string; saplingPath?: string; outputPath?: string;
}) {
  if (!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("tree Blender version must be exact");
  if (!scriptPath.endsWith(".py") || !saplingPath.endsWith(".zip") || !outputPath.endsWith(".glb")) throw new Error("tree spec requires Python, ZIP and GLB paths");
  return parseAssetSpec({ schemaVersion: 1, assetId, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: scriptPath, sha256: scriptSha256 }, sapling: { path: saplingPath, sha256: SAPLING_TREE_SOURCE.sha256 } }, models: {},
    parameters: { blenderVersion, arguments: normalizeTreeParameters(parameters) }, output: { path: outputPath }, reproducibility: { expected: "approximate" } });
}
const defaults: TreeParameters = { schemaVersion: 1, seed: "133", family: "broadleaf", height: 6, levels: 3,
  primaryBranches: 28, secondaryBranches: 8, branchAngle: 48, trunkRatio: 0.02, trunkTaper: 1,
  canopyShape: "rounded", foliageDensity: 128, leafScale: 0.35, curveSegments: 5, maxTriangles: 60000, component: "composed" };
export const TREE_PRESETS = Object.freeze({ broadleaf: Object.freeze({ ...defaults }),
  conifer: Object.freeze({ ...defaults, family: "conifer" as const, canopyShape: "conical" as const, branchAngle: 110, foliageDensity: 512, leafScale: 0.22 }),
  shrub: Object.freeze({...defaults,height:1.1,primaryBranches:20,secondaryBranches:4,branchAngle:70,
    trunkRatio:0.025,foliageDensity:320,leafScale:0.16,curveSegments:4,maxTriangles:30000}) });
