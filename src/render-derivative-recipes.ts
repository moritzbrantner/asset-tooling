import { createAssetRef, type AssetRef } from "./operations.js";
import { parseAssetSpec } from "./schema.js";
import { GLTF_IMPORT_OPERATION } from "./gltf-import-operations.js";
import { gltfSummary, loadCheckedGltf } from "./gltf-processing.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";

type Vector3 = [number, number, number];
type Projection = { type: "orthographic" } | { type: "perspective"; horizontalFovDegrees: number };
type Selection = { type: "scene" } | { type: "nodes"; names: string[] };
export type RenderDerivativeParameters = {
  schemaVersion: 1; width: number; height: number; projection: Projection; selection: Selection;
  viewDirection: Vector3; padding: number; lightDirection: Vector3; lightEnergy: number; lightSize: number;
  worldColor: Vector3; worldStrength: number; background: "transparent" | "opaque";
  exposure: number; samples: number; seed: number;
};
const KEYS = ["schemaVersion", "width", "height", "projection", "selection", "viewDirection", "padding", "lightDirection", "lightEnergy", "lightSize", "worldColor", "worldStrength", "background", "exposure", "samples", "seed"];
function object(value: unknown, keys: string[], location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${location} must be a plain object`);
  const p = value as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!keys.includes(key)) throw new Error(`${location} contains unknown field '${key}'`);
  for (const key of keys) if (!Object.hasOwn(p, key)) throw new Error(`${location} is missing '${key}'`);
  return p;
}
function bounded(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be finite in ${min}..${max}`);
  return value;
}
function integer(value: unknown, key: string, min: number, max: number): number {
  const result = bounded(value, key, min, max);
  if (!Number.isInteger(result)) throw new Error(`${key} must be an integer`);
  return result;
}
function vector(value: unknown, key: string, min: number, max: number): Vector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${key} must contain three coordinates`);
  return [bounded(value[0], key, min, max), bounded(value[1], key, min, max), bounded(value[2], key, min, max)];
}
function direction(value: unknown, key: string): Vector3 {
  const result = vector(value, key, -1000, 1000);
  if (Math.hypot(...result) < 0.000001) throw new Error(`${key} must be nonzero`);
  return result;
}
export function normalizeRenderDerivativeParameters(value: unknown): RenderDerivativeParameters {
  const p = object(value, KEYS, "render derivative parameters");
  if (p.schemaVersion !== 1) throw new Error("render derivative schemaVersion must be 1");
  const rawProjection = object(p.projection,
    p.projection && typeof p.projection === "object" && "type" in p.projection && p.projection.type === "perspective"
      ? ["type", "horizontalFovDegrees"] : ["type"], "projection");
  let projection: Projection;
  switch (rawProjection.type) {
    case "orthographic": projection = { type: "orthographic" }; break;
    case "perspective": projection = { type: "perspective", horizontalFovDegrees: bounded(rawProjection.horizontalFovDegrees, "horizontalFovDegrees", 10, 100) }; break;
    default: throw new Error("unsupported camera projection");
  }
  const rawSelection = object(p.selection,
    p.selection && typeof p.selection === "object" && "type" in p.selection && p.selection.type === "nodes"
      ? ["type", "names"] : ["type"], "selection");
  let selection: Selection;
  switch (rawSelection.type) {
    case "scene": selection = { type: "scene" }; break;
    case "nodes": {
      if (!Array.isArray(rawSelection.names) || rawSelection.names.length < 1 || rawSelection.names.length > 64 ||
          rawSelection.names.some(n => typeof n !== "string" || n.length === 0 || n.length > 256) || new Set(rawSelection.names).size !== rawSelection.names.length) throw new Error("selection.names must contain 1..64 unique nonempty node names");
      // Every element was checked above. Sorting preserves selection identity under caller reordering.
      selection = { type: "nodes", names: (rawSelection.names as string[]).slice().sort() }; break;
    }
    default: throw new Error("unsupported render selection");
  }
  const viewDirection = direction(p.viewDirection, "viewDirection");
  if (Math.abs(viewDirection[1]) / Math.hypot(...viewDirection) > 0.999) throw new Error("viewDirection must not be parallel to glTF Y-up");
  if (p.background !== "transparent" && p.background !== "opaque") throw new Error("background must be transparent or opaque");
  return { schemaVersion: 1, width: integer(p.width, "width", 1, 1024), height: integer(p.height, "height", 1, 1024),
    projection, selection, viewDirection, padding: bounded(p.padding, "padding", 0, 0.4),
    lightDirection: direction(p.lightDirection, "lightDirection"), lightEnergy: bounded(p.lightEnergy, "lightEnergy", 1, 10000), lightSize: bounded(p.lightSize, "lightSize", 0.01, 10),
    worldColor: vector(p.worldColor, "worldColor", 0, 1), worldStrength: bounded(p.worldStrength, "worldStrength", 0, 2), background: p.background,
    exposure: bounded(p.exposure, "exposure", -4, 4), samples: integer(p.samples, "samples", 1, 64), seed: integer(p.seed, "seed", 0, 2147483647) };
}

export const readRenderDerivativeRecipeSource = () => readBlenderRecipeSource("render_static_glb.py");

/** Validate an existing source through the supported static importer, then declare a pinned render. */
export async function prepareRenderDerivativeRecipe(root: string, { assetId, source: value, parameters, scriptSha256, blenderVersion,
  scriptPath = "render_static_glb.py", sourcePath = "source.glb", outputPath = "render.png" }: {
  assetId: string; source: AssetRef; parameters: unknown; scriptSha256: string; blenderVersion: string;
  scriptPath?: string; sourcePath?: string; outputPath?: string;
}) {
  const p = normalizeRenderDerivativeParameters(parameters), source = createAssetRef(value);
  if (source.byteLength > 64 * 1024 * 1024) throw new Error("render source exceeds 64 MiB budget");
  if (source.mediaType !== "model/gltf-binary") throw new Error("render derivative source must be a self-contained GLB");
  if (!/^\d+\.\d+\.\d+$/.test(blenderVersion)) throw new Error("render Blender version must be exact");
  if (!scriptPath.endsWith(".py") || !sourcePath.endsWith(".glb") || !outputPath.endsWith(".png")) throw new Error("render recipe requires Python, GLB and PNG paths");
  const checked = await loadCheckedGltf(root, GLTF_IMPORT_OPERATION, { resourceUris: [] }, { source }, false);
  const summary = gltfSummary(checked.document);
  if (summary.triangleCount > 1000000 || summary.nodeCount > 4096) throw new Error("render source exceeds geometry/node budget");
  if (checked.document.getRoot().listScenes().length !== 1) throw new Error("render derivative requires exactly one source scene");
  if (p.selection.type === "nodes") for (const name of p.selection.names) {
    const nodes = checked.document.getRoot().listNodes().filter(node => node.getName() === name);
    if (nodes.length !== 1 || !nodes[0]!.getMesh()) throw new Error(`selected node '${name}' must uniquely identify a mesh node`);
  }
  const selectedNames = p.selection.type === "nodes" ? new Set(p.selection.names) : undefined;
  const instanceTriangles = checked.document.getRoot().listNodes().reduce((sum, node) => {
    if (selectedNames && !selectedNames.has(node.getName())) return sum;
    return sum + (node.getMesh()?.listPrimitives() ?? []).reduce((count, primitive) =>
      count + (primitive.getIndices() ?? primitive.getAttribute("POSITION"))!.getCount() / 3, 0);
  }, 0);
  if (instanceTriangles > 1000000) throw new Error("render selection exceeds one million instantiated triangles");
  const spec = parseAssetSpec({ schemaVersion: 1, assetId, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: scriptPath, sha256: scriptSha256 }, source: { path: sourcePath, sha256: source.sha256 } }, models: {},
    parameters: { blenderVersion, arguments: p }, output: { path: outputPath }, reproducibility: { expected: "approximate" } });
  return { spec, source, sourceBytes: checked.sourceBytes, sourceSummary: gltfSummary(checked.document), resources: checked.inventory };
}

const defaults = { schemaVersion: 1, width: 256, height: 256, projection: { type: "orthographic" }, selection: { type: "scene" },
  viewDirection: [3, 2, 4], padding: 0.12, lightDirection: [-3, 5, 4], lightEnergy: 150, lightSize: 2,
  worldColor: [0.15, 0.15, 0.15], worldStrength: 0.5, background: "transparent", exposure: 0, samples: 32, seed: 0 } satisfies RenderDerivativeParameters;
const freeze = (p: RenderDerivativeParameters) => Object.freeze({ ...p, projection: Object.freeze(p.projection), selection: Object.freeze(p.selection),
  viewDirection: Object.freeze(p.viewDirection), lightDirection: Object.freeze(p.lightDirection), worldColor: Object.freeze(p.worldColor) });
export const RENDER_DERIVATIVE_PRESETS = Object.freeze({
  icon: freeze(defaults),
  thumbnail: freeze({ ...defaults, width: 512, height: 384, background: "opaque" }),
  perspective: freeze({ ...defaults, projection: { type: "perspective", horizontalFovDegrees: 40 } }),
});
