import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetOperationResult } from "./operations.js";
import { captureToolIdentity } from "./tool.js";

type Invocation = { parameters?: unknown; inputs?: unknown };
export type HeightMaskFlattenParameters = { targetHeight: number; channel: "scalar" | "alpha" };
const MAX_DIMENSION = 256;
const MAX_ENCODED_BYTES = 512 * 1024;
const ALGORITHM = "q8-same-grid-masked-target-height-v1";
export const HEIGHT_MASK_FLATTEN_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "image.height.mask-flatten", version: "1", label: "Flatten masked height samples", category: "procedural.height",
  description: "Blend an opaque grayscale Q8 height field toward a declared target using a verified same-grid scalar or alpha mask; zero mask samples remain unchanged.",
  inputs: [
    { id: "source", assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE] },
    { id: "mask", assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE] },
  ],
  outputs: [{ id: "output", assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE] }],
  parameterSchema: { type: "object", additionalProperties: false, required: ["targetHeight", "channel"], properties: {
    targetHeight: { type: "integer", minimum: 0, maximum: 255 }, channel: { enum: ["scalar", "alpha"] },
  } },
});

function parameters(value: unknown): HeightMaskFlattenParameters {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("masked height parameters must be a plain object");
  // Plain-object validation establishes a string-keyed boundary.
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== 2 || !Object.hasOwn(p, "targetHeight") || !Object.hasOwn(p, "channel")) throw new Error("masked height parameters require exactly targetHeight and channel");
  if (typeof p.targetHeight !== "number" || !Number.isInteger(p.targetHeight) || p.targetHeight < 0 || p.targetHeight > 255) throw new Error("targetHeight must be an integer in 0..255");
  if (p.channel !== "scalar" && p.channel !== "alpha") throw new Error("mask channel must be scalar or alpha");
  return { targetHeight: p.targetHeight, channel: p.channel };
}
function opaqueGrayscale(pixels: Uint8Array, label: string) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] !== pixels[offset + 1] || pixels[offset] !== pixels[offset + 2] || pixels[offset + 3] !== 255) throw new Error(`${label} must contain opaque grayscale samples`);
  }
}
async function checked(root: string, invocation: Invocation) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("masked height operation root must be an absolute path");
  const p = parameters(invocation.parameters);
  const build = createAssetOperationBuildIdentity({ operation: HEIGHT_MASK_FLATTEN_OPERATION, parameters: p, inputs: invocation.inputs ?? {},
    implementation: { id: "builtin.image.height.mask-flatten", version: "1", algorithm: ALGORITHM, randomness: "none",
      heightEncoding: "q8-opaque-grayscale", sampleAssociation: "same-row-column-no-resampling", tool: await captureToolIdentity() } });
  const sourceRef = createAssetRef(build.inputs.source), maskRef = createAssetRef(build.inputs.mask);
  if (sourceRef.byteLength > MAX_ENCODED_BYTES || maskRef.byteLength > MAX_ENCODED_BYTES) throw new Error("masked height inputs must each fit 512 KiB encoded bytes");
  const source = parseRgba8Image(await resolveAssetObject(root, sourceRef));
  const mask = parseRgba8Image(await resolveAssetObject(root, maskRef));
  if (source.width > MAX_DIMENSION || source.height > MAX_DIMENSION || mask.width > MAX_DIMENSION || mask.height > MAX_DIMENSION) throw new Error("masked height dimensions must be in 1..256");
  if (source.width !== mask.width || source.height !== mask.height) throw new Error("mask dimensions must exactly match the height source; transform explicitly before flattening");
  opaqueGrayscale(source.pixels, "height source");
  if (p.channel === "scalar") opaqueGrayscale(mask.pixels, "scalar mask");
  return { build, p, sourceRef, maskRef, source, mask };
}
export async function createHeightMaskFlattenOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  return (await checked(root, invocation)).build;
}
export async function executeHeightMaskFlattenOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { p, sourceRef, maskRef, source, mask } = await checked(root, invocation);
  const pixels = Buffer.alloc(source.pixels.length);
  const counts = { zero: 0, full: 0, partial: 0, changed: 0 };
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const original = source.pixels[offset]!;
    const weight = mask.pixels[offset + (p.channel === "alpha" ? 3 : 0)]!;
    const height = Math.floor(((255 - weight) * original + weight * p.targetHeight + 127) / 255);
    if (weight === 0) counts.zero += 1;
    else if (weight === 255) counts.full += 1;
    else counts.partial += 1;
    if (height !== original) counts.changed += 1;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = height;
    pixels[offset + 3] = 255;
  }
  const stored = await storeAssetObject(root, { bytes: encodeRgba8Image({ width: source.width, height: source.height, pixels }), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: { width: source.width, height: source.height, pixelFormat: "rgba8", colorSpace: "srgb", alphaMode: "straight", field: "height", heightEncoding: "luma8",
      sourceSha256: sourceRef.sha256, maskSha256: maskRef.sha256, generator: "image.height.mask-flatten@1", terrainTransform: "mask-flatten" } });
  return normalizeAssetOperationResult(HEIGHT_MASK_FLATTEN_OPERATION, { outputs: { output: stored.asset }, observations: {
    width: source.width, height: source.height, algorithm: ALGORITHM, randomness: "none", parameters: p, maskSamples: counts,
    sampleAssociation: "same-row-column-no-resampling",
  } });
}
