import {compareCodeUnitStrings} from "./canonical.js";
import { NodeIO, type Document } from "@gltf-transform/core";
import { resolveAssetObject } from "./asset-store.js";
import { createAssetOperationDescriptor, createAssetRef, type AssetRef } from "./operations.js";
import { blenderScriptSpec } from "./blender-script-spec.js";
import { GLTF_IMPORT_OPERATION } from "./gltf-import-operations.js";
import { GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS } from "./gltf-production-operations.js";
import { gltfSummary, loadCheckedGltf, checkStaticGltfAccessorBudget } from "./gltf-processing.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";

type Vector3 = [number, number, number];
type Projection = { type: "orthographic" } | { type: "perspective"; horizontalFovDegrees: number };
type Selection = { type: "scene" } | { type: "nodes"; names: string[] };
export type SharedOrthographicFraming = {
  type: "shared-orthographic"; center: Vector3; horizontalSpan: number; pivot: Vector3;
  /** Absent or "reject": a source outside the padded frame fails. "crop": a deliberate crop such as a portrait. */
  overflow?: "reject" | "crop";
};
/** One instant of one named source clip, evaluated by Blender. Absent means a static source. */
export type RenderPose = { clip: string; timeSeconds: number };
export type RenderDerivativeParameters = {
  schemaVersion: 1; width: number; height: number; projection: Projection; selection: Selection;
  viewDirection: Vector3; padding: number; lightDirection: Vector3; lightEnergy: number; lightSize: number;
  worldColor: Vector3; worldStrength: number; background: "transparent" | "opaque";
  exposure: number; samples: number; seed: number;
  framing?: SharedOrthographicFraming;
  pose?: RenderPose;
};
const KEYS = ["schemaVersion", "width", "height", "projection", "selection", "viewDirection", "padding", "lightDirection", "lightEnergy", "lightSize", "worldColor", "worldStrength", "background", "exposure", "samples", "seed"];
function object(value: unknown, keys: string[], location: string, optionalKeys: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {throw new Error(`${location} must be a plain object`);}
  const p = value as Record<string, unknown>;
  for (const key of Object.keys(p)) {if (!keys.includes(key) && !optionalKeys.includes(key)) {throw new Error(`${location} contains unknown field '${key}'`);}}
  for (const key of keys) {if (!Object.hasOwn(p, key)) {throw new Error(`${location} is missing '${key}'`);}}
  return p;
}
function bounded(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {throw new Error(`${key} must be finite in ${min}..${max}`);}
  return value;
}
function integer(value: unknown, key: string, min: number, max: number): number {
  const result = bounded(value, key, min, max);
  if (!Number.isInteger(result)) {throw new Error(`${key} must be an integer`);}
  return result;
}
function vector(value: unknown, key: string, min: number, max: number): Vector3 {
  if (!Array.isArray(value) || value.length !== 3) {throw new Error(`${key} must contain three coordinates`);}
  return [bounded(value[0], key, min, max), bounded(value[1], key, min, max), bounded(value[2], key, min, max)];
}
function direction(value: unknown, key: string): Vector3 {
  const result = vector(value, key, -1000, 1000);
  if (Math.hypot(...result) < 0.000001) {throw new Error(`${key} must be nonzero`);}
  return result;
}
function cameraDirection(value: unknown, key: string): Vector3 {
  const result = direction(value, key);
  if (Math.abs(result[1]) / Math.hypot(...result) > 0.999) {throw new Error(`${key} must not be parallel to glTF Y-up`);}
  return result;
}
export function normalizeRenderDerivativeParameters(value: unknown): RenderDerivativeParameters {
  const p = object(value, KEYS, "render derivative parameters", ["framing", "pose"]);
  if (p.schemaVersion !== 1) {throw new Error("render derivative schemaVersion must be 1");}
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
          rawSelection.names.some(n => typeof n !== "string" || n.length === 0 || n.length > 256) || new Set(rawSelection.names).size !== rawSelection.names.length) {throw new Error("selection.names must contain 1..64 unique nonempty node names");}
      // Every element was checked above. Sorting preserves selection identity under caller reordering.
      selection = { type: "nodes", names: (rawSelection.names as string[]).slice().sort() }; break;
    }
    default: throw new Error("unsupported render selection");
  }
  const viewDirection = cameraDirection(p.viewDirection, "viewDirection");
  if (p.background !== "transparent" && p.background !== "opaque") {throw new Error("background must be transparent or opaque");}
  const result: RenderDerivativeParameters = { schemaVersion: 1, width: integer(p.width, "width", 1, 1024), height: integer(p.height, "height", 1, 1024),
    projection, selection, viewDirection, padding: bounded(p.padding, "padding", 0, 0.4),
    lightDirection: direction(p.lightDirection, "lightDirection"), lightEnergy: bounded(p.lightEnergy, "lightEnergy", 1, 10000), lightSize: bounded(p.lightSize, "lightSize", 0.01, 10),
    worldColor: vector(p.worldColor, "worldColor", 0, 1), worldStrength: bounded(p.worldStrength, "worldStrength", 0, 2), background: p.background,
    exposure: bounded(p.exposure, "exposure", -4, 4), samples: integer(p.samples, "samples", 1, 64), seed: integer(p.seed, "seed", 0, 2147483647) };
  if (Object.hasOwn(p, "framing")) {
    const framing = object(p.framing, ["type", "center", "horizontalSpan", "pivot"], "framing", ["overflow"]);
    if (framing.type !== "shared-orthographic" || projection.type !== "orthographic") {throw new Error("shared framing requires orthographic projection");}
    result.framing = { type: "shared-orthographic", center: vector(framing.center, "framing.center", -100000, 100000),
      horizontalSpan: bounded(framing.horizontalSpan, "framing.horizontalSpan", 0.000001, 100000), pivot: vector(framing.pivot, "framing.pivot", -100000, 100000) };
    if (Object.hasOwn(framing, "overflow")) {
      if (framing.overflow !== "reject" && framing.overflow !== "crop") {throw new Error("framing.overflow must be reject or crop");}
      result.framing.overflow = framing.overflow;
    }
  }
  if (Object.hasOwn(p, "pose")) {result.pose = normalizePose(p.pose);}
  return result;
}
function normalizePose(value: unknown): RenderPose {
  const pose = object(value, ["clip", "timeSeconds"], "pose");
  // Blender truncates data-block names beyond 63 UTF-8 bytes, so longer clip names are not addressable.
  if (typeof pose.clip !== "string" || pose.clip.length < 1 || !pose.clip.isWellFormed() || Buffer.byteLength(pose.clip, "utf8") > 63) {throw new Error("pose.clip must name a source animation in 1..63 UTF-8 bytes");}
  return { clip: pose.clip, timeSeconds: bounded(pose.timeSeconds, "pose.timeSeconds", 0, 3600) };
}

// Posed sources may be catalogued as animation libraries; otherwise this is the ordinary import port.
const POSED_SOURCE_CHECK = createAssetOperationDescriptor({ ...GLTF_IMPORT_OPERATION, id: "render.posed-source.check",
  label: "Check posed render source", description: "Validate a self-contained rigged/animated core glTF render source.",
  inputs: [{ ...GLTF_IMPORT_OPERATION.inputs[0]!, assetKinds: ["scene", "mesh", "animation"] }, GLTF_IMPORT_OPERATION.inputs[1]!] });

export const readRenderDerivativeRecipeSource =() => readBlenderRecipeSource("render_static_glb.py");

type RenderRecipeOptions = {
  assetId: string; source: AssetRef; parameters: unknown; scriptSha256: string; blenderVersion: string;
  scriptPath?: string; sourcePath?: string; outputPath?: string;
};
function renderSpec({assetId, scriptSha256, blenderVersion, scriptPath = "render_static_glb.py", sourcePath = "source.glb", outputPath = "render.png"}: RenderRecipeOptions,
  p: RenderDerivativeParameters, source: AssetRef) {
  return blenderScriptSpec({ assetId, inputs: { script: { path: scriptPath, sha256: scriptSha256 }, source: { path: sourcePath, sha256: source.sha256 } },
    blenderVersion, arguments: p, output: outputPath, reproducibility: "approximate" });
}
/** Validate an existing source through the supported static importer, then declare a pinned render. */
export async function prepareRenderDerivativeRecipe(root: string, options: RenderRecipeOptions) {
  return prepareValidatedRenderRecipe(root, options, normalizeRenderDerivativeParameters(options.parameters));
}
async function prepareValidatedRenderRecipe(root: string, options: RenderRecipeOptions, p: RenderDerivativeParameters) {
  const {blenderVersion, scriptPath = "render_static_glb.py", sourcePath = "source.glb", outputPath = "render.png"} = options;
  const source = createAssetRef(options.source);
  if (source.byteLength > 64 * 1024 * 1024) {throw new Error("render source exceeds 64 MiB budget");}
  if (source.mediaType !== "model/gltf-binary") {throw new Error("render derivative source must be a self-contained GLB");}
  if (!/^\d+\.\d+\.\d+$/.test(blenderVersion)) {throw new Error("render Blender version must be exact");}
  if (!scriptPath.endsWith(".py") || !sourcePath.endsWith(".glb") || !outputPath.endsWith(".png")) {throw new Error("render recipe requires Python, GLB and PNG paths");}
  const { json } = await new NodeIO().setAllowNetwork(false).setStrictResources(true).binaryToJSON(await resolveAssetObject(root, source));
  checkStaticGltfAccessorBudget(json, "render");
  // A declared pose admits the existing rigged/animated core policy; static renders keep the static policy.
  const checked = p.pose
    ? await loadCheckedGltf(root, POSED_SOURCE_CHECK, { resourceUris: [] }, { source }, true, GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS)
    : await loadCheckedGltf(root, GLTF_IMPORT_OPERATION, { resourceUris: [] }, { source }, false);
  const clip = p.pose ? checkPoseClip(checked.document, p.pose) : undefined;
  // Blender imports every embedded texture, including those on unselected nodes.
  // Inspect headers before its importer allocates decoded image storage.
  let texturePixels = 0;
  for (const texture of checked.document.getRoot().listTextures()) {
    const size = texture.getSize();
    if (!size || size.some(dimension => !Number.isSafeInteger(dimension) || dimension < 1 || dimension > 4096)) {
      throw new Error("render texture exceeds dimension budget (1–4096 per axis)");
    }
    texturePixels += size[0] * size[1];
    if (texturePixels > 16777216) {throw new Error("render textures exceed total decoded pixel budget (16777216)");}
  }
  const summary = gltfSummary(checked.document);
  if (summary.triangleCount > 1000000 || summary.nodeCount > 4096) {throw new Error("render source exceeds geometry/node budget");}
  if (checked.document.getRoot().listScenes().length !== 1) {throw new Error("render derivative requires exactly one source scene");}
  if (p.selection.type === "nodes") {for (const name of p.selection.names) {
    const nodes = checked.document.getRoot().listNodes().filter(node => node.getName() === name);
    if (nodes.length !== 1 || !nodes[0]!.getMesh()) {throw new Error(`selected node '${name}' must uniquely identify a mesh node`);}
  }}
  const selectedNames = p.selection.type === "nodes" ? new Set(p.selection.names) : undefined;
  const instanceTriangles = checked.document.getRoot().listNodes().reduce((sum, node) => {
    if (selectedNames && !selectedNames.has(node.getName())) {return sum;}
    return sum + (node.getMesh()?.listPrimitives() ?? []).reduce((count, primitive) =>
      count + (primitive.getIndices() ?? primitive.getAttribute("POSITION"))!.getCount() / 3, 0);
  }, 0);
  if (instanceTriangles > 1000000) {throw new Error("render selection exceeds one million instantiated triangles");}
  return { spec: renderSpec(options, p, source), source, sourceBytes: checked.sourceBytes, sourceSummary: summary, resources: checked.inventory,
    ...(clip ? { clip } : {}) };
}

/** The declared clip must exist once, animate only node TRS, and contain the declared time. */
function checkPoseClip(document: Document, pose: RenderPose) {
  const root = document.getRoot();
  if (root.listMeshes().some(mesh => mesh.listPrimitives().some(primitive => primitive.listTargets().length > 0))) {
    throw new Error("posed renders do not evaluate morph targets");
  }
  const clips = root.listAnimations().filter(animation => animation.getName() === pose.clip);
  if (clips.length !== 1) {throw new Error(`pose.clip '${pose.clip}' must name exactly one source animation`);}
  const channels = clips[0]!.listChannels();
  if (channels.length === 0 || channels.some(channel => !["translation", "rotation", "scale"].includes(channel.getTargetPath() ?? ""))) {
    throw new Error("pose clip may animate only node translation, rotation and scale");
  }
  let durationSeconds = 0;
  for (const sampler of clips[0]!.listSamplers()) {
    const input = sampler.getInput();
    if (input) {for (let i = 0; i < input.getCount(); i++) {durationSeconds = Math.max(durationSeconds, input.getScalar(i));}}
  }
  if (pose.timeSeconds > durationSeconds + 1e-9) {throw new Error(`pose.timeSeconds ${pose.timeSeconds} exceeds clip '${pose.clip}' duration ${durationSeconds}`);}
  return { name: pose.clip, durationSeconds };
}

/** One checked source and one declared world frame; IDs, not caller order, identify directions. */
export async function prepareDirectionalRenderDerivativeRecipes(root: string, options: RenderRecipeOptions & {directions: unknown; sequence?: unknown}) {
  const p = normalizeRenderDerivativeParameters(options.parameters);
  if (!p.framing) {throw new Error("directional sets require shared orthographic framing");}
  if (!Array.isArray(options.directions) || options.directions.length < 1 || options.directions.length > 16) {throw new Error("directions must contain 1..16 declarations");}
  const directions = options.directions.map(raw => {
    const value = object(raw, ["id", "viewDirection"], "direction");
    if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value.id)) {throw new Error("direction.id must be a portable lowercase token");}
    const view = cameraDirection(value.viewDirection, "direction.viewDirection");
    return {id: value.id, viewDirection: view};
  }).sort((a, b) => compareCodeUnitStrings(a.id, b.id));
  if (new Set(directions.map(d => d.id)).size !== directions.length) {throw new Error("direction IDs must be unique");}
  if (options.sequence === undefined) {
    const checked = await prepareValidatedRenderRecipe(root, options, p);
    return directions.map(d => ({...checked, directionId: d.id,
      spec: renderSpec({...options, assetId: `${options.assetId}.${d.id}`}, {...structuredClone(p), viewDirection: d.viewDirection}, checked.source)}));
  }
  if (p.pose) {throw new Error("a sequence declares its own clip times; omit parameters.pose");}
  const raw = object(options.sequence, ["clip"], "sequence", ["frames", "samples"]);
  if (Object.hasOwn(raw, "frames") === Object.hasOwn(raw, "samples")) {throw new Error("sequence declares exactly one of frames or samples");}
  const clipName = normalizePose({clip: raw.clip, timeSeconds: 0}).clip;
  const checked = await prepareValidatedRenderRecipe(root, options, {...p, pose: {clip: clipName, timeSeconds: 0}});
  const duration = checked.clip!.durationSeconds;
  let samples: {id: string; timeSeconds: number}[];
  if (Object.hasOwn(raw, "frames")) {
    // Evenly spaced over [0, duration): a looping clip's end pose repeats its start pose.
    const frames = integer(raw.frames, "sequence.frames", 1, 64);
    samples = Array.from({length: frames}, (_, i) => ({id: `f${String(i).padStart(3, "0")}`, timeSeconds: duration * i / frames}));
  } else {
    if (!Array.isArray(raw.samples) || raw.samples.length < 1 || raw.samples.length > 64) {throw new Error("sequence.samples must contain 1..64 declarations");}
    samples = raw.samples.map(entry => {
      const value = object(entry, ["id", "timeSeconds"], "sequence sample");
      if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value.id)) {throw new Error("sequence sample id must be a portable lowercase token");}
      const timeSeconds = bounded(value.timeSeconds, "sequence sample timeSeconds", 0, duration);
      return {id: value.id, timeSeconds};
    });
    if (new Set(samples.map(s => s.id)).size !== samples.length) {throw new Error("sequence sample IDs must be unique");}
  }
  // Declared times, not IDs or caller order, define playback order.
  samples.sort((a, b) => a.timeSeconds - b.timeSeconds || compareCodeUnitStrings(a.id, b.id));
  if (directions.length * samples.length > 256) {throw new Error("a sequence declares at most 256 renders");}
  return directions.flatMap(d => samples.map((sample, index) => {
    const pose = {clip: clipName, timeSeconds: sample.timeSeconds};
    return {...checked, directionId: d.id, sampleId: sample.id, sampleIndex: index, pose,
      spec: renderSpec({...options, assetId: `${options.assetId}.${d.id}.${sample.id}`}, {...structuredClone(p), viewDirection: d.viewDirection, pose}, checked.source)};
  }));
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
  /** Front (+Z, the glTF forward convention) bust view. Add a source-specific shared frame with overflow "crop". */
  portrait: freeze({ ...defaults, width: 256, height: 320, viewDirection: [0, 0.1, 1], lightDirection: [-2, 3, 4], padding: 0 }),
});
