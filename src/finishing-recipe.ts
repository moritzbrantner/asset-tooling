// The reusable asset finishing recipe (#120, Atlas Decisions 5.1.6/5.1.7): inspect -> explicit repair -> export.
// adapters/blender/finish.py does the Blender work under external.blender.script@1; this module declares and
// validates its parameters, runs it through the ordinary generation cache, gates the GLB with scene.import.gltf@2
// (and optionally places it with scene.place.gltf@1) and promotes the result only after every step succeeded.
// See docs/finishing-recipe.md.
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { blenderScriptSpec } from "./blender-script-spec.js";
import { canonicalJson } from "./canonical.js";
import { generateAsset } from "./core.js";
import { executeGltfPlaceOperation } from "./gltf-place-operations.js";
import { executeGltfProductionImportOperation } from "./gltf-production-operations.js";
import { sha256Bytes } from "./hash.js";
import type { AssetRef } from "./operations.js";

export const FINISHING_RECIPE = "finish-v1";
/** The closed, ordered-by-caller set of Blender repairs (adapters/blender/finish.py). */
export const FINISHING_REPAIRS = Object.freeze([
  "apply-transforms", "merge-by-distance", "recalculate-normals", "weighted-normals", "uv-unwrap", "bake-ao",
] as const);
export type FinishingRepair = typeof FINISHING_REPAIRS[number];
/** Renderers generate MikkTSpace tangents (owner decision Q1 on #118); the finished GLB does not export them. */
export const FINISHING_ALLOWED_VALIDATOR_WARNINGS = Object.freeze(["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"]);

type Rgba = [number, number, number, number];
export type FinishingMaterialEdit = { baseColor?: Rgba; roughness?: number; metallic?: number };
export type FinishingParameters = {
  schemaVersion: 1;
  source: { format: "gltf" } | { format: "blend"; collection: string };
  edits: { scale: [number, number, number]; materials: Record<string, FinishingMaterialEdit> };
  repairs: FinishingRepair[];
  policy: { maxTriangles: number };
};

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], required: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown key '${key}'`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number in ${min}..${max}`);
  return value;
}

/**
 * Normalise finishing parameters. `edits` (default: unit scale, no material edits) and `repairs` (default: none)
 * may be omitted; everything else is required. The same checks run again in Blender before any scene mutation.
 */
export function normalizeFinishingParameters(value: unknown): FinishingParameters {
  const p = plain(value, "finishing parameters");
  keys(p, ["schemaVersion", "source", "edits", "repairs", "policy"], ["schemaVersion", "source", "policy"], "finishing parameters");
  if (p.schemaVersion !== 1) throw new Error("finishing schemaVersion must be 1");
  const s = plain(p.source, "source");
  keys(s, ["format", "collection"], ["format"], "source");
  let source: FinishingParameters["source"];
  if (s.format === "gltf") {
    if (Object.hasOwn(s, "collection")) throw new Error("source.collection applies only to a blend source");
    source = { format: "gltf" };
  } else if (s.format === "blend") {
    if (typeof s.collection !== "string" || s.collection.length === 0 || s.collection.length > 63) throw new Error("source.collection must name the .blend collection to finish");
    source = { format: "blend", collection: s.collection };
  } else throw new Error("source.format must be 'gltf' or 'blend'");
  const e = plain(p.edits ?? {}, "edits");
  keys(e, ["scale", "materials"], [], "edits");
  const rawScale = e.scale ?? [1, 1, 1];
  if (!Array.isArray(rawScale) || rawScale.length !== 3) throw new Error("edits.scale must be three factors (glTF X, Y up, Z)");
  const scale = rawScale.map((factor, axis) => number(factor, `edits.scale[${axis}]`, .01, 100)) as [number, number, number];
  const materials: Record<string, FinishingMaterialEdit> = {};
  for (const [name, raw] of Object.entries(plain(e.materials ?? {}, "edits.materials")).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (name.length === 0) throw new Error("edits.materials keys must name a material");
    const m = plain(raw, `edits.materials.${name}`);
    keys(m, ["baseColor", "roughness", "metallic"], [], `edits.materials.${name}`);
    const edit: FinishingMaterialEdit = {};
    if (m.baseColor !== undefined) {
      if (!Array.isArray(m.baseColor) || m.baseColor.length !== 4) throw new Error(`edits.materials.${name}.baseColor must be linear RGBA`);
      edit.baseColor = m.baseColor.map((c) => number(c, `edits.materials.${name}.baseColor`, 0, 1)) as Rgba;
    }
    if (m.roughness !== undefined) edit.roughness = number(m.roughness, `edits.materials.${name}.roughness`, 0, 1);
    if (m.metallic !== undefined) edit.metallic = number(m.metallic, `edits.materials.${name}.metallic`, 0, 1);
    if (Object.keys(edit).length === 0) throw new Error(`edits.materials.${name} must change something`);
    materials[name] = edit;
  }
  const repairs = p.repairs ?? [];
  if (!Array.isArray(repairs) || repairs.some((r) => !FINISHING_REPAIRS.includes(r)) || new Set(repairs).size !== repairs.length) {
    throw new Error(`repairs must be unique names from ${FINISHING_REPAIRS.join(", ")}`);
  }
  if (repairs.includes("bake-ao") && repairs.includes("uv-unwrap") && repairs.indexOf("bake-ao") < repairs.indexOf("uv-unwrap")) {
    throw new Error("bake-ao must follow uv-unwrap");
  }
  const policy = plain(p.policy, "policy");
  keys(policy, ["maxTriangles"], ["maxTriangles"], "policy");
  if (typeof policy.maxTriangles !== "number" || !Number.isSafeInteger(policy.maxTriangles) || policy.maxTriangles < 1 || policy.maxTriangles > 1_000_000) {
    throw new Error("policy.maxTriangles must be an integer in 1..1000000");
  }
  return { schemaVersion: 1, source, edits: { scale, materials }, repairs: [...repairs] as FinishingRepair[], policy: { maxTriangles: policy.maxTriangles } };
}

export async function readFinishingRecipeSource() {
  return readBlenderRecipeSource("finish.py");
}

/** A declared file: its portable path in the recipe workspace and its bytes. */
export type FinishingFile = { path: string; bytes: Uint8Array };

function portable(file: string, label: string) {
  if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} '${file}' must be a portable relative path`);
  }
  return file;
}

/**
 * The `external.blender.script@1` spec of one finishing run. The source is the input `source`; each resource
 * (a glTF buffer or image, at the URI path relative to the source) is `resource-<n>`.
 */
export function createFinishingAssetSpec({ assetId, parameters, scriptSha256, blenderVersion, source, resources = [], output = "finished.glb" }: {
  assetId: string; parameters: unknown; scriptSha256: string; blenderVersion: string;
  source: { path: string; sha256: string }; resources?: { path: string; sha256: string }[]; output?: string;
}) {
  const normalized = normalizeFinishingParameters(parameters);
  const inputs: Record<string, { path: string; sha256: string }> = { source: { path: portable(source.path, "source"), sha256: source.sha256 } };
  const paths = new Set([inputs.source!.path, "finish.py", output]);
  resources.forEach((resource, index) => {
    if (paths.has(portable(resource.path, "resource"))) throw new Error(`resource path '${resource.path}' is declared twice`);
    paths.add(resource.path);
    inputs[`resource-${index}`] = { path: resource.path, sha256: resource.sha256 };
  });
  return blenderScriptSpec({
    assetId, inputs: { script: { path: "finish.py", sha256: scriptSha256 }, ...inputs }, blenderVersion,
    // Exact replay is demonstrated for every step but the Cycles AO bake (docs/finishing-recipe.md).
    arguments: normalized, output, reproducibility: normalized.repairs.includes("bake-ao") ? "approximate" : "exact",
  });
}

export type FinishingResult = {
  status: "changed" | "unchanged";
  cache: "hit" | "miss";
  glb: AssetRef;
  report: Record<string, unknown>;
};

async function writeAtomically(file: string, bytes: Uint8Array) {
  try {
    if (Buffer.compare(await readFile(file), Buffer.from(bytes)) === 0) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${process.pid}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
  return true;
}

/**
 * Finish one asset and promote it to `<publish>/<name>.glb` with its lineage report `<name>.finish.json`.
 *
 * `root` is the object store; `workspace` holds the declared inputs, the spec, the receipt and the generation
 * cache, so a rebuild with an unchanged spec reuses the cached Blender output. Nothing under `publish` changes
 * unless Blender, the production import gate and the optional placement all succeed.
 */
export async function finishAsset(root: string, { name, assetId, workspace, publish, parameters, source, resources = [], place, provenance = {} }: {
  name: string; assetId: string; workspace: string; publish: string; parameters: unknown;
  source: FinishingFile; resources?: FinishingFile[];
  /** Wrap the finished scene under `parentName`, footprint base centre at the origin (scene.place.gltf@1). */
  place?: { parentName: string };
  /** Where the source came from (a catalog source id or an authored path); recorded in the report. */
  provenance?: Record<string, unknown>;
}): Promise<FinishingResult> {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error("finishing name must be lowercase letters, digits, '.' and '-'");
  const normalized = normalizeFinishingParameters(parameters);
  const recipe = await readFinishingRecipeSource();
  const spec = createFinishingAssetSpec({
    assetId, parameters: normalized, scriptSha256: recipe.sha256, blenderVersion: recipe.blenderVersion,
    source: { path: source.path, sha256: sha256Bytes(source.bytes) },
    resources: resources.map((resource) => ({ path: resource.path, sha256: sha256Bytes(resource.bytes) })),
  });
  await mkdir(workspace, { recursive: true });
  for (const file of [{ path: "finish.py", bytes: recipe.bytes }, source, ...resources]) {
    await mkdir(path.dirname(path.join(workspace, file.path)), { recursive: true });
    await writeAtomically(path.join(workspace, file.path), file.bytes);
  }
  const specPath = path.join(workspace, "asset.json");
  await writeAtomically(specPath, Buffer.from(`${canonicalJson(spec)}\n`));
  // A failed Blender run (a rejected input or repair, a failed export) throws here, before anything is stored.
  const generated = await generateAsset(specPath);
  const bytes = await readFile(path.join(workspace, spec.output.path));
  const exported = (await storeAssetObject(root, { bytes, kind: "scene", mediaType: "model/gltf-binary" })).asset;
  const policy = { maxTriangles: normalized.policy.maxTriangles, requireNormals: true, allowedValidatorWarnings: [...FINISHING_ALLOWED_VALIDATOR_WARNINGS] };
  const imported = await executeGltfProductionImportOperation(root, { inputs: { source: exported }, parameters: { policy } });
  let glb = imported.outputs.output as AssetRef;
  let placement: unknown = null;
  if (place) {
    const placed = await executeGltfPlaceOperation(root, {
      inputs: { source: glb }, parameters: { parentName: place.parentName, anchor: "footprint-base-center", policy: { allowedValidatorWarnings: [...FINISHING_ALLOWED_VALIDATOR_WARNINGS] } },
    });
    glb = placed.outputs.output as AssetRef;
    placement = placed.observations;
  }
  const observations = generated.receipt.observations as { script: Record<string, unknown>; blenderVersion: string };
  const analysis = imported.observations as Record<string, unknown>;
  const report = {
    schema: "finish-report-v1", recipe: FINISHING_RECIPE, name, assetId,
    source: { path: source.path, sha256: sha256Bytes(source.bytes), byteLength: source.bytes.byteLength, ...provenance },
    resources: resources.map((resource) => ({ path: resource.path, sha256: sha256Bytes(resource.bytes), byteLength: resource.bytes.byteLength })),
    parameters: normalized,
    blender: { version: observations.blenderVersion, recipeSha256: recipe.sha256, reproducibility: spec.reproducibility.expected },
    finishing: observations.script,
    exported: { sha256: generated.outputSha256 },
    productionImport: { operation: "scene.import.gltf@2", accepted: analysis.accepted, triangles: analysis.triangleCount ?? null, policy },
    ...(place ? { placement: { operation: "scene.place.gltf@1", parentName: place.parentName, observations: placement } } : {}),
    output: glb,
  };
  const reportBytes = Buffer.from(`${canonicalJson(report)}\n`);
  await mkdir(publish, { recursive: true });
  // Promote the GLB, then its report: a report on disk always names the GLB next to it.
  const glbBytes = await resolveAssetObject(root, glb);
  const changed = await writeAtomically(path.join(publish, `${name}.glb`), glbBytes);
  const reportChanged = await writeAtomically(path.join(publish, `${name}.finish.json`), reportBytes);
  return { status: changed || reportChanged ? "changed" : "unchanged", cache: generated.cache.status, glb, report };
}
