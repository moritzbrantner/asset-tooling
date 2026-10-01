/// <reference path="./gltf-validator.d.ts" />
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { VERSION, type Document } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import { storeAssetObject } from "./asset-store.js";
import { GLTF_IMPORT_OPERATION } from "./gltf-import-operations.js";
import { checkedGltfInputs, gltfSummary, loadCheckedGltf, portableGltfUri, validateGltf } from "./gltf-processing.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetOperationResult, type ReadonlyAssetOperationDescriptor,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const PROFILE = "gltf-core-production-v1";
type Invocation = { parameters?: unknown; inputs?: unknown };
type Policy = {
  maxTriangles: number | null;
  maxJointsPerSkin: number | null;
  requireNormals: boolean;
  requiredClipNames: string[];
  allowedValidatorWarnings: string[];
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
        allowedValidatorWarnings: { type: "array", uniqueItems: true, maxItems: 1, items: { enum: ["NODE_SKINNED_MESH_NON_ROOT"] } },
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
  const fields = new Set(["maxTriangles", "maxJointsPerSkin", "requireNormals", "requiredClipNames", "allowedValidatorWarnings"]);
  for (const key of Object.keys(policy)) {
    if (!fields.has(key)) throw new Error(`unknown glTF production policy field '${key}'`);
  }
  const names = policy.requiredClipNames ?? [];
  if (!Array.isArray(names) || names.length > 256 || names.some((name) => typeof name !== "string" || !name.length)) {
    throw new Error("requiredClipNames must contain at most 256 nonempty strings");
  }
  if (new Set(names).size !== names.length) throw new Error("duplicate requiredClipNames");
  const warnings = policy.allowedValidatorWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.length > 1 || warnings.some((code) => code !== "NODE_SKINNED_MESH_NON_ROOT")) {
    throw new Error("allowedValidatorWarnings only supports NODE_SKINNED_MESH_NON_ROOT");
  }
  const normalizedPolicy: Policy = {
    maxTriangles: limit(policy.maxTriangles, "maxTriangles"),
    maxJointsPerSkin: limit(policy.maxJointsPerSkin, "maxJointsPerSkin"),
    requireNormals: boolean(policy.requireNormals, "requireNormals"),
    requiredClipNames: names,
    allowedValidatorWarnings: warnings,
  };
  return { resourceUris, policy: normalizedPolicy };
}

async function buildIdentity(root: string, invocation: Invocation, operation: ReadonlyAssetOperationDescriptor): Promise<AssetOperationBuildIdentity> {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const { identity } = await checkedGltfInputs(root, operation, parameters, invocation.inputs ?? {});
  return createAssetOperationBuildIdentity({
    operation, parameters: identity.parameters, inputs: identity.inputs,
    implementation: {
      id: "gltf-transform-production", version: "1", gltfTransform: VERSION, validator: validatorVersion(),
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
  const clips = root.listAnimations().map((animation) => {
    const starts = animation.listSamplers().map((sampler) => sampler.getInput()!.getMin([])[0]!);
    const ends = animation.listSamplers().map((sampler) => sampler.getInput()!.getMax([])[0]!);
    const startSeconds = Math.min(...starts);
    const endSeconds = Math.max(...ends);
    return {
      name: animation.getName(), startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds,
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
    meshes, skins: skinReports, clips, policy, accepted: diagnostics.length === 0, diagnostics,
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

export async function executeGltfAnalyzeOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const { document, inventory, validatorWarnings } = await loadCheckedGltf(root, GLTF_ANALYZE_OPERATION, parameters, invocation.inputs ?? {}, true, parameters.policy.allowedValidatorWarnings);
  return normalizeAssetOperationResult(GLTF_ANALYZE_OPERATION, {
    outputs: {}, observations: { ...analyze(document, parameters.policy), resources: inventory, validatorWarnings },
  });
}

export async function executeGltfProductionImportOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const { source, resources, document, io, inventory, validatorWarnings } = await loadCheckedGltf(root, GLTF_PRODUCTION_IMPORT_OPERATION, parameters, invocation.inputs ?? {}, true, parameters.policy.allowedValidatorWarnings);
  const analysis = analyze(document, parameters.policy);
  if (!analysis.accepted) throw new Error(`glTF production policy rejected source: ${analysis.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ")}`);
  const bytes = await io.writeBinary(document);
  const outputValidatorWarnings = await validateGltf(bytes, "glb", Object.create(null), "scene.import.gltf@2 output", parameters.policy.allowedValidatorWarnings);
  const stored = await storeAssetObject(root, {
    bytes, kind: "scene", mediaType: "model/gltf-binary",
    metadata: {
      profile: PROFILE, operation: "scene.import.gltf", operationVersion: "2", sourceSha256: source.sha256,
      resourceSha256s: resources.map((resource) => resource.sha256), coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  return normalizeAssetOperationResult(GLTF_PRODUCTION_IMPORT_OPERATION, { outputs: { output: stored.asset }, observations: { ...analysis, resources: inventory, validatorWarnings, outputValidatorWarnings } });
}
