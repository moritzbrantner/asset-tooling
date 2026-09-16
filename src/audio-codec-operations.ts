import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  AUDIO_MAX_FRAME_COUNT,
  CANONICAL_AUDIO_MEDIA_TYPE,
  createCanonicalAudioMetadata,
  encodeCanonicalPcm16Wav,
} from "./audio.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const STANDARD_AUDIO_MEDIA_TYPES = [
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
];

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "audio.decode",
    version: VERSION,
    label: "Decode standard audio",
    description:
      "Decode one standard audio stream through an explicit FFmpeg runtime into canonical PCM signed-16 little-endian WAV bytes.",
    category: "audio.codec",
    inputs: [
      {
        id: "source",
        label: "Encoded audio",
        assetKinds: ["audio"],
        mediaTypes: STANDARD_AUDIO_MEDIA_TYPES,
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Canonical PCM audio",
        assetKinds: ["audio"],
        mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sampleRate", "channels"],
      properties: {
        sampleRate: { type: "integer", minimum: 8000, maximum: 192000 },
        channels: { type: "integer", enum: [1, 2] },
      },
    },
  },
]);

export const AUDIO_DECODE_OPERATION = OPERATION_REGISTRY.get("audio.decode", VERSION);
export const AUDIO_CODEC_OPERATIONS = OPERATION_REGISTRY.list();

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("audio codec operation root must be an absolute path");
  }
  return root;
}

function normalizeParameters(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("audio.decode parameters must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "channels" || keys[1] !== "sampleRate") {
    throw new Error("audio.decode parameters must contain only sampleRate and channels");
  }
  if (!Number.isSafeInteger(value.sampleRate) || value.sampleRate < 8_000 || value.sampleRate > 192_000) {
    throw new Error("parameters.sampleRate must be an integer in 8000..192000");
  }
  if (![1, 2].includes(value.channels)) {
    throw new Error("parameters.channels must be 1 or 2");
  }
  return { sampleRate: value.sampleRate, channels: value.channels };
}

function normalizeRuntime(runtime = {}) {
  if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) {
    throw new Error("audio codec runtime must be an object");
  }
  for (const key of Object.keys(runtime)) {
    if (key !== "ffmpeg") throw new Error(`audio codec runtime contains unknown field '${key}'`);
  }
  const ffmpeg = runtime.ffmpeg ?? "ffmpeg";
  if (typeof ffmpeg !== "string" || ffmpeg.trim().length === 0) {
    throw new Error("runtime.ffmpeg must be a non-empty executable name or path");
  }
  return { ffmpeg };
}

function runFfmpeg(executable, args, input, label, { text = false } = {}) {
  const result = spawnSync(executable, args, {
    input,
    encoding: text ? "utf8" : undefined,
    maxBuffer: MAX_OUTPUT_BYTES,
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

function ffmpegVersion(executable) {
  const output = runFfmpeg(executable, ["-version"], undefined, "ffmpeg version probe", { text: true });
  const firstLine = String(output).split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw new Error("ffmpeg version probe returned no identity");
  return firstLine;
}

async function implementationIdentity(runtime) {
  return {
    id: "external.ffmpeg.audio-codec",
    version: VERSION,
    algorithm: "ffmpeg-decode-s16le-explicit-rate-channels-v1",
    ffmpeg: ffmpegVersion(runtime.ffmpeg),
    tool: await captureToolIdentity(),
  };
}

async function prepare(root, { parameters = {}, inputs = {}, runtime = {} } = {}) {
  const assetRoot = assertRoot(root);
  const normalizedParameters = normalizeParameters(parameters);
  const normalizedRuntime = normalizeRuntime(runtime);
  const build = createAssetOperationBuildIdentity({
    operation: AUDIO_DECODE_OPERATION,
    implementation: await implementationIdentity(normalizedRuntime),
    parameters: normalizedParameters,
    inputs,
  });
  const sourceBytes = await resolveAssetObject(assetRoot, build.inputs.source);
  return { assetRoot, build, runtime: normalizedRuntime, sourceBytes };
}

export async function createAudioDecodeOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {}, runtime = {} } = {},
) {
  const prepared = await prepare(root, { parameters, inputs, runtime });
  return prepared.build;
}

export async function executeAudioDecodeOperation(
  root,
  { parameters = {}, inputs = {}, runtime = {} } = {},
) {
  const prepared = await prepare(root, { parameters, inputs, runtime });
  const raw = runFfmpeg(
    prepared.runtime.ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      "pipe:0",
      "-map",
      "0:a:0",
      "-vn",
      "-map_metadata",
      "-1",
      "-ac",
      String(prepared.build.parameters.channels),
      "-ar",
      String(prepared.build.parameters.sampleRate),
      "-sample_fmt",
      "s16",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-f",
      "s16le",
      "pipe:1",
    ],
    prepared.sourceBytes,
    "audio decode",
  );
  const bytesPerFrame = prepared.build.parameters.channels * 2;
  if (raw.length % bytesPerFrame !== 0) {
    throw new Error(`audio decode produced ${raw.length} bytes that do not align to complete PCM frames`);
  }
  const frameCount = raw.length / bytesPerFrame;
  if (frameCount > AUDIO_MAX_FRAME_COUNT) {
    throw new Error(`decoded audio frameCount ${frameCount} exceeds ${AUDIO_MAX_FRAME_COUNT}`);
  }
  const sampleCount = raw.length / 2;
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = raw.readInt16LE(index * 2);
  }
  const audio = {
    sampleRate: prepared.build.parameters.sampleRate,
    channels: prepared.build.parameters.channels,
    samples,
  };
  const encoded = encodeCanonicalPcm16Wav(audio);
  const metadata = createCanonicalAudioMetadata({
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    frameCount: encoded.frameCount,
    operation: { id: AUDIO_DECODE_OPERATION.id, version: AUDIO_DECODE_OPERATION.version },
    inputs: [{ port: "source", sha256: prepared.build.inputs.source.sha256 }],
  });
  const stored = await storeAssetObject(prepared.assetRoot, {
    bytes: encoded.bytes,
    kind: "audio",
    mediaType: CANONICAL_AUDIO_MEDIA_TYPE,
    metadata,
  });
  return normalizeAssetOperationResult(AUDIO_DECODE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      sourceMediaType: prepared.build.inputs.source.mediaType,
      codec: "pcm-s16le",
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      frameCount: encoded.frameCount,
      algorithm: prepared.build.implementation.algorithm,
    },
  });
}
