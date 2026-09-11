import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  applyAudioFade,
  applyAudioGain,
  assertCanonicalAudioBytes,
  audioFrameCount,
  CANONICAL_AUDIO_MEDIA_TYPE,
  convertAudioChannels,
  createCanonicalAudioMetadata,
  decodePcmWav,
  encodeCanonicalPcm16Wav,
  mixAudio,
  normalizeCanonicalAudioAssetRef,
  resampleAudio,
  synthesizeAudio,
  trimAudio,
} from "./audio.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  createAssetRef,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const AUDIO_ENGINE_ID = "builtin.audio.pcm16";
const AUDIO_ENGINE_VERSION = "1";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertInteger(value, location, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function validateNormalizeParameters(value) {
  const parameters = assertObject(value ?? {}, "audio.normalize parameters");
  assertExactKeys(parameters, new Set(["sampleRate", "channels"]), "audio.normalize parameters");
  if (parameters.sampleRate !== undefined) assertInteger(parameters.sampleRate, "audio.normalize sampleRate", 8_000, 192_000);
  if (parameters.channels !== undefined) assertInteger(parameters.channels, "audio.normalize channels", 1, 2);
  return parameters;
}

function validateTrimParameters(value) {
  const parameters = assertObject(value, "audio.trim parameters");
  assertExactKeys(parameters, new Set(["startFrame", "endFrame"]), "audio.trim parameters");
  assertInteger(parameters.startFrame, "audio.trim startFrame", 0);
  assertInteger(parameters.endFrame, "audio.trim endFrame", 0);
  if (parameters.endFrame < parameters.startFrame) throw new Error("audio.trim endFrame must be >= startFrame");
  return parameters;
}

function validateResampleParameters(value) {
  const parameters = assertObject(value, "audio.resample parameters");
  assertExactKeys(parameters, new Set(["sampleRate"]), "audio.resample parameters");
  assertInteger(parameters.sampleRate, "audio.resample sampleRate", 8_000, 192_000);
  return parameters;
}

function validateChannelsParameters(value) {
  const parameters = assertObject(value, "audio.channels parameters");
  assertExactKeys(parameters, new Set(["channels"]), "audio.channels parameters");
  assertInteger(parameters.channels, "audio.channels channels", 1, 2);
  return parameters;
}

function validateGainParameters(value) {
  const parameters = assertObject(value, "audio.gain parameters");
  assertExactKeys(parameters, new Set(["numerator", "denominator"]), "audio.gain parameters");
  assertInteger(parameters.numerator, "audio.gain numerator", -160_000, 160_000);
  assertInteger(parameters.denominator, "audio.gain denominator", 1, 10_000);
  return parameters;
}

function validateFadeParameters(value) {
  const parameters = assertObject(value, "audio.fade parameters");
  assertExactKeys(parameters, new Set(["fadeInFrames", "fadeOutFrames"]), "audio.fade parameters");
  assertInteger(parameters.fadeInFrames, "audio.fade fadeInFrames", 0);
  assertInteger(parameters.fadeOutFrames, "audio.fade fadeOutFrames", 0);
  return parameters;
}

function validateSynthesisParameters(value) {
  const parameters = assertObject(value, "audio.synthesize parameters");
  assertExactKeys(
    parameters,
    new Set(["waveform", "sampleRate", "channels", "frameCount", "frequencyHz", "amplitude", "seed"]),
    "audio.synthesize parameters",
  );
  if (!["silence", "square", "saw", "noise"].includes(parameters.waveform)) {
    throw new Error("audio.synthesize waveform must be silence, square, saw, or noise");
  }
  const sampleRate = assertInteger(parameters.sampleRate, "audio.synthesize sampleRate", 8_000, 192_000);
  assertInteger(parameters.channels, "audio.synthesize channels", 1, 2);
  assertInteger(parameters.frameCount, "audio.synthesize frameCount", 0, 10_000_000);
  if (parameters.amplitude !== undefined) assertInteger(parameters.amplitude, "audio.synthesize amplitude", 0, 32767);
  if (["square", "saw"].includes(parameters.waveform)) {
    assertInteger(parameters.frequencyHz, "audio.synthesize frequencyHz", 1, Math.floor(sampleRate / 2));
    if (parameters.seed !== undefined) throw new Error(`${parameters.waveform} synthesis does not accept seed`);
  } else {
    if (parameters.frequencyHz !== undefined) throw new Error(`${parameters.waveform} synthesis does not accept frequencyHz`);
    if (parameters.waveform === "noise") {
      if (typeof parameters.seed !== "string" || !/^(0|[1-9][0-9]*)$/.test(parameters.seed)) {
        throw new Error("audio.synthesize noise seed must be a non-negative decimal integer string");
      }
    } else if (parameters.seed !== undefined) {
      throw new Error(`${parameters.waveform} synthesis does not accept seed`);
    }
  }
  return parameters;
}

function validateMixParameters(value, sourceCount) {
  const parameters = assertObject(value, "audio.mix parameters");
  assertExactKeys(parameters, new Set(["tracks"]), "audio.mix parameters");
  if (!Array.isArray(parameters.tracks) || parameters.tracks.length !== sourceCount) {
    throw new Error("audio.mix tracks must contain one placement per source");
  }
  parameters.tracks.forEach((trackValue, index) => {
    const track = assertObject(trackValue, `audio.mix tracks[${index}]`);
    assertExactKeys(
      track,
      new Set(["startFrame", "gainNumerator", "gainDenominator"]),
      `audio.mix tracks[${index}]`,
    );
    assertInteger(track.startFrame, `audio.mix tracks[${index}].startFrame`, 0, 10_000_000);
    if (track.gainNumerator !== undefined) {
      assertInteger(track.gainNumerator, `audio.mix tracks[${index}].gainNumerator`, -160_000, 160_000);
    }
    if (track.gainDenominator !== undefined) {
      assertInteger(track.gainDenominator, `audio.mix tracks[${index}].gainDenominator`, 1, 10_000);
    }
  });
  return parameters;
}

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "audio.normalize",
    version: VERSION,
    label: "Normalize audio",
    description: "Decode supported PCM WAV input and emit canonical PCM signed-16 little-endian WAV bytes.",
    category: "audio.processing",
    inputs: [{ id: "source", label: "Source", assetKinds: ["audio"], mediaTypes: ["audio/wav"] }],
    outputs: [{ id: "output", label: "Audio", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sampleRate: { type: "integer", minimum: 8000, maximum: 192000 },
        channels: { type: "integer", enum: [1, 2] },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "audio.synthesize",
    version: VERSION,
    label: "Synthesize audio",
    description: "Generate deterministic sample-index-driven PCM audio from explicit waveform parameters.",
    category: "procedural.audio",
    inputs: [],
    outputs: [{ id: "output", label: "Audio", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["waveform", "sampleRate", "channels", "frameCount"],
      properties: {
        waveform: { enum: ["silence", "square", "saw", "noise"] },
        sampleRate: { type: "integer", minimum: 8000, maximum: 192000 },
        channels: { type: "integer", enum: [1, 2] },
        frameCount: { type: "integer", minimum: 0, maximum: 10000000 },
        frequencyHz: { type: "integer", minimum: 1, maximum: 96000 },
        amplitude: { type: "integer", minimum: 0, maximum: 32767 },
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
      },
      oneOf: [
        {
          properties: { waveform: { const: "silence" } },
          not: { anyOf: [{ required: ["frequencyHz"] }, { required: ["seed"] }] },
        },
        {
          properties: { waveform: { const: "square" } },
          required: ["frequencyHz"],
          not: { required: ["seed"] },
        },
        {
          properties: { waveform: { const: "saw" } },
          required: ["frequencyHz"],
          not: { required: ["seed"] },
        },
        {
          properties: { waveform: { const: "noise" } },
          required: ["seed"],
          not: { required: ["frequencyHz"] },
        },
      ],
    },
  },
  {
    schemaVersion: 1,
    id: "audio.trim",
    version: VERSION,
    label: "Trim audio",
    category: "audio.processing",
    inputs: [{ id: "source", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    outputs: [{ id: "output", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["startFrame", "endFrame"],
      properties: {
        startFrame: { type: "integer", minimum: 0 },
        endFrame: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "audio.resample",
    version: VERSION,
    label: "Resample audio",
    category: "audio.processing",
    inputs: [{ id: "source", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    outputs: [{ id: "output", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sampleRate"],
      properties: { sampleRate: { type: "integer", minimum: 8000, maximum: 192000 } },
    },
  },
  {
    schemaVersion: 1,
    id: "audio.channels",
    version: VERSION,
    label: "Map audio channels",
    category: "audio.processing",
    inputs: [{ id: "source", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    outputs: [{ id: "output", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channels"],
      properties: { channels: { type: "integer", enum: [1, 2] } },
    },
  },
  {
    schemaVersion: 1,
    id: "audio.gain",
    version: VERSION,
    label: "Apply audio gain",
    category: "audio.processing",
    inputs: [{ id: "source", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    outputs: [{ id: "output", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["numerator", "denominator"],
      properties: {
        numerator: { type: "integer", minimum: -160000, maximum: 160000 },
        denominator: { type: "integer", minimum: 1, maximum: 10000 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "audio.fade",
    version: VERSION,
    label: "Fade audio",
    category: "audio.processing",
    inputs: [{ id: "source", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    outputs: [{ id: "output", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fadeInFrames", "fadeOutFrames"],
      properties: {
        fadeInFrames: { type: "integer", minimum: 0 },
        fadeOutFrames: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "audio.mix",
    version: VERSION,
    label: "Mix audio",
    description: "Offline deterministic mix of already-normalized audio assets with explicit frame offsets and rational gain.",
    category: "audio.composition",
    inputs: [
      {
        id: "sources",
        assetKinds: ["audio"],
        mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE],
        cardinality: { min: 1, max: 32 },
      },
    ],
    outputs: [{ id: "output", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] }],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tracks"],
      properties: {
        tracks: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["startFrame"],
            properties: {
              startFrame: { type: "integer", minimum: 0 },
              gainNumerator: { type: "integer", minimum: -160000, maximum: 160000 },
              gainDenominator: { type: "integer", minimum: 1, maximum: 10000 },
            },
          },
        },
      },
    },
  },
]);

export const AUDIO_NORMALIZE_OPERATION = OPERATION_REGISTRY.get("audio.normalize", VERSION);
export const AUDIO_SYNTHESIZE_OPERATION = OPERATION_REGISTRY.get("audio.synthesize", VERSION);
export const AUDIO_TRIM_OPERATION = OPERATION_REGISTRY.get("audio.trim", VERSION);
export const AUDIO_RESAMPLE_OPERATION = OPERATION_REGISTRY.get("audio.resample", VERSION);
export const AUDIO_CHANNELS_OPERATION = OPERATION_REGISTRY.get("audio.channels", VERSION);
export const AUDIO_GAIN_OPERATION = OPERATION_REGISTRY.get("audio.gain", VERSION);
export const AUDIO_FADE_OPERATION = OPERATION_REGISTRY.get("audio.fade", VERSION);
export const AUDIO_MIX_OPERATION = OPERATION_REGISTRY.get("audio.mix", VERSION);
export const AUDIO_OPERATIONS = OPERATION_REGISTRY.list();

async function implementationIdentity() {
  return {
    id: AUDIO_ENGINE_ID,
    version: AUDIO_ENGINE_VERSION,
    algorithm: "integer-pcm16-v1",
    tool: await captureToolIdentity(),
  };
}

async function buildIdentity(operation, parameters, inputs) {
  return createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(),
    parameters,
    inputs,
  });
}

async function decodeCanonicalInput(root, assetValue) {
  const asset = normalizeCanonicalAudioAssetRef(assetValue);
  const bytes = await resolveAssetObject(root, asset);
  return { asset, audio: assertCanonicalAudioBytes(bytes, asset.metadata) };
}

async function storeCanonicalOutput(root, operation, audio, inputs = []) {
  const encoded = encodeCanonicalPcm16Wav(audio);
  const metadata = createCanonicalAudioMetadata({
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    frameCount: encoded.frameCount,
    operation: { id: operation.id, version: operation.version },
    inputs,
  });
  return storeAssetObject(root, {
    bytes: encoded.bytes,
    kind: "audio",
    mediaType: CANONICAL_AUDIO_MEDIA_TYPE,
    metadata,
  });
}

function standardObservations(audio) {
  return {
    codec: "pcm-s16le",
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    frameCount: audioFrameCount(audio),
  };
}

export async function createAudioNormalizeOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  validateNormalizeParameters(parameters);
  return buildIdentity(AUDIO_NORMALIZE_OPERATION, parameters, inputs);
}

export async function executeAudioNormalizeOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioNormalizeOperationBuildIdentity({ parameters, inputs });
  const source = createAssetRef(build.inputs.source);
  const sourceBytes = await resolveAssetObject(root, source);
  const decoded = decodePcmWav(sourceBytes);
  const targetSampleRate = build.parameters.sampleRate ?? decoded.sampleRate;
  const targetChannels = build.parameters.channels ?? decoded.channels;
  const resampled = resampleAudio(decoded, targetSampleRate);
  const normalized = convertAudioChannels(resampled, targetChannels);
  const stored = await storeCanonicalOutput(root, AUDIO_NORMALIZE_OPERATION, normalized, [
    { port: "source", sha256: source.sha256 },
  ]);
  return normalizeAssetOperationResult(AUDIO_NORMALIZE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      sourceBitsPerSample: decoded.sourceBitsPerSample,
      sourceSampleRate: decoded.sampleRate,
      sourceChannels: decoded.channels,
      ...standardObservations(normalized),
      resampled: decoded.sampleRate !== targetSampleRate,
      channelConverted: decoded.channels !== targetChannels,
    },
  });
}

export async function createAudioSynthesizeOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  validateSynthesisParameters(parameters);
  return buildIdentity(AUDIO_SYNTHESIZE_OPERATION, parameters, inputs);
}

export async function executeAudioSynthesizeOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioSynthesizeOperationBuildIdentity({ parameters, inputs });
  const audio = synthesizeAudio(build.parameters);
  const stored = await storeCanonicalOutput(root, AUDIO_SYNTHESIZE_OPERATION, audio);
  return normalizeAssetOperationResult(AUDIO_SYNTHESIZE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      algorithm: "sample-index-waveform-v1",
      waveform: build.parameters.waveform,
      ...(build.parameters.seed === undefined ? {} : { seed: build.parameters.seed }),
      ...standardObservations(audio),
    },
  });
}

export async function createAudioTrimOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  validateTrimParameters(parameters);
  return buildIdentity(AUDIO_TRIM_OPERATION, parameters, inputs);
}

export async function executeAudioTrimOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioTrimOperationBuildIdentity({ parameters, inputs });
  const source = await decodeCanonicalInput(root, build.inputs.source);
  const audio = trimAudio(source.audio, build.parameters.startFrame, build.parameters.endFrame);
  const stored = await storeCanonicalOutput(root, AUDIO_TRIM_OPERATION, audio, [
    { port: "source", sha256: source.asset.sha256 },
  ]);
  return normalizeAssetOperationResult(AUDIO_TRIM_OPERATION, {
    outputs: { output: stored.asset },
    observations: { ...standardObservations(audio), startFrame: build.parameters.startFrame, endFrame: build.parameters.endFrame },
  });
}

export async function createAudioResampleOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  validateResampleParameters(parameters);
  return buildIdentity(AUDIO_RESAMPLE_OPERATION, parameters, inputs);
}

export async function executeAudioResampleOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioResampleOperationBuildIdentity({ parameters, inputs });
  const source = await decodeCanonicalInput(root, build.inputs.source);
  const audio = resampleAudio(source.audio, build.parameters.sampleRate);
  const stored = await storeCanonicalOutput(root, AUDIO_RESAMPLE_OPERATION, audio, [
    { port: "source", sha256: source.asset.sha256 },
  ]);
  return normalizeAssetOperationResult(AUDIO_RESAMPLE_OPERATION, {
    outputs: { output: stored.asset },
    observations: { sourceSampleRate: source.audio.sampleRate, ...standardObservations(audio), algorithm: "linear-fixed-v1" },
  });
}

export async function createAudioChannelsOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  validateChannelsParameters(parameters);
  return buildIdentity(AUDIO_CHANNELS_OPERATION, parameters, inputs);
}

export async function executeAudioChannelsOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioChannelsOperationBuildIdentity({ parameters, inputs });
  const source = await decodeCanonicalInput(root, build.inputs.source);
  const audio = convertAudioChannels(source.audio, build.parameters.channels);
  const stored = await storeCanonicalOutput(root, AUDIO_CHANNELS_OPERATION, audio, [
    { port: "source", sha256: source.asset.sha256 },
  ]);
  return normalizeAssetOperationResult(AUDIO_CHANNELS_OPERATION, {
    outputs: { output: stored.asset },
    observations: { sourceChannels: source.audio.channels, ...standardObservations(audio), algorithm: "mono-stereo-fixed-v1" },
  });
}

export async function createAudioGainOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  validateGainParameters(parameters);
  return buildIdentity(AUDIO_GAIN_OPERATION, parameters, inputs);
}

export async function executeAudioGainOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioGainOperationBuildIdentity({ parameters, inputs });
  const source = await decodeCanonicalInput(root, build.inputs.source);
  const audio = applyAudioGain(source.audio, build.parameters.numerator, build.parameters.denominator);
  const stored = await storeCanonicalOutput(root, AUDIO_GAIN_OPERATION, audio, [
    { port: "source", sha256: source.asset.sha256 },
  ]);
  return normalizeAssetOperationResult(AUDIO_GAIN_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      ...standardObservations(audio),
      gainNumerator: build.parameters.numerator,
      gainDenominator: build.parameters.denominator,
      clipping: "saturate-int16",
    },
  });
}

export async function createAudioFadeOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  validateFadeParameters(parameters);
  return buildIdentity(AUDIO_FADE_OPERATION, parameters, inputs);
}

export async function executeAudioFadeOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioFadeOperationBuildIdentity({ parameters, inputs });
  const source = await decodeCanonicalInput(root, build.inputs.source);
  const audio = applyAudioFade(source.audio, build.parameters.fadeInFrames, build.parameters.fadeOutFrames);
  const stored = await storeCanonicalOutput(root, AUDIO_FADE_OPERATION, audio, [
    { port: "source", sha256: source.asset.sha256 },
  ]);
  return normalizeAssetOperationResult(AUDIO_FADE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      ...standardObservations(audio),
      fadeInFrames: build.parameters.fadeInFrames,
      fadeOutFrames: build.parameters.fadeOutFrames,
      algorithm: "linear-frame-fade-v1",
    },
  });
}

export async function createAudioMixOperationBuildIdentity({ parameters = {}, inputs = {} } = {}) {
  const sourceCount = Array.isArray(inputs.sources) ? inputs.sources.length : 0;
  validateMixParameters(parameters, sourceCount);
  return buildIdentity(AUDIO_MIX_OPERATION, parameters, inputs);
}

export async function executeAudioMixOperation(root, { parameters = {}, inputs = {} } = {}) {
  const build = await createAudioMixOperationBuildIdentity({ parameters, inputs });
  const sources = await Promise.all(build.inputs.sources.map((asset) => decodeCanonicalInput(root, asset)));
  const audio = mixAudio(
    sources.map((source) => source.audio),
    build.parameters.tracks,
  );
  const stored = await storeCanonicalOutput(
    root,
    AUDIO_MIX_OPERATION,
    audio,
    sources.map((source) => ({ port: "sources", sha256: source.asset.sha256 })),
  );
  return normalizeAssetOperationResult(AUDIO_MIX_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      ...standardObservations(audio),
      orderedInputSha256: sources.map((source) => source.asset.sha256),
      trackCount: sources.length,
      clipping: "saturate-int16-after-sum",
    },
  });
}
