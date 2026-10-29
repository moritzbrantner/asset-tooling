/// <reference path="./gltf-validator.d.ts" />
/**
 * glTF clip boundary for #110 (owner answer 2026-10-17: retarget UAL1 Idle_Loop/Walk_Loop onto the
 * UBC/Outfits rig with 3d-lab's retarget). See docs/humanoid-ranger.md.
 *
 * - `scene.extract.animation.gltf@1`: a skinned GLB's skin-joint rest rig (and optionally one named
 *   clip) as `three-d-humanoid-rig` / `three-d-animation-json-v1` documents on skin-joint indices.
 * - `scene.embed.animation.gltf@1`: write animation documents on skin-joint indices into a skinned
 *   GLB as LINEAR clips on the skin's joint nodes.
 *
 * Neither operation samples, interpolates or retargets: `animation.retarget@1` delegates that to the
 * pinned 3d-lab processor. These only move keys between glTF accessors and the integration codec.
 */
import { VERSION, type Animation, type Document, type Node, type Skin } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import {
  THREE_D_ANIMATION_MEDIA_TYPE, THREE_D_HUMANOID_RIG_MEDIA_TYPE, parseHumanoidRigDocument, parseThreeDAnimationDocument,
} from "./animation-processing-operations.js";
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
const EXTRACT_PROFILE = "gltf-skin-animation-extract-v1";
const EMBED_PROFILE = "gltf-skin-animation-embed-v1";
const EXTRACT_IMPLEMENTATION = { id: "gltf-transform-skin-animation-extract", version: "1" };
const EMBED_IMPLEMENTATION = { id: "gltf-transform-skin-animation-embed", version: "1" };
// The Ranger embeds 70 clips with the swim set (#393).
const MAX_CLIPS = 128;
const KINDS = ["translation", "rotation", "scale"] as const;
type Kind = (typeof KINDS)[number];
type Json = Record<string, unknown>;
type Invocation = { parameters?: unknown; inputs?: unknown };
type Policy = { allowedValidatorWarnings: string[] };
type Channel = { kind: Kind; node: number; keyframes: { time: number; value: number[] }[] };
type RigNode = { parent: number | null; translation: number[]; rotation: number[]; scale: number[] };

const policySchema = {
  type: "object", additionalProperties: false,
  properties: {
    allowedValidatorWarnings: {
      type: "array", uniqueItems: true, maxItems: GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.length,
      items: { enum: [...GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS] },
    },
  },
};

export const GLTF_EXTRACT_ANIMATION_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.extract.animation.gltf", version: "1",
  label: "Extract glTF skin rig and clip", category: "scene.processing",
  description: "Read a skinned GLB's skin-joint rest rig, with its hips model-space height as reference height, and optionally one named clip as an animation document on skin-joint indices.",
  // "animation": clip-library GLBs such as the UAL1 member are catalogued with kind "animation".
  inputs: [{ id: "source", assetKinds: ["scene", "animation"], mediaTypes: [GLB_MEDIA_TYPE] }],
  outputs: [
    { id: "rig", assetKinds: ["rig"], mediaTypes: [THREE_D_HUMANOID_RIG_MEDIA_TYPE] },
    { id: "animation", assetKinds: ["animation"], mediaTypes: [THREE_D_ANIMATION_MEDIA_TYPE], required: false },
  ],
  parameterSchema: {
    type: "object", additionalProperties: false, required: ["hipsJoint"],
    properties: {
      hipsJoint: { type: "string", minLength: 1 },
      clip: { type: "string", minLength: 1 },
      policy: policySchema,
    },
  },
});

export const GLTF_EMBED_ANIMATION_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.embed.animation.gltf", version: "1",
  label: "Embed clips in skinned glTF", category: "scene.processing",
  description: "Write animation documents on skin-joint indices into a skinned GLB as named LINEAR clips on the skin's joint nodes; existing geometry, skins and clips are unchanged.",
  inputs: [
    { id: "source", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] },
    { id: "animations", assetKinds: ["animation"], mediaTypes: [THREE_D_ANIMATION_MEDIA_TYPE], cardinality: { min: 1, max: MAX_CLIPS } },
  ],
  outputs: [{ id: "output", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] }],
  parameterSchema: {
    type: "object", additionalProperties: false, required: ["clips"],
    properties: {
      clips: {
        type: "array", minItems: 1, maxItems: MAX_CLIPS,
        items: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
      },
      policy: policySchema,
    },
  },
});

function plainObject(value: unknown, location: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${location} must be a plain object`);
  }
  return value as Json;
}

function name(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function normalizePolicy(value: unknown, location: string): Policy {
  const policy = plainObject(value ?? {}, location);
  for (const key of Object.keys(policy)) if (key !== "allowedValidatorWarnings") throw new Error(`unknown ${location} field '${key}'`);
  const warnings = policy.allowedValidatorWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((code) => !GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.includes(code))) {
    throw new Error(`allowedValidatorWarnings only supports ${GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.join(" and ")}`);
  }
  if (new Set(warnings).size !== warnings.length) throw new Error("duplicate allowedValidatorWarnings");
  return { allowedValidatorWarnings: [...warnings] };
}

function onlyKeys(input: Json, keys: string[], location: string) {
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`unknown ${location} '${key}'`);
}

async function checkedBytes(root: string, asset: AssetRef) {
  const bytes = await resolveAssetObject(root, asset);
  if (bytes.byteLength !== asset.byteLength || sha256Bytes(bytes) !== asset.sha256) throw new Error("input bytes do not match the declared input pin");
  return bytes;
}

async function implementation(base: { id: string; version: string }) {
  return {
    ...base, gltfTransform: VERSION, validator: validatorVersion(),
    policies: { weightSum: GLTF_WEIGHT_SUM_POLICY, supersededValidatorCodes: PRODUCTION_SUPERSEDED_VALIDATOR_CODES },
    dependencyLockSha256: await readDependencyLockSha256(),
    assetTooling: await captureToolIdentity(),
  };
}

/**
 * The rig skin is `skins[0]`. Every other skin must bind only its joint nodes (composed parts share the
 * skeleton's joints), so animating those joints moves every skinned mesh.
 */
function rigSkin(document: Document, code: string): Skin {
  const skins = document.getRoot().listSkins();
  const skin = skins[0];
  if (!skin) throw new Error(`/skins: ${code}_SKIN_MISSING: source has no skin`);
  const joints = new Set(skin.listJoints());
  for (const [index, other] of skins.entries()) {
    if (other.listJoints().some((joint) => !joints.has(joint))) {
      throw new Error(`/skins/${index}: ${code}_SKINS_DISJOINT: skin binds joints outside skins[0]`);
    }
  }
  const names = skin.listJoints().map((joint) => joint.getName());
  for (const [index, jointName] of names.entries()) {
    if (!jointName) throw new Error(`/skins/0/joints/${index}: ${code}_JOINT_UNNAMED: rig joints are bound by name`);
  }
  if (new Set(names).size !== names.length) throw new Error(`/skins/0: ${code}_JOINT_NAME_DUPLICATE: rig joint names must be unique`);
  // A joint's rig parent is its glTF parent. A non-joint helper between two joints would make the joint
  // look like a root with a TRS relative to the omitted helper, and embedded keys would be applied in the
  // helper's space, so such skins are rejected rather than silently disconnected.
  const jointSet = new Set(skin.listJoints());
  for (const [index, joint] of skin.listJoints().entries()) {
    let ancestor = joint.getParentNode();
    if (!ancestor || jointSet.has(ancestor)) continue;
    const helper = ancestor;
    while (ancestor && !jointSet.has(ancestor)) ancestor = ancestor.getParentNode();
    if (ancestor) {
      throw new Error(`/skins/0/joints/${index}: ${code}_JOINT_HELPER_ANCESTOR: joint '${joint.getName()}' is below joint '${ancestor.getName()}' through non-joint node '${helper.getName()}'; rig joints must be direct children of their joint parent`);
    }
  }
  return skin;
}

/** Skin-joint rest rig: local TRS per joint, parent joint index (null when the parent is not a joint). */
export function skinRig(skin: Skin, hipsJoint: string) {
  const joints = skin.listJoints();
  const index = new Map(joints.map((joint, position) => [joint, position]));
  const nodes: RigNode[] = joints.map((joint) => {
    const parent = joint.getParentNode();
    return {
      parent: parent && index.has(parent) ? index.get(parent)! : null,
      translation: [...joint.getTranslation()], rotation: [...joint.getRotation()], scale: [...joint.getScale()],
    };
  });
  const hips = joints.find((joint) => joint.getName() === hipsJoint);
  if (!hips) throw new Error(`EXTRACT_HIPS_MISSING: hipsJoint '${hipsJoint}' is not a joint of skins[0]`);
  // Model-space height: the hips world translation's Y, through every ancestor (joints and armature nodes).
  const referenceHeight = Math.fround(hips.getWorldMatrix()[13]);
  if (!(referenceHeight > 0)) throw new Error(`EXTRACT_REFERENCE_HEIGHT_INVALID: hips '${hipsJoint}' model-space height ${referenceHeight} must be positive`);
  return { schemaVersion: 1 as const, jointNames: joints.map((joint) => joint.getName()), nodes, referenceHeight };
}

function clipChannels(animation: Animation, joints: Node[], location: string) {
  const index = new Map(joints.map((joint, position) => [joint, position]));
  const channels: Channel[] = [];
  const skipped: { node: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const [channelIndex, channel] of animation.listChannels().entries()) {
    const node = channel.getTargetNode();
    const pathName = channel.getTargetPath();
    const sampler = channel.getSampler();
    const at = `${location}/channels/${channelIndex}`;
    if (!node || !sampler) throw new Error(`${at}: EXTRACT_CHANNEL_INCOMPLETE: channel has no target node or sampler`);
    const joint = index.get(node);
    if (joint === undefined || !KINDS.includes(pathName as Kind)) {
      skipped.push({ node: node.getName(), path: String(pathName) });
      continue;
    }
    if (sampler.getInterpolation() !== "LINEAR") {
      throw new Error(`${at}: EXTRACT_INTERPOLATION_UNSUPPORTED: ${sampler.getInterpolation()}; only LINEAR clips are extracted`);
    }
    const key = `${joint}:${pathName}`;
    if (seen.has(key)) throw new Error(`${at}: EXTRACT_CHANNEL_DUPLICATE: two ${pathName} channels target joint '${node.getName()}'`);
    seen.add(key);
    const input = sampler.getInput()!, output = sampler.getOutput()!;
    const times = Array.from(input.getArray()!);
    const value: number[] = [];
    const keyframes = times.map((time, keyIndex) => ({ time, value: [...output.getElement(keyIndex, value)] }));
    channels.push({ kind: pathName as Kind, node: joint, keyframes });
  }
  channels.sort((a, b) => a.node - b.node || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  if (!channels.length) throw new Error(`${location}: EXTRACT_CLIP_EMPTY: clip animates no skin joint`);
  return { channels, skipped };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

// ------------------------------------------------------------------ extract

type ExtractParameters = { hipsJoint: string; clip?: string; policy: Policy };

function normalizeExtractParameters(value: unknown): ExtractParameters {
  const input = plainObject(value, "glTF animation extract parameters");
  onlyKeys(input, ["hipsJoint", "clip", "policy"], "glTF animation extract parameter");
  return {
    hipsJoint: name(input.hipsJoint, "hipsJoint"),
    ...(input.clip === undefined ? {} : { clip: name(input.clip, "clip") }),
    policy: normalizePolicy(input.policy, "glTF animation extract policy"),
  };
}

async function checkedExtract(root: string, invocation: Invocation) {
  const parameters = normalizeExtractParameters(invocation.parameters ?? {});
  const identity = createAssetOperationBuildIdentity({
    operation: GLTF_EXTRACT_ANIMATION_OPERATION, implementation: EXTRACT_IMPLEMENTATION, parameters, inputs: invocation.inputs ?? {},
  });
  const asset = identity.inputs.source as AssetRef;
  return { parameters, identity, asset, bytes: await checkedBytes(root, asset) };
}

export async function createGltfExtractAnimationOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedExtract(root, invocation);
  return createAssetOperationBuildIdentity({
    operation: GLTF_EXTRACT_ANIMATION_OPERATION, parameters: identity.parameters, inputs: identity.inputs,
    implementation: await implementation(EXTRACT_IMPLEMENTATION),
  });
}

export async function executeGltfExtractAnimationOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { parameters, asset, bytes } = await checkedExtract(root, invocation);
  const parsed = await parseCheckedGltfBytes(asset, bytes, Object.create(null), true, parameters.policy.allowedValidatorWarnings);
  const document = parsed.document;
  const skin = rigSkin(document, "EXTRACT");
  const rig = skinRig(skin, parameters.hipsJoint);
  parseHumanoidRigDocument(jsonBytes(rig), "extracted rig");
  const rigAsset = (await storeAssetObject(root, {
    bytes: jsonBytes(rig), kind: "rig", mediaType: THREE_D_HUMANOID_RIG_MEDIA_TYPE,
    metadata: {
      profile: EXTRACT_PROFILE, operation: GLTF_EXTRACT_ANIMATION_OPERATION.id, sourceSha256: asset.sha256,
      jointCount: rig.nodes.length, hipsJoint: parameters.hipsJoint, referenceHeight: rig.referenceHeight,
    },
  })).asset;
  const outputs: Record<string, AssetRef> = { rig: rigAsset };
  const clipNames = document.getRoot().listAnimations().map((animation) => animation.getName());
  let clip: Json | undefined;
  if (parameters.clip !== undefined) {
    const matches = document.getRoot().listAnimations().flatMap((animation, index) => animation.getName() === parameters.clip ? [{ animation, index }] : []);
    if (matches.length !== 1) {
      throw new Error(`/animations: ${matches.length ? "EXTRACT_CLIP_AMBIGUOUS" : "EXTRACT_CLIP_MISSING"}: clip '${parameters.clip}' must name exactly one animation`);
    }
    const { animation, index } = matches[0]!;
    const { channels, skipped } = clipChannels(animation, skin.listJoints(), `/animations/${index}`);
    const animationBytes = jsonBytes({ schemaVersion: 1, channels });
    const checked = parseThreeDAnimationDocument(animationBytes, `clip '${parameters.clip}'`);
    outputs.animation = (await storeAssetObject(root, {
      bytes: animationBytes, kind: "animation", mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
      metadata: {
        animationSchemaVersion: 1, channelCount: checked.channelCount, keyframeCount: checked.keyframeCount,
        operation: GLTF_EXTRACT_ANIMATION_OPERATION.id, sourceSha256: asset.sha256, clip: parameters.clip, rigSha256: rigAsset.sha256,
      },
    })).asset;
    clip = {
      name: parameters.clip, channelCount: checked.channelCount, keyframeCount: checked.keyframeCount,
      startSeconds: checked.startSeconds, endSeconds: checked.endSeconds, skippedChannels: skipped,
    };
  }
  return normalizeAssetOperationResult(GLTF_EXTRACT_ANIMATION_OPERATION, {
    outputs,
    observations: {
      schemaVersion: 1, profile: EXTRACT_PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
      source: { sha256: asset.sha256, ...gltfSummary(document), skinCount: document.getRoot().listSkins().length, clipNames },
      rig: { jointCount: rig.nodes.length, rootJoints: rig.nodes.flatMap((node, index) => node.parent === null ? [rig.jointNames[index]!] : []), hipsJoint: parameters.hipsJoint, referenceHeight: rig.referenceHeight },
      ...(clip ? { clip } : {}),
      policy: parameters.policy, validatorWarnings: parsed.validatorWarnings,
      gltfTransform: VERSION, validator: validatorVersion(),
    },
  });
}

// ------------------------------------------------------------------ embed

type EmbedParameters = { clips: { name: string }[]; policy: Policy };

function normalizeEmbedParameters(value: unknown): EmbedParameters {
  const input = plainObject(value, "glTF animation embed parameters");
  onlyKeys(input, ["clips", "policy"], "glTF animation embed parameter");
  if (!Array.isArray(input.clips) || input.clips.length < 1 || input.clips.length > MAX_CLIPS) {
    throw new Error(`clips must list 1 to ${MAX_CLIPS} clips`);
  }
  const clips = input.clips.map((raw, index) => {
    const clip = plainObject(raw, `clips[${index}]`);
    onlyKeys(clip, ["name"], `clips[${index}] field`);
    return { name: name(clip.name, `clips[${index}].name`) };
  });
  if (new Set(clips.map((clip) => clip.name)).size !== clips.length) throw new Error("EMBED_CLIP_DUPLICATE: clip names must be unique");
  return { clips, policy: normalizePolicy(input.policy, "glTF animation embed policy") };
}

async function checkedEmbed(root: string, invocation: Invocation) {
  const parameters = normalizeEmbedParameters(invocation.parameters ?? {});
  const identity = createAssetOperationBuildIdentity({
    operation: GLTF_EMBED_ANIMATION_OPERATION, implementation: EMBED_IMPLEMENTATION, parameters, inputs: invocation.inputs ?? {},
  });
  const source = identity.inputs.source as AssetRef;
  const animations = identity.inputs.animations as AssetRef[];
  if (animations.length !== parameters.clips.length) throw new Error("inputs.animations must pair one animation with each of parameters.clips");
  return {
    parameters, identity, source, bytes: await checkedBytes(root, source),
    animations: await Promise.all(animations.map(async (asset) => ({ asset, bytes: await checkedBytes(root, asset) }))),
  };
}

export async function createGltfEmbedAnimationOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedEmbed(root, invocation);
  return createAssetOperationBuildIdentity({
    operation: GLTF_EMBED_ANIMATION_OPERATION, parameters: identity.parameters, inputs: identity.inputs,
    implementation: await implementation(EMBED_IMPLEMENTATION),
  });
}

export async function executeGltfEmbedAnimationOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { parameters, source, bytes, animations } = await checkedEmbed(root, invocation);
  const allowed = parameters.policy.allowedValidatorWarnings;
  const parsed = await parseCheckedGltfBytes(source, bytes, Object.create(null), true, allowed);
  const document = parsed.document;
  const documentRoot = document.getRoot();
  const joints = rigSkin(document, "EMBED").listJoints();
  const existing = documentRoot.listAnimations().map((animation) => animation.getName());
  for (const clip of parameters.clips) {
    if (existing.includes(clip.name)) throw new Error(`/animations: EMBED_CLIP_EXISTS: the source already has a clip named '${clip.name}'`);
  }
  const buffer = documentRoot.listBuffers()[0] ?? document.createBuffer();
  const clips = parameters.clips.map((clip, clipIndex) => {
    const animation = parseThreeDAnimationDocument(animations[clipIndex]!.bytes, `clips[${clipIndex}] '${clip.name}'`);
    const target = document.createAnimation(clip.name);
    for (const [channelIndex, channel] of animation.channels.entries()) {
      const joint = joints[channel.node];
      if (!joint) {
        throw new Error(`clips[${clipIndex}].channels[${channelIndex}]: EMBED_NODE_OUT_OF_RANGE: node ${channel.node} is not a joint index of skins[0] (${joints.length} joints)`);
      }
      const width = channel.kind === "rotation" ? 4 : 3;
      const input = document.createAccessor().setType("SCALAR").setBuffer(buffer)
        .setArray(Float32Array.from(channel.keyframes, (keyframe: { time: number }) => keyframe.time));
      const values = new Float32Array(channel.keyframes.length * width);
      channel.keyframes.forEach((keyframe: { value: number[] }, keyIndex: number) => values.set(keyframe.value, keyIndex * width));
      const output = document.createAccessor().setType(width === 4 ? "VEC4" : "VEC3").setBuffer(buffer).setArray(values);
      const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
      target.addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(joint).setTargetPath(channel.kind).setSampler(sampler));
    }
    return {
      name: clip.name, sha256: animations[clipIndex]!.asset.sha256, channelCount: animation.channelCount, keyframeCount: animation.keyframeCount,
      startSeconds: animation.startSeconds, endSeconds: animation.endSeconds,
      animatedJoints: [...new Set(animation.channels.map((channel: { node: number }) => joints[channel.node]!.getName()))],
    };
  });
  const weightSums = checkWeightSums(document);
  const output = await parsed.io.writeBinary(document);
  const outputValidatorWarnings = await validateGltf(output, "glb", Object.create(null), "scene.embed.animation.gltf@1 output", allowed, PRODUCTION_SUPERSEDED_VALIDATOR_CODES);
  const stored = await storeAssetObject(root, {
    bytes: output, kind: "scene", mediaType: GLB_MEDIA_TYPE,
    metadata: {
      profile: EMBED_PROFILE, operation: GLTF_EMBED_ANIMATION_OPERATION.id, operationVersion: GLTF_EMBED_ANIMATION_OPERATION.version,
      sourceSha256: source.sha256, clips: clips.map((clip) => ({ name: clip.name, sha256: clip.sha256 })),
      coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  return normalizeAssetOperationResult(GLTF_EMBED_ANIMATION_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      schemaVersion: 1, profile: EMBED_PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
      interpolation: "LINEAR", transformsChanged: false, skinsChanged: false,
      source: { sha256: source.sha256, ...gltfSummary(document), clipNames: existing },
      clips,
      output: { ...gltfSummary(document), skinCount: documentRoot.listSkins().length, clipNames: documentRoot.listAnimations().map((animation) => animation.getName()) },
      weightSums, policy: parameters.policy, validatorWarnings: parsed.validatorWarnings, outputValidatorWarnings,
      gltfTransform: VERSION, validator: validatorVersion(),
    },
  });
}
