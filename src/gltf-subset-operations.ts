/// <reference path="./gltf-validator.d.ts" />
/**
 * `scene.subset.skinned.gltf@1`: keep only the triangles of a skinned GLB that are bound to chosen
 * joints (#110, owner decision 2026-10-17, option A: keep the Universal Base Characters face, eyes
 * and eyebrows, then compose them with the Male_Ranger outfit, whose hood covers the seam).
 * See docs/gltf-subset.md.
 */
import { PropertyType, VERSION, type Accessor, type Document, type Mesh, type Node, type Primitive, type Property, type Skin } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { PRODUCTION_SUPERSEDED_VALIDATOR_CODES, gltfSummary, parseCheckedGltfBytes, validateGltf } from "./gltf-processing.js";
import { GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS, GLTF_WEIGHT_SUM_POLICY, checkWeightSums } from "./gltf-production-operations.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetOperationResult, type AssetRef,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const GLB_MEDIA_TYPE = "model/gltf-binary";
const PROFILE = "gltf-skinned-subset-v1";
const IMPLEMENTATION = { id: "gltf-transform-skinned-subset", version: "1" };
const MAX_NAMES = 256;
export const GLTF_SUBSET_DEFAULT_MIN_WEIGHT = 0.5;
type Invocation = { parameters?: unknown; inputs?: unknown };
type Policy = { allowedValidatorWarnings: string[] };
type Parameters = { keepJoints: string[]; minWeight: number; keepMeshes: string[]; policy: Policy };

const nameList = (minItems: number) => ({
  type: "array", minItems, maxItems: MAX_NAMES, uniqueItems: true, items: { type: "string", minLength: 1 },
});

export const GLTF_SUBSET_SKINNED_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.subset.skinned.gltf", version: "1",
  label: "Subset skinned glTF by joint", category: "scene.processing",
  description: "Keep only the skinned triangles whose three vertices are weighted to the chosen joints, plus whole kept meshes, in one self-contained GLB; skins and inverse bind matrices are unchanged.",
  inputs: [{ id: "source", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] }],
  outputs: [{ id: "output", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] }],
  parameterSchema: {
    type: "object", additionalProperties: false, required: ["keepJoints"],
    properties: {
      keepJoints: nameList(1),
      minWeight: { type: "number", exclusiveMinimum: 0, maximum: 1, default: GLTF_SUBSET_DEFAULT_MIN_WEIGHT },
      keepMeshes: { ...nameList(0), default: [] },
      policy: {
        type: "object", additionalProperties: false,
        properties: {
          allowedValidatorWarnings: {
            type: "array", uniqueItems: true, maxItems: GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.length,
            items: { enum: [...GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS] },
          },
        },
      },
    },
  },
});

function plainObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${location} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function names(value: unknown, field: string, minItems: number): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > MAX_NAMES
    || value.some((name) => typeof name !== "string" || !name)) {
    throw new Error(`${field} must be a list of ${minItems ? "1" : "0"} to ${MAX_NAMES} non-empty names`);
  }
  if (new Set(value).size !== value.length) throw new Error(`duplicate ${field}`);
  return [...value];
}

function normalizeParameters(value: unknown): Parameters {
  const input = plainObject(value, "glTF subset parameters");
  for (const key of Object.keys(input)) {
    if (!["keepJoints", "minWeight", "keepMeshes", "policy"].includes(key)) throw new Error(`unknown glTF subset parameter '${key}'`);
  }
  const keepJoints = names(input.keepJoints, "keepJoints", 1);
  const keepMeshes = names(input.keepMeshes ?? [], "keepMeshes", 0);
  const minWeight = input.minWeight ?? GLTF_SUBSET_DEFAULT_MIN_WEIGHT;
  if (typeof minWeight !== "number" || !Number.isFinite(minWeight) || !(minWeight > 0 && minWeight <= 1)) {
    throw new Error("minWeight must be a number in (0, 1]");
  }
  const policy = plainObject(input.policy ?? {}, "glTF subset policy");
  for (const key of Object.keys(policy)) if (key !== "allowedValidatorWarnings") throw new Error(`unknown glTF subset policy field '${key}'`);
  const warnings = policy.allowedValidatorWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((code) => !GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.includes(code))) {
    throw new Error(`allowedValidatorWarnings only supports ${GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.join(" and ")}`);
  }
  if (new Set(warnings).size !== warnings.length) throw new Error("duplicate allowedValidatorWarnings");
  return { keepJoints, minWeight, keepMeshes, policy: { allowedValidatorWarnings: [...warnings] } };
}

/** Normalized parameters and the source input, its bytes rechecked against the pin. */
async function checkedInputs(root: string, invocation: Invocation) {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const identity = createAssetOperationBuildIdentity({
    operation: GLTF_SUBSET_SKINNED_OPERATION, implementation: IMPLEMENTATION, parameters, inputs: invocation.inputs ?? {},
  });
  const asset = identity.inputs.source as AssetRef;
  const bytes = await resolveAssetObject(root, asset);
  if (bytes.byteLength !== asset.byteLength || sha256Bytes(bytes) !== asset.sha256) throw new Error("glTF bytes do not match the declared input pin");
  return { parameters, identity, source: { asset, bytes } };
}

export async function createGltfSubsetSkinnedOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedInputs(root, invocation);
  return createAssetOperationBuildIdentity({
    operation: GLTF_SUBSET_SKINNED_OPERATION, parameters: identity.parameters, inputs: identity.inputs,
    implementation: {
      ...IMPLEMENTATION, gltfTransform: VERSION, validator: validatorVersion(),
      policies: { weightSum: GLTF_WEIGHT_SUM_POLICY, supersededValidatorCodes: PRODUCTION_SUPERSEDED_VALIDATOR_CODES },
      dependencyLockSha256: await readDependencyLockSha256(),
      assetTooling: await captureToolIdentity(),
    },
  });
}

const used = (property: Property) => property.listParents().some((parent) => parent.propertyType !== PropertyType.ROOT);

/** The one skin every node instancing `mesh` uses, or null for a mesh that no skinned node instances. */
function meshSkin(document: Document, mesh: Mesh, meshIndex: number): Skin | null {
  const skins = new Set(document.getRoot().listNodes().filter((node) => node.getMesh() === mesh).map((node) => node.getSkin()));
  if (skins.size > 1) throw new Error(`/meshes/${meshIndex}: SUBSET_MESH_MULTIPLE_SKINS: mesh '${mesh.getName()}' is instanced with different skins`);
  return [...skins][0] ?? null;
}

/** Per vertex: the summed weight on joints whose names are kept, over every JOINTS_n/WEIGHTS_n set. */
function keptWeights(primitive: Primitive, keptJointIndices: Set<number>, location: string): Float64Array {
  const sets = primitive.listSemantics().filter((semantic) => /^WEIGHTS_\d+$/.test(semantic)).sort();
  if (!sets.length) throw new Error(`${location}: SUBSET_WEIGHTS_MISSING: skinned primitive has no WEIGHTS_0`);
  const count = primitive.getAttribute("POSITION")!.getCount();
  const sums = new Float64Array(count);
  const joint: number[] = [], weight: number[] = [];
  for (const semantic of sets) {
    const joints = primitive.getAttribute(semantic.replace("WEIGHTS_", "JOINTS_"));
    if (!joints) throw new Error(`${location}: SUBSET_WEIGHTS_MISSING: ${semantic} has no matching JOINTS set`);
    const weights = primitive.getAttribute(semantic)!;
    for (let vertex = 0; vertex < count; vertex += 1) {
      joints.getElement(vertex, joint);
      weights.getElement(vertex, weight);
      for (let k = 0; k < joint.length; k += 1) if (keptJointIndices.has(joint[k]!)) sums[vertex]! += weight[k]!;
    }
  }
  return sums;
}

/** Same type, normalization and component type, holding only `vertices` in their original order: values stay byte-exact. */
function compact(document: Document, source: Accessor, vertices: Uint32Array): Accessor {
  const size = source.getElementSize();
  const array = source.getArray()!;
  const out = new (array.constructor as { new(length: number): typeof array })(vertices.length * size);
  for (let index = 0; index < vertices.length; index += 1) {
    const from = vertices[index]! * size;
    for (let component = 0; component < size; component += 1) out[index * size + component] = array[from + component]!;
  }
  return document.createAccessor(source.getName()).setType(source.getType()).setArray(out).setNormalized(source.getNormalized())
    .setBuffer(source.getBuffer()).setExtras(structuredClone(source.getExtras()));
}

/** Filters one triangle-list primitive in place; returns its report. */
function subsetPrimitive(document: Document, primitive: Primitive, keptJointIndices: Set<number>, minWeight: number, location: string) {
  if (primitive.getMode() !== 4) throw new Error(`${location}: SUBSET_PRIMITIVE_MODE_UNSUPPORTED: mode ${primitive.getMode()}; only triangle lists are subset`);
  const sums = keptWeights(primitive, keptJointIndices, location);
  const vertexCount = sums.length;
  const indices = primitive.getIndices();
  const source = indices ? Array.from(indices.getArray()!) : Array.from({ length: vertexCount }, (_, index) => index);
  const keptVertex = (vertex: number) => sums[vertex]! >= minWeight;
  const kept: number[] = [];
  for (let triangle = 0; triangle + 2 < source.length; triangle += 3) {
    const a = source[triangle]!, b = source[triangle + 1]!, c = source[triangle + 2]!;
    if (keptVertex(a) && keptVertex(b) && keptVertex(c)) kept.push(a, b, c);
  }
  const triangleCount = source.length / 3;
  const report = { keptTriangles: kept.length / 3, removedTriangles: triangleCount - kept.length / 3, sourceVertexCount: vertexCount, keptVertexCount: 0 };
  if (!kept.length) return report;
  // Compact to the referenced vertices, ascending, so the output carries no unused vertex data.
  const referenced = [...new Set(kept)].sort((a, b) => a - b);
  const remap = new Map(referenced.map((vertex, index) => [vertex, index]));
  const vertices = Uint32Array.from(referenced);
  report.keptVertexCount = vertices.length;
  for (const semantic of primitive.listSemantics()) primitive.setAttribute(semantic, compact(document, primitive.getAttribute(semantic)!, vertices));
  for (const target of primitive.listTargets()) {
    for (const semantic of target.listSemantics()) target.setAttribute(semantic, compact(document, target.getAttribute(semantic)!, vertices));
  }
  const IndexArray = vertices.length > 0xffff ? Uint32Array : Uint16Array;
  primitive.setIndices(document.createAccessor(indices?.getName() ?? "").setType("SCALAR")
    .setArray(IndexArray.from(kept, (vertex) => remap.get(vertex)!)).setBuffer((indices ?? primitive.getAttribute("POSITION")!).getBuffer()));
  return report;
}

/** Disposes everything no longer referenced: removed nodes, unused skins, materials, textures and accessors. */
function prune(document: Document, meshNodes: Node[], removedNodeNames: string[]) {
  const root = document.getRoot();
  const joints = new Set(root.listSkins().flatMap((skin) => skin.listJoints()));
  for (const node of meshNodes) {
    if (node.getMesh()) continue;
    node.setSkin(null);
    if (!node.listChildren().length && !joints.has(node)) { removedNodeNames.push(node.getName()); node.dispose(); }
  }
  const removedSkins = root.listSkins().filter((skin) => !used(skin)).map((skin) => { const name = skin.getName(); skin.dispose(); return name; });
  for (const material of root.listMaterials()) if (!used(material)) material.dispose();
  for (const texture of root.listTextures()) if (!used(texture)) texture.dispose();
  for (const accessor of root.listAccessors()) if (!used(accessor)) accessor.dispose();
  return removedSkins;
}

export async function executeGltfSubsetSkinnedOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { parameters, source } = await checkedInputs(root, invocation);
  const allowed = parameters.policy.allowedValidatorWarnings;
  const parsed = await parseCheckedGltfBytes(source.asset, source.bytes, Object.create(null), true, allowed);
  const document = parsed.document;
  const documentRoot = document.getRoot();
  const animations = documentRoot.listAnimations().length;
  if (animations) throw new Error(`/animations: SUBSET_ANIMATIONS_UNSUPPORTED: ${animations} animation(s); subset skinned meshes without clips`);
  if (!documentRoot.listSkins().length) throw new Error("/skins: SUBSET_SKIN_MISSING: source has no skin");
  const jointNames = new Set(documentRoot.listSkins().flatMap((skin) => skin.listJoints().map((joint) => joint.getName())));
  for (const name of parameters.keepJoints) {
    if (!jointNames.has(name)) throw new Error(`SUBSET_JOINT_MISSING: keepJoints names '${name}', which is not a joint of the source skins`);
  }
  const meshNames = new Set(documentRoot.listMeshes().map((mesh) => mesh.getName()));
  for (const name of parameters.keepMeshes) {
    if (!meshNames.has(name)) throw new Error(`SUBSET_MESH_MISSING: keepMeshes names '${name}', which is not a mesh of the source`);
  }
  const sourceSummary = { ...gltfSummary(document), skinCount: documentRoot.listSkins().length };
  const meshNodes = documentRoot.listNodes().filter((node) => node.getMesh());
  const keepJoints = new Set(parameters.keepJoints);
  const keepMeshes = new Set(parameters.keepMeshes);

  const meshes = [];
  const removedMeshes: string[] = [];
  for (const [meshIndex, mesh] of documentRoot.listMeshes().entries()) {
    const name = mesh.getName();
    const skin = meshSkin(document, mesh, meshIndex);
    const triangles = mesh.listPrimitives().reduce((sum, primitive) => sum + (primitive.getIndices() ?? primitive.getAttribute("POSITION")!).getCount() / 3, 0);
    if (keepMeshes.has(name)) {
      meshes.push({ name, skinned: Boolean(skin), keptWhole: true, keptTriangles: triangles, removedTriangles: 0, primitives: [] });
      continue;
    }
    if (!skin) {
      removedMeshes.push(name);
      meshes.push({ name, skinned: false, keptWhole: false, keptTriangles: 0, removedTriangles: triangles, primitives: [] });
      mesh.listPrimitives().forEach((primitive) => primitive.dispose());
      mesh.dispose();
      continue;
    }
    const keptJointIndices = new Set(skin.listJoints().flatMap((joint, index) => keepJoints.has(joint.getName()) ? [index] : []));
    const primitives = mesh.listPrimitives().map((primitive, primitiveIndex) => {
      const report = subsetPrimitive(document, primitive, keptJointIndices, parameters.minWeight, `/meshes/${meshIndex}/primitives/${primitiveIndex}`);
      if (!report.keptTriangles) primitive.dispose();
      return { index: primitiveIndex, ...report, removed: !report.keptTriangles };
    });
    const keptTriangles = primitives.reduce((sum, primitive) => sum + primitive.keptTriangles, 0);
    meshes.push({ name, skinned: true, keptWhole: false, keptTriangles, removedTriangles: triangles - keptTriangles, primitives });
    if (!mesh.listPrimitives().length) { removedMeshes.push(name); mesh.dispose(); }
  }
  if (!documentRoot.listMeshes().length) throw new Error("SUBSET_EMPTY_RESULT: no triangle of the source is kept; check keepJoints, minWeight and keepMeshes");
  const removedNodes: string[] = [];
  const removedSkins = prune(document, meshNodes, removedNodes);

  const weightSums = checkWeightSums(document);
  const bytes = await parsed.io.writeBinary(document);
  const outputValidatorWarnings = await validateGltf(bytes, "glb", Object.create(null), "scene.subset.skinned.gltf@1 output", allowed, PRODUCTION_SUPERSEDED_VALIDATOR_CODES);
  const stored = await storeAssetObject(root, {
    bytes, kind: "scene", mediaType: GLB_MEDIA_TYPE,
    metadata: {
      profile: PROFILE, operation: GLTF_SUBSET_SKINNED_OPERATION.id, operationVersion: GLTF_SUBSET_SKINNED_OPERATION.version,
      sourceSha256: source.asset.sha256, keepJoints: parameters.keepJoints, minWeight: parameters.minWeight, keepMeshes: parameters.keepMeshes,
      coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  const summary = gltfSummary(document);
  return normalizeAssetOperationResult(GLTF_SUBSET_SKINNED_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      schemaVersion: 1, profile: PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
      transformsChanged: false, skinsChanged: false,
      keepJoints: parameters.keepJoints, minWeight: parameters.minWeight, keepMeshes: parameters.keepMeshes, policy: parameters.policy,
      source: { sha256: source.asset.sha256, ...sourceSummary },
      meshes, removedMeshes, removedNodes, removedSkins,
      output: {
        ...summary, skinCount: documentRoot.listSkins().length,
        meshNames: documentRoot.listMeshes().map((mesh) => mesh.getName()),
      },
      weightSums, validatorWarnings: parsed.validatorWarnings, outputValidatorWarnings,
      gltfTransform: VERSION, validator: validatorVersion(),
    },
  });
}
