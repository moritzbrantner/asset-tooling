/// <reference path="./gltf-validator.d.ts" />
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { Primitive, Root, VERSION, type Accessor, type Document } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import { storeAssetObject } from "./asset-store.js";
import { GLTF_IMPORT_OPERATION } from "./gltf-import-operations.js";
import { COLOR_NON_CLAMPED_SUPERSESSION, PRODUCTION_SUPERSEDED_VALIDATOR_CODES, checkedGltfInputs, gltfSummary, loadCheckedGltf, portableGltfUri, validateGltf } from "./gltf-processing.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetOperationResult, type ReadonlyAssetOperationDescriptor,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const PROFILE = "gltf-core-production-v1";
/** Owner-decided policy values (docs/gltf-import.md); they are part of the build identity. */
export const GLTF_WEIGHT_SUM_POLICY = Object.freeze({ policy: "gltf-weight-sum-tolerance-v1", tolerance: 1e-3 });
export const GLTF_SINGULAR_INVERSE_BIND_DETERMINANT = 1e-12;
/** Owner decision Q2 (a) on #118: float COLOR_n components may leave [0, 1] by at most `maxExcess` and are clamped. */
export const GLTF_COLOR_CLAMP_REPAIR = Object.freeze({ repair: "gltf-color-clamp-v1", maxExcess: 2e-4 });
export const GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS: readonly string[] = Object.freeze(["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"]);
const ALLOWED_VALIDATOR_WARNINGS = [...GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS];
const REPAIRS = [GLTF_COLOR_CLAMP_REPAIR.repair];
type Invocation = { parameters?: unknown; inputs?: unknown };
type Policy = {
  maxTriangles: number | null;
  maxJointsPerSkin: number | null;
  requireNormals: boolean;
  requiredClipNames: string[];
  allowedValidatorWarnings: string[];
  repairs: string[];
};
type Diagnostic = { path: string; rule: keyof Policy; message: string };

const parameterSchema = {
  type: "object", additionalProperties: false,
  properties: {
    resourceUris: {
      type: "array", maxItems: 1024, uniqueItems: true, items: { type: "string" },
    },
    policy: {
      type: "object", additionalProperties: false,
      properties: {
        maxTriangles: { type: ["integer", "null"], minimum: 1 },
        maxJointsPerSkin: { type: ["integer", "null"], minimum: 1 },
        requireNormals: { type: "boolean" },
        requiredClipNames: { type: "array", uniqueItems: true, maxItems: 256, items: { type: "string", minLength: 1 } },
        allowedValidatorWarnings: { type: "array", uniqueItems: true, maxItems: ALLOWED_VALIDATOR_WARNINGS.length, items: { enum: ALLOWED_VALIDATOR_WARNINGS } },
        repairs: { type: "array", uniqueItems: true, maxItems: REPAIRS.length, items: { enum: REPAIRS } },
      },
    },
  },
};

export const GLTF_PRODUCTION_IMPORT_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.import.gltf", version: "2",
  label: "Import production glTF", category: "scene.processing",
  description: "Preserve supported core glTF materials, hierarchy, skins and animation in a self-contained GLB under explicit production policy.",
  inputs: GLTF_IMPORT_OPERATION.inputs, outputs: GLTF_IMPORT_OPERATION.outputs, parameterSchema,
});
export const GLTF_ANALYZE_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.analyze.gltf", version: "1",
  label: "Analyze production glTF", category: "scene.analysis",
  description: "Validate and inspect core glTF geometry, materials, skin references and clip domains without writing derived objects.",
  inputs: GLTF_IMPORT_OPERATION.inputs, outputs: [], parameterSchema,
});

function object(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${location} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function limit(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`glTF policy.${field} must be a positive safe integer or null`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`glTF policy.${field} must be boolean`);
  return value;
}

function normalizeParameters(value: unknown) {
  const input = object(value, "glTF production parameters");
  for (const key of Object.keys(input)) {
    if (key !== "resourceUris" && key !== "policy") throw new Error(`unknown glTF production parameter '${key}'`);
  }
  const uris = input.resourceUris ?? [];
  if (!Array.isArray(uris) || uris.length > 1024) throw new Error("resourceUris must contain at most 1024 URIs");
  const resourceUris = uris.map(portableGltfUri);
  if (new Set(resourceUris).size !== resourceUris.length) throw new Error("duplicate glTF resourceUris");
  const policy = object(input.policy ?? {}, "glTF production policy");
  const fields = new Set(["maxTriangles", "maxJointsPerSkin", "requireNormals", "requiredClipNames", "allowedValidatorWarnings", "repairs"]);
  for (const key of Object.keys(policy)) {
    if (!fields.has(key)) throw new Error(`unknown glTF production policy field '${key}'`);
  }
  const names = policy.requiredClipNames ?? [];
  if (!Array.isArray(names) || names.length > 256 || names.some((name) => typeof name !== "string" || !name.length)) {
    throw new Error("requiredClipNames must contain at most 256 nonempty strings");
  }
  if (new Set(names).size !== names.length) throw new Error("duplicate requiredClipNames");
  const warnings = policy.allowedValidatorWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((code) => !ALLOWED_VALIDATOR_WARNINGS.includes(code))) {
    throw new Error(`allowedValidatorWarnings only supports ${ALLOWED_VALIDATOR_WARNINGS.join(" and ")}`);
  }
  if (new Set(warnings).size !== warnings.length) throw new Error("duplicate allowedValidatorWarnings");
  const repairs = policy.repairs ?? [];
  if (!Array.isArray(repairs) || repairs.some((repair) => !REPAIRS.includes(repair))) {
    throw new Error(`repairs only supports ${REPAIRS.join(", ")}`);
  }
  if (new Set(repairs).size !== repairs.length) throw new Error("duplicate repairs");
  const normalizedPolicy: Policy = {
    maxTriangles: limit(policy.maxTriangles, "maxTriangles"),
    maxJointsPerSkin: limit(policy.maxJointsPerSkin, "maxJointsPerSkin"),
    requireNormals: boolean(policy.requireNormals, "requireNormals"),
    requiredClipNames: names,
    allowedValidatorWarnings: warnings,
    repairs,
  };
  return { resourceUris, policy: normalizedPolicy };
}

async function buildIdentity(root: string, invocation: Invocation, operation: ReadonlyAssetOperationDescriptor): Promise<AssetOperationBuildIdentity> {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const { identity } = await checkedGltfInputs(root, operation, parameters, invocation.inputs ?? {});
  return createAssetOperationBuildIdentity({
    operation, parameters: identity.parameters, inputs: identity.inputs,
    implementation: {
      id: "gltf-transform-production", version: "2", gltfTransform: VERSION, validator: validatorVersion(),
      policies: {
        weightSum: GLTF_WEIGHT_SUM_POLICY,
        singularInverseBindDeterminant: GLTF_SINGULAR_INVERSE_BIND_DETERMINANT,
        colorClamp: GLTF_COLOR_CLAMP_REPAIR,
        supersededValidatorCodes: PRODUCTION_SUPERSEDED_VALIDATOR_CODES,
      },
      dependencyLockSha256: await readDependencyLockSha256(),
      assetTooling: await captureToolIdentity(),
    },
  });
}

export async function createGltfProductionImportOperationBuildIdentity(root: string, invocation: Invocation = {}) {
  return buildIdentity(root, invocation, GLTF_PRODUCTION_IMPORT_OPERATION);
}
export async function createGltfAnalyzeOperationBuildIdentity(root: string, invocation: Invocation = {}) {
  return buildIdentity(root, invocation, GLTF_ANALYZE_OPERATION);
}

/** Weights are never renormalized; out-of-tolerance sums fail with a located diagnostic. */
export function checkWeightSums(document: Document) {
  let maxAbsoluteDrift = 0;
  document.getRoot().listMeshes().forEach((mesh, meshIndex) => mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
    const sets = primitive.listSemantics().filter((semantic) => /^WEIGHTS_\d+$/.test(semantic)).sort()
      .map((semantic) => primitive.getAttribute(semantic)!);
    if (!sets.length) return;
    const element: number[] = [];
    for (let vertex = 0; vertex < sets[0]!.getCount(); vertex++) {
      let sum = 0;
      for (const set of sets) { set.getElement(vertex, element); for (const value of element) sum += value; }
      const drift = Math.abs(sum - 1);
      if (!(drift <= GLTF_WEIGHT_SUM_POLICY.tolerance)) {
        throw new Error(`/meshes/${meshIndex}/primitives/${primitiveIndex}/attributes/WEIGHTS_0: WEIGHTS_SUM_OUT_OF_TOLERANCE: vertex ${vertex} weights sum to ${sum} (${GLTF_WEIGHT_SUM_POLICY.policy} allows ${GLTF_WEIGHT_SUM_POLICY.tolerance})`);
      }
      maxAbsoluteDrift = Math.max(maxAbsoluteDrift, drift);
    }
  }));
  return { ...GLTF_WEIGHT_SUM_POLICY, maxAbsoluteDrift };
}

/**
 * The declared `gltf-color-clamp-v1` repair: float COLOR_n components outside [0, 1] by at most the
 * bound are clamped in the document; any larger excess fails before anything is stored. Normalized
 * integer colors cannot leave [0, 1] and are untouched. All attributes are measured before any is
 * changed, so an accessor shared by several attributes is reported at each of them.
 */
function clampColors(document: Document) {
  const { repair, maxExcess: bound } = GLTF_COLOR_CLAMP_REPAIR;
  const measured = document.getRoot().listMeshes().flatMap((mesh, meshIndex) => mesh.listPrimitives().flatMap((primitive, primitiveIndex) =>
    primitive.listSemantics().filter((semantic) => /^COLOR_\d+$/.test(semantic)).sort().flatMap((semantic) => {
      const accessor = primitive.getAttribute(semantic)!;
      if (accessor.getComponentType() !== 5126) return [];
      const path = `/meshes/${meshIndex}/primitives/${primitiveIndex}/attributes/${semantic}`;
      const array = accessor.getArray()!;
      let clampedComponentCount = 0, maxExcess = 0;
      for (const [index, value] of array.entries()) {
        const excess = value > 1 ? value - 1 : value < 0 ? -value : 0;
        if (!(excess <= bound)) {
          const size = accessor.getElementSize();
          throw new Error(`${path}: COLOR_CLAMP_EXCESS_OUT_OF_BOUND: component ${index % size} of element ${Math.floor(index / size)} is ${value} (${repair} allows ${bound} outside [0, 1])`);
        }
        if (excess > 0) { clampedComponentCount += 1; maxExcess = Math.max(maxExcess, excess); }
      }
      return clampedComponentCount ? [{ primitive, semantic, accessor, entry: { repair, path, clampedComponentCount, maxExcess } }] : [];
    })));
  for (const { primitive, semantic, accessor } of measured) {
    // Clamp a private copy when the accessor also serves any non-color use, so only colors change.
    let target = accessor;
    if (hasNonColorUse(accessor)) {
      target = accessor.clone().setArray(accessor.getArray()!.slice());
      primitive.setAttribute(semantic, target);
    }
    const array = target.getArray()!;
    for (const [index, value] of array.entries()) if (value > 1 || value < 0) array[index] = Math.min(1, Math.max(0, value));
  }
  return measured.map(({ entry }) => entry);
}

/** True when the accessor is referenced other than as a primitive's COLOR_n attribute. */
function hasNonColorUse(accessor: Accessor): boolean {
  return accessor.listParents().some((parent) => {
    if (parent instanceof Root) return false;
    if (!(parent instanceof Primitive)) return true;
    return parent.getIndices() === accessor
      || parent.listSemantics().some((semantic) => !/^COLOR_\d+$/.test(semantic) && parent.getAttribute(semantic) === accessor)
      || parent.listTargets().length > 0;
  });
}

function singularInverseBinds(document: Document) {
  const root = document.getRoot(), nodes = root.listNodes(), warnings = [];
  for (const [skinIndex, skin] of root.listSkins().entries()) {
    const matrices = skin.getInverseBindMatrices();
    if (!matrices) continue;
    const m: number[] = [];
    for (const [joint, node] of skin.listJoints().entries()) {
      matrices.getElement(joint, m);
      // Column-major MAT4: the upper-left 3x3 block holds the linear part.
      const determinant = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!)
        - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!)
        + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
      if (!Number.isFinite(determinant) || Math.abs(determinant) <= GLTF_SINGULAR_INVERSE_BIND_DETERMINANT) {
        warnings.push({
          code: "SKIN_INVERSE_BIND_MATRIX_SINGULAR", path: `/skins/${skinIndex}/inverseBindMatrices`,
          skin: skinIndex, joint, node: nodes.indexOf(node), determinant,
        });
      }
    }
  }
  return warnings;
}

function analyze(document: Document, policy: Policy) {
  const root = document.getRoot();
  const nodes = root.listNodes();
  const skins = root.listSkins();
  const summary = gltfSummary(document);
  const diagnostics: Diagnostic[] = [];
  if (policy.maxTriangles !== null && summary.triangleCount > policy.maxTriangles) {
    diagnostics.push({ path: "/meshes", rule: "maxTriangles", message: `${summary.triangleCount} triangles exceeds ${policy.maxTriangles}` });
  }
  const meshes = root.listMeshes().map((mesh, meshIndex) => ({
    name: mesh.getName(),
    primitives: mesh.listPrimitives().map((primitive, primitiveIndex) => {
      const location = `/meshes/${meshIndex}/primitives/${primitiveIndex}`;
      if (policy.requireNormals && !primitive.getAttribute("NORMAL")) {
        diagnostics.push({ path: `${location}/attributes/NORMAL`, rule: "requireNormals", message: "missing normals" });
      }
      const positions = primitive.getAttribute("POSITION")!;
      return {
        vertexCount: positions.getCount(), triangleCount: (primitive.getIndices() ?? positions).getCount() / 3,
        bounds: { space: "mesh-local-bind-pose", min: positions.getMin([]), max: positions.getMax([]) },
        material: primitive.getMaterial() ? root.listMaterials().indexOf(primitive.getMaterial()!) : null,
        attributes: primitive.listSemantics().sort().map((semantic) => {
          const accessor = primitive.getAttribute(semantic)!;
          return { semantic, count: accessor.getCount(), componentType: accessor.getComponentType(), normalized: accessor.getNormalized() };
        }),
      };
    }),
  }));
  const skinReports = skins.map((skin, index) => {
    const joints = skin.listJoints();
    if (policy.maxJointsPerSkin !== null && joints.length > policy.maxJointsPerSkin) {
      diagnostics.push({ path: `/skins/${index}`, rule: "maxJointsPerSkin", message: `${joints.length} joints exceeds ${policy.maxJointsPerSkin}` });
    }
    return {
      name: skin.getName(), joints: joints.map((joint) => nodes.indexOf(joint)),
      skeleton: skin.getSkeleton() ? nodes.indexOf(skin.getSkeleton()!) : null,
      inverseBindMatrixCount: skin.getInverseBindMatrices()?.getCount() ?? 0,
    };
  });
  const weightSums = checkWeightSums(document);
  const policyWarnings = singularInverseBinds(document);
  const clips = root.listAnimations().map((animation) => {
    // Only channel-referenced samplers affect playback; unused ones are listed but excluded from timing.
    const used = animation.listChannels().map((channel) => channel.getSampler()!);
    const timed = used.length ? [...new Set(used)] : animation.listSamplers();
    const starts = timed.map((sampler) => sampler.getInput()!.getMin([])[0]!);
    const ends = timed.map((sampler) => sampler.getInput()!.getMax([])[0]!);
    const startSeconds = Math.min(...starts);
    const endSeconds = Math.max(...ends);
    return {
      name: animation.getName(), startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds,
      unusedSamplers: animation.listSamplers().flatMap((sampler, index) =>
        animation.listChannels().some((channel) => channel.getSampler() === sampler) ? [] : [index]),
      singleKeyframeChannels: animation.listChannels().flatMap((channel, index) =>
        channel.getSampler()!.getInput()!.getCount() === 1 ? [index] : []),
      channels: animation.listChannels().map((channel) => ({
        node: nodes.indexOf(channel.getTargetNode()!), path: channel.getTargetPath(),
        interpolation: channel.getSampler()!.getInterpolation(),
        keyframeCount: channel.getSampler()!.getInput()!.getCount(),
      })),
    };
  });
  for (const required of policy.requiredClipNames) {
    const matches = clips.filter((clip) => clip.name === required);
    if (matches.length !== 1) {
      diagnostics.push({ path: "/animations", rule: "requiredClipNames", message: matches.length === 0 ? `missing clip '${required}'` : `ambiguous clip '${required}'` });
    }
  }
  return {
    schemaVersion: 1, profile: PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
    coordinateUnitEvidence: "gltf-2.0-contract", normalYConvention: "positive-y",
    ...summary, skinCount: skins.length, animationCount: clips.length,
    nodes: nodes.map((node) => ({
      name: node.getName(), parent: node.getParentNode() ? nodes.indexOf(node.getParentNode()!) : null,
      mesh: node.getMesh() ? root.listMeshes().indexOf(node.getMesh()!) : null,
      skin: node.getSkin() ? skins.indexOf(node.getSkin()!) : null,
    })),
    meshes, skins: skinReports, clips, policy, accepted: diagnostics.length === 0, diagnostics, weightSums, policyWarnings,
    materials: root.listMaterials().map((material) => ({
      name: material.getName(), baseColorFactor: material.getBaseColorFactor(),
      metallicFactor: material.getMetallicFactor(), roughnessFactor: material.getRoughnessFactor(),
      emissiveFactor: material.getEmissiveFactor(), alphaMode: material.getAlphaMode(),
      alphaCutoff: material.getAlphaCutoff(), doubleSided: material.getDoubleSided(),
      normalScale: material.getNormalScale(), occlusionStrength: material.getOcclusionStrength(),
      textures: [
        { slot: "baseColor", colorSpace: "srgb", texture: material.getBaseColorTexture(), info: material.getBaseColorTextureInfo() },
        { slot: "emissive", colorSpace: "srgb", texture: material.getEmissiveTexture(), info: material.getEmissiveTextureInfo() },
        { slot: "normal", colorSpace: "linear", texture: material.getNormalTexture(), info: material.getNormalTextureInfo() },
        { slot: "metallicRoughness", colorSpace: "linear", texture: material.getMetallicRoughnessTexture(), info: material.getMetallicRoughnessTextureInfo() },
        { slot: "occlusion", colorSpace: "linear", texture: material.getOcclusionTexture(), info: material.getOcclusionTextureInfo() },
      ].filter((slot) => slot.texture !== null).map((slot) => ({
        slot: slot.slot, colorSpace: slot.colorSpace, texture: root.listTextures().indexOf(slot.texture!),
        texCoord: slot.info!.getTexCoord(), wrapS: slot.info!.getWrapS(), wrapT: slot.info!.getWrapT(),
        minFilter: slot.info!.getMinFilter(), magFilter: slot.info!.getMagFilter(),
      })),
    })),
    textures: root.listTextures().map((texture) => ({
      name: texture.getName(), mimeType: texture.getMimeType(),
      sha256: sha256Bytes(texture.getImage()!), byteLength: texture.getImage()!.byteLength,
    })),
    gltfTransform: VERSION, validator: validatorVersion(),
  };
}

/** A declared repair replaces the source validator's check it repairs, only where it applies. */
function supersessions(policy: Policy) {
  return policy.repairs.includes(GLTF_COLOR_CLAMP_REPAIR.repair) ? [COLOR_NON_CLAMPED_SUPERSESSION] : [];
}

function applyRepairs(document: Document, policy: Policy) {
  return policy.repairs.includes(GLTF_COLOR_CLAMP_REPAIR.repair) ? clampColors(document) : [];
}

export async function executeGltfAnalyzeOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const { document, inventory, validatorWarnings } = await loadCheckedGltf(root, GLTF_ANALYZE_OPERATION, parameters, invocation.inputs ?? {}, true, parameters.policy.allowedValidatorWarnings, supersessions(parameters.policy));
  const repairs = applyRepairs(document, parameters.policy);
  return normalizeAssetOperationResult(GLTF_ANALYZE_OPERATION, {
    outputs: {}, observations: { ...analyze(document, parameters.policy), repairs, resources: inventory, validatorWarnings },
  });
}

export async function executeGltfProductionImportOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const { source, resources, document, io, inventory, validatorWarnings } = await loadCheckedGltf(root, GLTF_PRODUCTION_IMPORT_OPERATION, parameters, invocation.inputs ?? {}, true, parameters.policy.allowedValidatorWarnings, supersessions(parameters.policy));
  const repairs = applyRepairs(document, parameters.policy);
  const analysis = analyze(document, parameters.policy);
  if (!analysis.accepted) throw new Error(`glTF production policy rejected source: ${analysis.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ")}`);
  const bytes = await io.writeBinary(document);
  const outputValidatorWarnings = await validateGltf(bytes, "glb", Object.create(null), "scene.import.gltf@2 output", parameters.policy.allowedValidatorWarnings, PRODUCTION_SUPERSEDED_VALIDATOR_CODES);
  const stored = await storeAssetObject(root, {
    bytes, kind: "scene", mediaType: "model/gltf-binary",
    metadata: {
      profile: PROFILE, operation: "scene.import.gltf", operationVersion: "2", sourceSha256: source.sha256,
      resourceSha256s: resources.map((resource) => resource.sha256), coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  return normalizeAssetOperationResult(GLTF_PRODUCTION_IMPORT_OPERATION, { outputs: { output: stored.asset }, observations: { ...analysis, repairs, resources: inventory, validatorWarnings, outputValidatorWarnings } });
}
