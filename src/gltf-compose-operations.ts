/// <reference path="./gltf-validator.d.ts" />
/**
 * `scene.compose.skinned.gltf@1`: compose skinned glTF parts that share one skeleton into one GLB
 * (#110, owner answer 2026-10-17: body plus outfit on the shared skeleton, no geometry removed).
 * See docs/gltf-compose.md.
 */
import { VERSION, type Accessor, type Document, type Material, type Mesh, type Node, type Skin, type Texture, type TextureInfo } from "@gltf-transform/core";
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
const PROFILE = "gltf-skinned-compose-v1";
const MAX_PARTS = 16;
/** Rest TRS components closer than this are reported as equal in the rest-difference summary. */
export const GLTF_COMPOSE_REST_TOLERANCE = 1e-4;
type Invocation = { parameters?: unknown; inputs?: unknown };
type Policy = { allowedValidatorWarnings: string[] };

export const GLTF_COMPOSE_SKINNED_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.compose.skinned.gltf", version: "1",
  label: "Compose skinned glTF parts", category: "scene.processing",
  description: "Bind every skinned mesh of each part to the skeleton input's joint nodes by joint name, keeping each part's inverse bind matrices and weights, in one self-contained GLB.",
  inputs: [
    { id: "skeleton", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] },
    { id: "parts", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE], cardinality: { min: 1, max: MAX_PARTS } },
  ],
  outputs: [{ id: "output", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] }],
  parameterSchema: {
    type: "object", additionalProperties: false,
    properties: {
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

function normalizeParameters(value: unknown): { policy: Policy } {
  const input = plainObject(value, "glTF compose parameters");
  for (const key of Object.keys(input)) if (key !== "policy") throw new Error(`unknown glTF compose parameter '${key}'`);
  const policy = plainObject(input.policy ?? {}, "glTF compose policy");
  for (const key of Object.keys(policy)) if (key !== "allowedValidatorWarnings") throw new Error(`unknown glTF compose policy field '${key}'`);
  const warnings = policy.allowedValidatorWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((code) => !GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.includes(code))) {
    throw new Error(`allowedValidatorWarnings only supports ${GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.join(" and ")}`);
  }
  if (new Set(warnings).size !== warnings.length) throw new Error("duplicate allowedValidatorWarnings");
  return { policy: { allowedValidatorWarnings: [...warnings] } };
}

/** Normalized parameters/inputs, with every input's bytes rechecked against its pin. */
async function checkedInputs(root: string, invocation: Invocation) {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const identity = createAssetOperationBuildIdentity({
    operation: GLTF_COMPOSE_SKINNED_OPERATION, implementation: { id: "gltf-transform-skinned-compose", version: "2" },
    parameters, inputs: invocation.inputs ?? {},
  });
  const skeleton = identity.inputs.skeleton as AssetRef;
  const parts = identity.inputs.parts as AssetRef[];
  const load = async (asset: AssetRef) => {
    const bytes = await resolveAssetObject(root, asset);
    if (bytes.byteLength !== asset.byteLength || sha256Bytes(bytes) !== asset.sha256) throw new Error("glTF bytes do not match the declared input pin");
    return { asset, bytes };
  };
  return { parameters, identity, skeleton: await load(skeleton), parts: await Promise.all(parts.map(load)) };
}

export async function createGltfComposeSkinnedOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedInputs(root, invocation);
  return createAssetOperationBuildIdentity({
    operation: GLTF_COMPOSE_SKINNED_OPERATION, parameters: identity.parameters, inputs: identity.inputs,
    implementation: {
      id: "gltf-transform-skinned-compose", version: "2", gltfTransform: VERSION, validator: validatorVersion(),
      policies: {
        weightSum: GLTF_WEIGHT_SUM_POLICY, restTolerance: GLTF_COMPOSE_REST_TOLERANCE,
        supersededValidatorCodes: PRODUCTION_SUPERSEDED_VALIDATOR_CODES,
      },
      dependencyLockSha256: await readDependencyLockSha256(),
      assetTooling: await captureToolIdentity(),
    },
  });
}

function jointNames(skins: Skin[], location: string) {
  const byName = new Map<string, Node>();
  for (const [skinIndex, skin] of skins.entries()) {
    const seen = new Set<string>();
    for (const [joint, node] of skin.listJoints().entries()) {
      const name = node.getName();
      if (!name) throw new Error(`${location}: /skins/${skinIndex}/joints/${joint}: COMPOSE_JOINT_UNNAMED: joints are bound by name and must be named`);
      if (seen.has(name)) throw new Error(`${location}: /skins/${skinIndex}: COMPOSE_JOINT_NAME_DUPLICATE: joint name '${name}' is used twice`);
      seen.add(name);
      const existing = byName.get(name);
      if (existing && existing !== node) throw new Error(`${location}: COMPOSE_JOINT_NAME_DUPLICATE: two joint nodes are named '${name}'`);
      byName.set(name, node);
    }
  }
  return byName;
}

function rejectAnimations(document: Document, location: string) {
  const count = document.getRoot().listAnimations().length;
  if (count) throw new Error(`${location}: /animations: COMPOSE_ANIMATIONS_UNSUPPORTED: ${count} animation(s); compose skinned meshes without clips`);
}

function restDifference(part: Node, skeleton: Node) {
  const translation = Math.hypot(...part.getTranslation().map((value, index) => value - skeleton.getTranslation()[index]!));
  const scale = Math.max(...part.getScale().map((value, index) => Math.abs(value - skeleton.getScale()[index]!)));
  const a = part.getRotation(), b = skeleton.getRotation();
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return { translation, rotation: 2 * Math.acos(dot), scale };
}

function copyTextureInfo(target: TextureInfo | null, source: TextureInfo | null) {
  if (!target || !source) return;
  target.setTexCoord(source.getTexCoord()).setMagFilter(source.getMagFilter()).setMinFilter(source.getMinFilter())
    .setWrapS(source.getWrapS()).setWrapT(source.getWrapT());
}

/** Copies a part's skinned meshes into `output`, binding each skin to `joints` by name. */
function composePart(output: Document, part: Document, joints: Map<string, Node>, textureIndex: Map<string, Texture>, location: string) {
  const out = output.getRoot();
  const buffer = out.listBuffers()[0]!;
  const scene = out.getDefaultScene() ?? out.listScenes()[0]!;
  const source = part.getRoot();
  const meshNodes = source.listNodes().filter((node) => node.getMesh());
  for (const node of meshNodes) {
    if (!node.getSkin()) throw new Error(`${location}: /nodes/${source.listNodes().indexOf(node)}: COMPOSE_NON_SKINNED_MESH: part mesh '${node.getMesh()!.getName()}' has no skin`);
  }
  source.listMeshes().forEach((mesh, index) => {
    if (!meshNodes.some((node) => node.getMesh() === mesh)) throw new Error(`${location}: /meshes/${index}: COMPOSE_NON_SKINNED_MESH: part mesh '${mesh.getName()}' is not instanced by a skinned node`);
  });
  const partJoints = jointNames(source.listSkins(), location);
  for (const name of partJoints.keys()) {
    if (!joints.has(name)) throw new Error(`${location}: COMPOSE_JOINT_MISSING: part joint '${name}' is not a joint of the skeleton input`);
  }

  let texturesDeduplicated = 0, texturesAdded = 0;
  const textures = new Map<Texture, Texture>();
  const texture = (value: Texture | null) => {
    if (!value) return null;
    let copy = textures.get(value);
    if (copy) return copy;
    const image = value.getImage()!;
    const key = `${value.getMimeType()}:${sha256Bytes(image)}`;
    copy = textureIndex.get(key);
    if (copy) texturesDeduplicated += 1;
    else {
      copy = output.createTexture(value.getName()).setImage(image.slice()).setMimeType(value.getMimeType()).setURI(value.getURI()).setExtras(structuredClone(value.getExtras()));
      textureIndex.set(key, copy);
      texturesAdded += 1;
    }
    textures.set(value, copy);
    return copy;
  };
  const materials = new Map<Material, Material>();
  const material = (value: Material | null) => {
    if (!value) return null;
    let copy = materials.get(value);
    if (copy) return copy;
    copy = output.createMaterial(value.getName()).setExtras(structuredClone(value.getExtras()))
      .setBaseColorFactor(value.getBaseColorFactor()).setEmissiveFactor(value.getEmissiveFactor())
      .setMetallicFactor(value.getMetallicFactor()).setRoughnessFactor(value.getRoughnessFactor())
      .setAlphaMode(value.getAlphaMode()).setAlphaCutoff(value.getAlphaCutoff()).setDoubleSided(value.getDoubleSided())
      .setNormalScale(value.getNormalScale()).setOcclusionStrength(value.getOcclusionStrength())
      .setBaseColorTexture(texture(value.getBaseColorTexture())).setEmissiveTexture(texture(value.getEmissiveTexture()))
      .setNormalTexture(texture(value.getNormalTexture())).setMetallicRoughnessTexture(texture(value.getMetallicRoughnessTexture()))
      .setOcclusionTexture(texture(value.getOcclusionTexture()));
    copyTextureInfo(copy.getBaseColorTextureInfo(), value.getBaseColorTextureInfo());
    copyTextureInfo(copy.getEmissiveTextureInfo(), value.getEmissiveTextureInfo());
    copyTextureInfo(copy.getNormalTextureInfo(), value.getNormalTextureInfo());
    copyTextureInfo(copy.getMetallicRoughnessTextureInfo(), value.getMetallicRoughnessTextureInfo());
    copyTextureInfo(copy.getOcclusionTextureInfo(), value.getOcclusionTextureInfo());
    materials.set(value, copy);
    return copy;
  };
  const accessors = new Map<Accessor, Accessor>();
  const accessor = (value: Accessor | null) => {
    if (!value) return null;
    let copy = accessors.get(value);
    if (!copy) {
      copy = output.createAccessor(value.getName()).setType(value.getType()).setArray(value.getArray()!.slice())
        .setNormalized(value.getNormalized()).setSparse(value.getSparse()).setBuffer(buffer).setExtras(structuredClone(value.getExtras()));
      accessors.set(value, copy);
    }
    return copy;
  };
  const meshes = new Map<Mesh, Mesh>();
  const mesh = (value: Mesh) => {
    let copy = meshes.get(value);
    if (copy) return copy;
    copy = output.createMesh(value.getName()).setExtras(structuredClone(value.getExtras())).setWeights([...value.getWeights()]);
    for (const primitive of value.listPrimitives()) {
      const target = output.createPrimitive().setMode(primitive.getMode()).setIndices(accessor(primitive.getIndices()))
        .setMaterial(material(primitive.getMaterial())).setExtras(structuredClone(primitive.getExtras()));
      for (const semantic of primitive.listSemantics()) target.setAttribute(semantic, accessor(primitive.getAttribute(semantic)));
      // Morph targets (e.g. the Ranger facial variants, #348) travel with their primitive.
      for (const morph of primitive.listTargets()) {
        const copied = output.createPrimitiveTarget(morph.getName()).setExtras(structuredClone(morph.getExtras()));
        for (const semantic of morph.listSemantics()) copied.setAttribute(semantic, accessor(morph.getAttribute(semantic)));
        target.addTarget(copied);
      }
      copy.addPrimitive(target);
    }
    meshes.set(value, copy);
    return copy;
  };
  const skins = new Map<Skin, Skin>();
  const skin = (value: Skin) => {
    let copy = skins.get(value);
    if (copy) return copy;
    // Same joint order, so JOINTS_n indices and the part's own inverse bind matrices stay valid unchanged.
    copy = output.createSkin(value.getName()).setInverseBindMatrices(accessor(value.getInverseBindMatrices()))
      .setExtras(structuredClone(value.getExtras()));
    for (const joint of value.listJoints()) copy.addJoint(joints.get(joint.getName())!);
    const skeleton = value.getSkeleton();
    copy.setSkeleton(skeleton ? joints.get(skeleton.getName()) ?? null : null);
    skins.set(value, copy);
    return copy;
  };

  for (const node of meshNodes) {
    const copy = output.createNode(node.getName()).setMesh(mesh(node.getMesh()!)).setSkin(skin(node.getSkin()!))
      .setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale())
      .setExtras(structuredClone(node.getExtras()));
    scene.addChild(copy);
  }

  let differingJointCount = 0, maxTranslationDelta = 0, maxRotationDeltaRadians = 0, maxScaleDelta = 0;
  const differingJoints: string[] = [];
  for (const [name, node] of partJoints) {
    const delta = restDifference(node, joints.get(name)!);
    maxTranslationDelta = Math.max(maxTranslationDelta, delta.translation);
    maxRotationDeltaRadians = Math.max(maxRotationDeltaRadians, delta.rotation);
    maxScaleDelta = Math.max(maxScaleDelta, delta.scale);
    if (delta.translation > GLTF_COMPOSE_REST_TOLERANCE || delta.rotation > GLTF_COMPOSE_REST_TOLERANCE || delta.scale > GLTF_COMPOSE_REST_TOLERANCE) {
      differingJointCount += 1;
      differingJoints.push(name);
    }
  }
  return {
    jointCount: partJoints.size, meshesAdded: meshes.size, skinsCreated: skins.size, materialsAdded: materials.size,
    texturesAdded, texturesDeduplicated, triangleCount: gltfSummary(part).triangleCount,
    meshNames: [...meshes.keys()].map((value) => value.getName()),
    restDifferences: {
      space: "joint-local-rest-trs", tolerance: GLTF_COMPOSE_REST_TOLERANCE,
      differingJointCount, differingJoints, maxTranslationDelta, maxRotationDeltaRadians, maxScaleDelta,
    },
  };
}

export async function executeGltfComposeSkinnedOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { parameters, skeleton, parts } = await checkedInputs(root, invocation);
  const allowed = parameters.policy.allowedValidatorWarnings;
  const parse = async (input: { asset: AssetRef; bytes: Buffer }, location: string) => {
    const parsed = await parseCheckedGltfBytes(input.asset, input.bytes, Object.create(null), true, allowed);
    rejectAnimations(parsed.document, location);
    if (!parsed.document.getRoot().listSkins().length) throw new Error(`${location}: /skins: COMPOSE_SKIN_MISSING: input has no skin`);
    return parsed;
  };
  const base = await parse(skeleton, "skeleton");
  const output = base.document;
  const joints = jointNames(output.getRoot().listSkins(), "skeleton");
  const skeletonSummary = { ...gltfSummary(output), skinCount: output.getRoot().listSkins().length };
  const textureIndex = new Map<string, Texture>();
  for (const texture of output.getRoot().listTextures()) {
    const key = `${texture.getMimeType()}:${sha256Bytes(texture.getImage()!)}`;
    if (!textureIndex.has(key)) textureIndex.set(key, texture);
  }
  const inputWarnings = [{ input: "skeleton", warnings: base.validatorWarnings }];
  const partReports = [];
  for (const [index, part] of parts.entries()) {
    const location = `parts[${index}]`;
    const parsed = await parse(part, location);
    inputWarnings.push({ input: location, warnings: parsed.validatorWarnings });
    partReports.push({ index, sha256: part.asset.sha256, ...composePart(output, parsed.document, joints, textureIndex, location) });
  }
  const weightSums = checkWeightSums(output);
  const bytes = await base.io.writeBinary(output);
  const outputValidatorWarnings = await validateGltf(bytes, "glb", Object.create(null), "scene.compose.skinned.gltf@1 output", allowed, PRODUCTION_SUPERSEDED_VALIDATOR_CODES);
  const stored = await storeAssetObject(root, {
    bytes, kind: "scene", mediaType: GLB_MEDIA_TYPE,
    metadata: {
      profile: PROFILE, operation: GLTF_COMPOSE_SKINNED_OPERATION.id, operationVersion: GLTF_COMPOSE_SKINNED_OPERATION.version,
      skeletonSha256: skeleton.asset.sha256, partSha256s: parts.map((part) => part.asset.sha256),
      coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  const summary = gltfSummary(output);
  return normalizeAssetOperationResult(GLTF_COMPOSE_SKINNED_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      schemaVersion: 1, profile: PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
      transformsChanged: false, policy: parameters.policy,
      skeleton: {
        sha256: skeleton.asset.sha256, jointCount: joints.size, skinCount: skeletonSummary.skinCount,
        meshCount: skeletonSummary.meshCount, triangleCount: skeletonSummary.triangleCount,
      },
      parts: partReports,
      texturesDeduplicated: partReports.reduce((sum, part) => sum + part.texturesDeduplicated, 0),
      output: {
        ...summary, skinCount: output.getRoot().listSkins().length, jointCount: joints.size,
        meshNames: output.getRoot().listMeshes().map((mesh) => mesh.getName()),
      },
      weightSums, validatorWarnings: inputWarnings, outputValidatorWarnings,
      gltfTransform: VERSION, validator: validatorVersion(),
    },
  });
}
