import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetRef,
  type ReadonlyAssetOperationDescriptor,

  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import {
  RGBA8_IMAGE_MEDIA_TYPE,
  encodeRgba8Image,
  parseRgba8Image,
} from "./image-rgba8.js";
import { captureToolIdentity, type ToolIdentity } from "./tool.js";

type CodecImplementation = {id:string;version:string;operation:string;ffmpeg:string;tool:ToolIdentity;ffprobe?:string;algorithm?:string};
type CodecRuntime = { ffmpeg: string; ffprobe: string };
export type ImageCodecInvocation = { parameters?:unknown; inputs?:unknown; runtime?:unknown };
type ToolOptions = { input?:Uint8Array; text?:boolean; label:string };
import { LINEAR_RGBA8_IMAGE_MEDIA_TYPE, parseLinearRgba8Image } from "./image-linear-rgba8.js";
import type { AssetRef } from "./operations.js";
const VERSION = "1";
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const STANDARD_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
];

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "image.decode",
    version: VERSION,
    label: "Decode standard image",
    description:
      "Decode one standard still image through an explicit FFmpeg runtime into canonical straight-alpha sRGB RGBA8 bytes.",
    category: "image.codec",
    inputs: [
      {
        id: "source",
        label: "Encoded image",
        assetKinds: ["image"],
        mediaTypes: STANDARD_IMAGE_MEDIA_TYPES,
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Canonical RGBA8 image",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: "image.encode.png",
    version: VERSION,
    label: "Encode canonical image as PNG",
    description:
      "Encode canonical straight-alpha sRGB or linear RGBA8 channel bytes as one deterministic PNG without a transfer, under an explicit FFmpeg runtime identity.",
    category: "image.codec",
    inputs: [
      {
        id: "source",
        label: "Canonical RGBA8 image",
        assetKinds: ["image"],
        mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE, LINEAR_RGBA8_IMAGE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "PNG image",
        assetKinds: ["image"],
        mediaTypes: ["image/png"],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["compressionLevel"],
      properties: { compressionLevel: { type: "integer", minimum: 0, maximum: 9 } },
    },
  },
]);

export const IMAGE_DECODE_OPERATION = OPERATION_REGISTRY.get("image.decode", VERSION)!;
export const IMAGE_ENCODE_PNG_OPERATION = OPERATION_REGISTRY.get("image.encode.png", VERSION)!;
export const IMAGE_CODEC_OPERATIONS = OPERATION_REGISTRY.list();

function assertRoot(root: string) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("image codec operation root must be an absolute path");
  }
  return root;
}

function normalizeRuntime(runtime: unknown = {}) {
  if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) {
    throw new Error("image codec runtime must be an object");
  }
  const allowed = new Set(["ffmpeg", "ffprobe"]);
  for (const key of Object.keys(runtime)) {
    if (!allowed.has(key)) throw new Error(`image codec runtime contains unknown field '${key}'`);
  }
  const executable = (value: unknown, fallback: string, location: string) => {
    const resolved = value ?? fallback;
    if (typeof resolved !== "string" || resolved.trim().length === 0) {
      throw new Error(`${location} must be a non-empty executable name or path`);
    }
    return resolved;
  };
  return {
    ffmpeg: executable("ffmpeg" in runtime ? runtime.ffmpeg : undefined, "ffmpeg", "runtime.ffmpeg"),
    ffprobe: executable("ffprobe" in runtime ? runtime.ffprobe : undefined, "ffprobe", "runtime.ffprobe"),
  };
}

function runTool(executable:string,args:string[],options:ToolOptions & {text:true}):string;
function runTool(executable:string,args:string[],options:ToolOptions & {text?:false}):Buffer;
function runTool(executable:string,args:string[],{input,text=false,label}:ToolOptions):string|Buffer {
  const result = spawnSync(executable, args, {
    input,
    encoding: text ? "utf8" : undefined,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${label} could not execute '${executable}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : String(result.stderr ?? "").trim();
    throw new Error(
      stderr.length > 0
        ? `${label} failed with status ${result.status}: ${stderr}`
        : `${label} failed with status ${result.status}`,
    );
  }
  return result.stdout;
}

function toolVersion(executable:string, label:string) {
  const stdout = runTool(executable, ["-version"], { text: true, label: `${label} version probe` });
  const firstLine = String(stdout).split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw new Error(`${label} version probe returned no identity`);
  return firstLine;
}

export async function probeImageCodecImplementation(operation:ReadonlyAssetOperationDescriptor,runtime:unknown) {
  if(operation.id!=="image.decode" && operation.id!=="image.encode.png") throw new Error("unsupported image codec operation identity");
  const normalizedRuntime = normalizeRuntime(runtime);
  const implementation: CodecImplementation = {
    id: "external.ffmpeg.image-codec",
    version: VERSION,
    operation: operation.id,
    ffmpeg: toolVersion(normalizedRuntime.ffmpeg, "ffmpeg"),
    tool: await captureToolIdentity(),
  };
  if (operation.id === "image.decode") {
    implementation.ffprobe = toolVersion(normalizedRuntime.ffprobe, "ffprobe");
    implementation.algorithm = "ffprobe-dimensions-ffmpeg-rgba8-v1";
  } else {
    implementation.version = "3";
    implementation.algorithm = "ffmpeg-rgba8-byte-preserving-square-pixel-png-image2pipe-v3";
  }
  return { implementation, runtime: normalizedRuntime };
}

function normalizeDecodeParameters(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image.decode parameters must be an object");
  }
  if (Object.keys(value).length !== 0) {
    throw new Error("image.decode parameters do not accept fields");
  }
  return {};
}

function normalizeEncodeParameters(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image.encode.png parameters must be an object");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "compressionLevel") {
    throw new Error("image.encode.png parameters must contain only compressionLevel");
  }
  if (!("compressionLevel" in value) || typeof value.compressionLevel !== "number" || !Number.isSafeInteger(value.compressionLevel) || value.compressionLevel < 0 || value.compressionLevel > 9) {
    throw new Error("parameters.compressionLevel must be an integer in 0..9");
  }
  return { compressionLevel: value.compressionLevel };
}

function pngInput(source:AssetRef,bytes:Uint8Array) {
  switch(source.mediaType) {
    case RGBA8_IMAGE_MEDIA_TYPE:return parseRgba8Image(bytes);
    case LINEAR_RGBA8_IMAGE_MEDIA_TYPE:return parseLinearRgba8Image(bytes);
    default:throw new Error("PNG encode requires canonical sRGB or linear RGBA8 input");
  }
}

async function createBuildIdentity(root:string,operation:ReadonlyAssetOperationDescriptor,parameters:unknown,inputs:unknown,runtime:unknown) {
  const assetRoot = assertRoot(root);
  const identity = await probeImageCodecImplementation(operation, runtime);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: identity.implementation,
    parameters,
    inputs,
  });
  const source=createAssetRef(build.inputs.source);
  const sourceBytes = await resolveAssetObject(assetRoot, source);
  if (operation.id === "image.encode.png") pngInput(source,sourceBytes);
  return { assetRoot, build, runtime: identity.runtime, source, sourceBytes };
}

function probeDimensions(runtime:CodecRuntime,sourceBytes:Buffer) {
  const stdout = runTool(
    runtime.ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      "pipe:0",
    ],
    { input: sourceBytes, text: true, label: "image dimension probe" },
  );
  let parsed:unknown;
  try {
    parsed = JSON.parse(String(stdout));
  } catch (error) {
    throw new Error(`image dimension probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stream = parsed && typeof parsed === "object" && "streams" in parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : undefined;
  const width:unknown = stream?.width;
  const height:unknown = stream?.height;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error("image dimension probe did not return positive integer dimensions");
  }
  if (width > 8192 || height > 8192) {
    throw new Error(`decoded image dimensions ${width}x${height} exceed the canonical 8192 limit`);
  }
  return { width, height };
}

export async function createImageDecodeOperationBuildIdentity(
  root:string,
  { parameters = {}, inputs = {}, runtime = {} }:ImageCodecInvocation = {},
) {
  const prepared = await createBuildIdentity(
    root,
    IMAGE_DECODE_OPERATION,
    normalizeDecodeParameters(parameters),
    inputs,
    runtime,
  );
  return prepared.build;
}

export async function executeImageDecodeOperation(
  root:string,
  { parameters = {}, inputs = {}, runtime = {} }:ImageCodecInvocation = {},
) {
  const prepared = await createBuildIdentity(
    root,
    IMAGE_DECODE_OPERATION,
    normalizeDecodeParameters(parameters),
    inputs,
    runtime,
  );
  const dimensions = probeDimensions(prepared.runtime, prepared.sourceBytes);
  const rgba = runTool(
    prepared.runtime.ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      "pipe:0",
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { input: prepared.sourceBytes, label: "image decode" },
  );
  const expectedLength = dimensions.width * dimensions.height * 4;
  if (rgba.length !== expectedLength) {
    throw new Error(`image decode produced ${rgba.length} RGBA bytes; expected ${expectedLength}`);
  }
  const canonicalBytes = encodeRgba8Image({
    ...dimensions,
    pixels: new Uint8Array(rgba),
  });
  const stored = await storeAssetObject(prepared.assetRoot, {
    bytes: canonicalBytes,
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      ...dimensions,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
      sourceSha256: prepared.source.sha256,
    },
  });
  return normalizeAssetOperationResult(IMAGE_DECODE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      ...dimensions,
      sourceMediaType: prepared.source.mediaType,
      algorithm: prepared.build.implementation.algorithm,
    },
  });
}

export async function createImageEncodePngOperationBuildIdentity(
  root:string,
  { parameters = { compressionLevel: 9 }, inputs = {}, runtime = {} }:ImageCodecInvocation = {},
) {
  const prepared = await createBuildIdentity(
    root,
    IMAGE_ENCODE_PNG_OPERATION,
    normalizeEncodeParameters(parameters),
    inputs,
    runtime,
  );
  return prepared.build;
}

export async function executeImageEncodePngOperation(
  root:string,
  { parameters = { compressionLevel: 9 }, inputs = {}, runtime = {} }:ImageCodecInvocation = {},
) {
  const prepared = await createBuildIdentity(
    root,
    IMAGE_ENCODE_PNG_OPERATION,
    normalizeEncodeParameters(parameters),
    inputs,
    runtime,
  );
  const image = pngInput(prepared.source,prepared.sourceBytes);
  const png = runTool(
    prepared.runtime.ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s:v",
      `${image.width}x${image.height}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-vf",
      "setsar=1",
      "-c:v",
      "png",
      "-compression_level",
      String(prepared.build.parameters.compressionLevel),
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { input: image.pixels, label: "PNG encode" },
  );
  const stored = await storeAssetObject(prepared.assetRoot, {
    bytes: png,
    kind: "image",
    mediaType: "image/png",
    metadata: {
      width: image.width,
      height: image.height,
      sourceSha256: prepared.source.sha256,
      codec: "png",
      sourceColorSpace: image.colorSpace,
    },
  });
  return normalizeAssetOperationResult(IMAGE_ENCODE_PNG_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      width: image.width,
      height: image.height,
      compressionLevel: prepared.build.parameters.compressionLevel,
      algorithm: prepared.build.implementation.algorithm,
    },
  });
}
