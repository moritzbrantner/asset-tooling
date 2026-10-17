/// <reference path="./gltf-validator.d.ts" />
/**
 * `scene.textures.resize.gltf@1`: downscale the embedded textures of one GLB to declared per-slot
 * maximum edges for game delivery (#257). Only image bytes (and so their dimensions) change: nodes,
 * meshes, accessors, skins, animations, materials, samplers and texture references are untouched.
 * PNG stays PNG (no KTX2/WebP extension requirement for consumers). Images are never upscaled, an
 * image shared by several textures or slots is resampled once, colour is averaged in linear light,
 * normal maps are averaged as decoded vectors and renormalized, and the PNG is written by
 * `image.encode.png@1` at zlib level 9. See docs/gltf-texture-resize.md.
 */
import { ImageUtils, VERSION, type Material, type Texture } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { PRODUCTION_SUPERSEDED_VALIDATOR_CODES, gltfSummary, parseCheckedGltfBytes, validateGltf } from "./gltf-processing.js";
import { GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS } from "./gltf-production-operations.js";
import { sha256Bytes } from "./hash.js";
import {
  IMAGE_DECODE_OPERATION, IMAGE_ENCODE_PNG_OPERATION, executeImageDecodeOperation, executeImageEncodePngOperation, probeImageCodecImplementation,
} from "./image-codec-operations.js";
import { encodeLinearRgba8Image, LINEAR_RGBA8_IMAGE_MEDIA_TYPE } from "./image-linear-rgba8.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "./image-rgba8.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const GLB_MEDIA_TYPE = "model/gltf-binary";
const PROFILE = "gltf-texture-resize-v1";
const IMPLEMENTATION = { id: "gltf-transform-texture-resize", version: "1", filter: "area-average-float32-v1" };
const MAX_EDGE = 8192;
export const GLTF_TEXTURE_SLOTS = ["baseColor", "normal", "metallicRoughness", "occlusion", "emissive"] as const;
export type GltfTextureSlot = typeof GLTF_TEXTURE_SLOTS[number];
/** How a texel is averaged: sRGB colour in premultiplied linear light, linear data as is, normals as unit vectors. */
export type GltfTextureEncoding = "srgb" | "linear" | "normal";
export const GLTF_TEXTURE_SLOT_ENCODING: Readonly<Record<GltfTextureSlot, GltfTextureEncoding>> = {
  baseColor: "srgb", emissive: "srgb", normal: "normal", metallicRoughness: "linear", occlusion: "linear",
};
type Invocation = { parameters?: unknown; inputs?: unknown; runtime?: unknown };
type Policy = { allowedValidatorWarnings: string[] };
export type GltfTextureResizeParameters = { maxEdgeBySlot: Partial<Record<GltfTextureSlot, number>>; default: number; policy: Policy };

const edge = { type: "integer", minimum: 1, maximum: MAX_EDGE };
export const GLTF_TEXTURE_RESIZE_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.textures.resize.gltf", version: "1",
  label: "Resize glTF textures", category: "scene.processing",
  description: "Downscale the embedded images of one self-contained GLB to per-slot maximum edges (never upscaling), re-encoded as PNG; only image bytes and dimensions change.",
  inputs: [{ id: "source", assetKinds: ["scene", "mesh"], mediaTypes: [GLB_MEDIA_TYPE] }],
  outputs: [{ id: "output", assetKinds: ["scene", "mesh"], mediaTypes: [GLB_MEDIA_TYPE] }],
  parameterSchema: {
    type: "object", additionalProperties: false, required: ["maxEdgeBySlot", "default"],
    properties: {
      maxEdgeBySlot: { type: "object", additionalProperties: false, properties: Object.fromEntries(GLTF_TEXTURE_SLOTS.map((slot) => [slot, edge])) },
      default: edge,
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

function maxEdge(value: unknown, location: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_EDGE) throw new Error(`${location} must be an integer in 1..${MAX_EDGE}`);
  return value;
}

function normalizeParameters(value: unknown): GltfTextureResizeParameters {
  const input = plainObject(value, "glTF texture resize parameters");
  for (const key of Object.keys(input)) if (!["maxEdgeBySlot", "default", "policy"].includes(key)) throw new Error(`unknown glTF texture resize parameter '${key}'`);
  const bySlot = plainObject(input.maxEdgeBySlot, "maxEdgeBySlot");
  const maxEdgeBySlot: Partial<Record<GltfTextureSlot, number>> = {};
  for (const key of Object.keys(bySlot)) {
    if (!(GLTF_TEXTURE_SLOTS as readonly string[]).includes(key)) throw new Error(`unknown texture slot '${key}'; expected ${GLTF_TEXTURE_SLOTS.join(", ")}`);
  }
  for (const slot of GLTF_TEXTURE_SLOTS) if (bySlot[slot] !== undefined) maxEdgeBySlot[slot] = maxEdge(bySlot[slot], `maxEdgeBySlot.${slot}`);
  const policy = plainObject(input.policy ?? {}, "glTF texture resize policy");
  for (const key of Object.keys(policy)) if (key !== "allowedValidatorWarnings") throw new Error(`unknown glTF texture resize policy field '${key}'`);
  const warnings = policy.allowedValidatorWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((code) => !GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.includes(code))) {
    throw new Error(`allowedValidatorWarnings only supports ${GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.join(" and ")}`);
  }
  if (new Set(warnings).size !== warnings.length) throw new Error("duplicate allowedValidatorWarnings");
  return { maxEdgeBySlot, default: maxEdge(input.default, "default"), policy: { allowedValidatorWarnings: [...warnings] } };
}

async function checkedInputs(root: string, invocation: Invocation) {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const decode = await probeImageCodecImplementation(IMAGE_DECODE_OPERATION, invocation.runtime ?? {});
  const encode = await probeImageCodecImplementation(IMAGE_ENCODE_PNG_OPERATION, invocation.runtime ?? {});
  const identity = createAssetOperationBuildIdentity({
    operation: GLTF_TEXTURE_RESIZE_OPERATION, parameters, inputs: invocation.inputs ?? {},
    implementation: {
      ...IMPLEMENTATION, gltfTransform: VERSION, validator: validatorVersion(),
      imageDecode: decode.implementation, pngEncode: encode.implementation, pngCompressionLevel: 9,
      policies: { supersededValidatorCodes: PRODUCTION_SUPERSEDED_VALIDATOR_CODES },
      dependencyLockSha256: await readDependencyLockSha256(),
    },
  });
  const asset = createAssetRef(identity.inputs.source);
  const bytes = await resolveAssetObject(root, asset);
  if (bytes.byteLength !== asset.byteLength || sha256Bytes(bytes) !== asset.sha256) throw new Error("glTF bytes do not match the declared input pin");
  return { parameters, identity, runtime: decode.runtime, source: { asset, bytes } };
}

export async function createGltfTextureResizeOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedInputs(root, invocation);
  return createAssetOperationBuildIdentity({
    operation: GLTF_TEXTURE_RESIZE_OPERATION, parameters: identity.parameters, inputs: identity.inputs,
    implementation: { ...identity.implementation, assetTooling: await captureToolIdentity() },
  });
}

/** Target size: the longest edge becomes `limit` (rounded, at least 1 px), or the size is kept when it already fits. */
export function gltfTextureTargetSize(width: number, height: number, limit: number) {
  const longest = Math.max(width, height);
  if (longest <= limit) return { width, height };
  const scale = limit / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const linearToSrgb8 = (value: number) => {
  const c = value <= 0 ? 0 : value >= 1 ? 1 : value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(c * 255);
};
const unit8 = (value: number) => Math.min(255, Math.max(0, Math.round(value * 255)));

/** For each destination index, the source indices it covers and their area weights (summing to 1). */
function areaWeights(sourceLength: number, targetLength: number) {
  const scale = sourceLength / targetLength;
  const spans: { first: number; weights: number[] }[] = [];
  for (let target = 0; target < targetLength; target += 1) {
    const start = target * scale, end = (target + 1) * scale;
    const first = Math.floor(start), last = Math.min(sourceLength, Math.ceil(end));
    const weights: number[] = [];
    for (let source = first; source < last; source += 1) weights.push((Math.min(end, source + 1) - Math.max(start, source)) / scale);
    spans.push({ first, weights });
  }
  return spans;
}

/**
 * Area-average (box) downscale in float32 working space. `srgb` averages premultiplied linear light
 * and writes straight sRGB; `linear` averages the stored values; `normal` averages the decoded
 * [-1, 1] vectors and renormalizes them (a zero average becomes +Z). Alpha is averaged linearly.
 */
export function resizeGltfTextureRgba8(source: Rgba8Image, width: number, height: number, encoding: GltfTextureEncoding): Rgba8Image {
  const { width: sw, height: sh, pixels } = source;
  if (width > sw || height > sh) throw new Error("texture resize never upscales");
  const decode = (offset: number, out: Float64Array) => {
    const alpha = pixels[offset + 3]! / 255;
    for (let c = 0; c < 3; c += 1) {
      const value = pixels[offset + c]!;
      out[c] = encoding === "srgb" ? SRGB_TO_LINEAR[value]! * alpha : encoding === "normal" ? value / 127.5 - 1 : value / 255;
    }
    out[3] = alpha;
  };
  const xs = areaWeights(sw, width), ys = areaWeights(sh, height);
  // Horizontal pass: sh rows x width columns.
  const rows = new Float32Array(sh * width * 4);
  const texel = new Float64Array(4), sum = new Float64Array(4);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { first, weights } = xs[x]!;
      sum.fill(0);
      for (let k = 0; k < weights.length; k += 1) {
        decode((y * sw + first + k) * 4, texel);
        for (let c = 0; c < 4; c += 1) sum[c]! += texel[c]! * weights[k]!;
      }
      rows.set(sum, (y * width + x) * 4);
    }
  }
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const { first, weights } = ys[y]!;
    for (let x = 0; x < width; x += 1) {
      sum.fill(0);
      for (let k = 0; k < weights.length; k += 1) {
        const offset = ((first + k) * width + x) * 4;
        for (let c = 0; c < 4; c += 1) sum[c]! += rows[offset + c]! * weights[k]!;
      }
      const out = (y * width + x) * 4, alpha = sum[3]!;
      output[out + 3] = unit8(alpha);
      if (encoding === "srgb") {
        for (let c = 0; c < 3; c += 1) output[out + c] = alpha > 0 ? linearToSrgb8(sum[c]! / alpha) : 0;
      } else if (encoding === "normal") {
        const length = Math.hypot(sum[0]!, sum[1]!, sum[2]!);
        const n = length > 1e-8 ? [sum[0]! / length, sum[1]! / length, sum[2]! / length] : [0, 0, 1];
        for (let c = 0; c < 3; c += 1) output[out + c] = Math.min(255, Math.max(0, Math.round((n[c]! + 1) * 127.5)));
      } else {
        for (let c = 0; c < 3; c += 1) output[out + c] = unit8(sum[c]!);
      }
    }
  }
  return { width, height, pixels: output };
}

/** Core material slots that reference `texture`. Extension textures have none and use `default`. */
function textureSlots(materials: Material[], texture: Texture): GltfTextureSlot[] {
  const slots = new Set<GltfTextureSlot>();
  for (const material of materials) {
    if (material.getBaseColorTexture() === texture) slots.add("baseColor");
    if (material.getNormalTexture() === texture) slots.add("normal");
    if (material.getMetallicRoughnessTexture() === texture) slots.add("metallicRoughness");
    if (material.getOcclusionTexture() === texture) slots.add("occlusion");
    if (material.getEmissiveTexture() === texture) slots.add("emissive");
  }
  return GLTF_TEXTURE_SLOTS.filter((slot) => slots.has(slot));
}

function encodingOf(slots: GltfTextureSlot[], location: string): GltfTextureEncoding {
  const encodings = new Set(slots.map((slot) => GLTF_TEXTURE_SLOT_ENCODING[slot]));
  if (encodings.size > 1) throw new Error(`${location}: TEXTURE_RESIZE_MIXED_ENCODING: one image is used as ${[...encodings].join(" and ")} data (${slots.join(", ")})`);
  return [...encodings][0] ?? "linear";
}

function single(result: AssetOperationResult) {
  const output = result.outputs.output;
  if (!output || Array.isArray(output)) throw new Error("image codec output is missing");
  return output;
}

export async function executeGltfTextureResizeOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { parameters, runtime, source } = await checkedInputs(root, invocation);
  const allowed = parameters.policy.allowedValidatorWarnings;
  const parsed = await parseCheckedGltfBytes(source.asset, source.bytes, Object.create(null), true, allowed);
  const { document } = parsed;
  const documentRoot = document.getRoot();
  const sourceSummary = gltfSummary(document);
  const materials = documentRoot.listMaterials();
  const textures = documentRoot.listTextures();

  // Group the textures by image bytes: each distinct image is resampled once to the largest limit of its slots.
  type Group = { sha256: string; bytes: Uint8Array; mimeType: string; textures: number[]; slots: Set<GltfTextureSlot>; encoding?: GltfTextureEncoding; limit: number };
  const groups = new Map<string, Group>();
  const perTexture = textures.map((texture, index) => {
    const image = texture.getImage();
    if (!image) throw new Error(`/textures/${index}: TEXTURE_RESIZE_IMAGE_MISSING: texture has no embedded image`);
    const slots = textureSlots(materials, texture);
    const limit = slots.length ? Math.max(...slots.map((slot) => parameters.maxEdgeBySlot[slot] ?? parameters.default)) : parameters.default;
    const sha256 = sha256Bytes(image);
    const group = groups.get(sha256) ?? { sha256, bytes: image, mimeType: texture.getMimeType(), textures: [], slots: new Set(), limit: 0 };
    group.textures.push(index);
    for (const slot of slots) group.slots.add(slot);
    group.limit = Math.max(group.limit, limit);
    groups.set(sha256, group);
    return { index, name: texture.getName(), slots, limit, sha256 };
  });

  let decodes = 0, encodes = 0;
  const images = [];
  for (const group of groups.values()) {
    const slots = GLTF_TEXTURE_SLOTS.filter((slot) => group.slots.has(slot));
    const encoding = encodingOf(slots, `/textures/${group.textures[0]}`);
    const size = ImageUtils.getSize(group.bytes, group.mimeType);
    if (!size) throw new Error(`/textures/${group.textures[0]}: TEXTURE_RESIZE_IMAGE_UNREADABLE: cannot read ${group.mimeType} dimensions`);
    const [width, height] = size;
    const target = gltfTextureTargetSize(width, height, group.limit);
    const before = { sha256: group.sha256, byteLength: group.bytes.byteLength, mimeType: group.mimeType, width, height };
    let after = before;
    if (target.width !== width || target.height !== height) {
      const stored = (await storeAssetObject(root, { bytes: group.bytes, kind: "image", mediaType: group.mimeType })).asset;
      const decoded = single(await executeImageDecodeOperation(root, { inputs: { source: stored }, parameters: {}, runtime }));
      decodes += 1;
      const resized = resizeGltfTextureRgba8(parseRgba8Image(await resolveAssetObject(root, decoded), { width, height }), target.width, target.height, encoding);
      const canonical = (await storeAssetObject(root, encoding === "srgb"
        ? { bytes: encodeRgba8Image(resized), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE }
        : { bytes: encodeLinearRgba8Image(resized), kind: "image", mediaType: LINEAR_RGBA8_IMAGE_MEDIA_TYPE })).asset;
      const png = single(await executeImageEncodePngOperation(root, { inputs: { source: canonical }, parameters: { compressionLevel: 9 }, runtime }));
      encodes += 1;
      const bytes = await resolveAssetObject(root, png);
      for (const index of group.textures) textures[index]!.setImage(bytes).setMimeType("image/png");
      after = { sha256: png.sha256, byteLength: png.byteLength, mimeType: "image/png", ...target };
    }
    images.push({ textures: group.textures, names: group.textures.map((index) => textures[index]!.getName()), slots, encoding, maxEdge: group.limit,
      resized: after !== before, before, after });
  }

  const bytes = await parsed.io.writeBinary(document);
  const outputValidatorWarnings = await validateGltf(bytes, "glb", Object.create(null), "scene.textures.resize.gltf@1 output", allowed, PRODUCTION_SUPERSEDED_VALIDATOR_CODES);
  const summary = gltfSummary(document);
  const sum = (key: "before" | "after") => images.reduce((total, image) => total + image[key].byteLength, 0);
  const stored = await storeAssetObject(root, {
    bytes, kind: source.asset.kind, mediaType: GLB_MEDIA_TYPE,
    metadata: {
      profile: PROFILE, operation: GLTF_TEXTURE_RESIZE_OPERATION.id, operationVersion: GLTF_TEXTURE_RESIZE_OPERATION.version,
      sourceSha256: source.asset.sha256, maxEdgeBySlot: parameters.maxEdgeBySlot, default: parameters.default,
      coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  return normalizeAssetOperationResult(GLTF_TEXTURE_RESIZE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      schemaVersion: 1, profile: PROFILE, filter: IMPLEMENTATION.filter, pngCompressionLevel: 9,
      maxEdgeBySlot: parameters.maxEdgeBySlot, default: parameters.default, policy: parameters.policy,
      textures: perTexture.map(({ index, name, slots, limit, sha256 }) => ({ index, name, slots, maxEdge: limit, sourceSha256: sha256 })),
      images, uniqueImages: images.length, resizedImages: images.filter((image) => image.resized).length, imageDecodes: decodes, pngEncodes: encodes,
      imageBytes: { before: sum("before"), after: sum("after") },
      source: { sha256: source.asset.sha256, byteLength: source.asset.byteLength, ...sourceSummary },
      output: { byteLength: bytes.byteLength, ...summary },
      validatorWarnings: parsed.validatorWarnings, outputValidatorWarnings,
      gltfTransform: VERSION, validator: validatorVersion(),
    },
  });
}
