import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  assertCanonicalAudioBytes,
  audioFrameCount,
  CANONICAL_AUDIO_MEDIA_TYPE,
  createCanonicalAudioMetadata,
  encodeCanonicalPcm16Wav,
  normalizeCanonicalAudioAssetRef,
  validateAudioBuffer,
} from "./audio.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_FRAME_COUNT = 10_000_000;
const Q15_FULL_SCALE = 32767;
const SINE_PHASE_STEPS = 128;
const SINE_QUARTER_Q15 = Object.freeze([
  0, 1608, 3212, 4808, 6393, 7962, 9512, 11039, 12539, 14010, 15446,
  16846, 18204, 19519, 20787, 22005, 23170, 24279, 25329, 26319, 27245,
  28105, 28898, 29621, 30273, 30852, 31356, 31785, 32137, 32412, 32609,
  32728, 32767,
]);

const audioOutput = {
  id: "output",
  label: "Audio",
  assetKinds: ["audio"],
  mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE],
};
const audioInput = {
  id: "source",
  label: "Source",
  assetKinds: ["audio"],
  mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "audio.adsr",
    version: VERSION,
    label: "Apply ADSR envelope",
    description:
      "Apply a sample-exact Q15 attack/decay/sustain/release amplitude envelope to canonical PCM16 audio.",
    category: "audio.processing",
    inputs: [audioInput],
    outputs: [audioOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["attackFrames", "decayFrames", "sustainLevelQ15", "releaseFrames"],
      properties: {
        attackFrames: { type: "integer", minimum: 0, maximum: MAX_FRAME_COUNT },
        decayFrames: { type: "integer", minimum: 0, maximum: MAX_FRAME_COUNT },
        sustainLevelQ15: { type: "integer", minimum: 0, maximum: Q15_FULL_SCALE },
        releaseFrames: { type: "integer", minimum: 0, maximum: MAX_FRAME_COUNT },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "audio.oscillator",
    version: VERSION,
    label: "Generate oscillator audio",
    description:
      "Generate deterministic sine or triangle PCM16 audio from rational sample phase with zero initial phase.",
    category: "procedural.audio",
    inputs: [],
    outputs: [audioOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["waveform", "sampleRate", "channels", "frameCount", "frequencyHz", "amplitude"],
      properties: {
        waveform: { type: "string", enum: ["sine", "triangle"] },
        sampleRate: { type: "integer", minimum: 8000, maximum: 192000 },
        channels: { type: "integer", enum: [1, 2] },
        frameCount: { type: "integer", minimum: 0, maximum: MAX_FRAME_COUNT },
        frequencyHz: { type: "integer", minimum: 1, maximum: 96000 },
        amplitude: { type: "integer", minimum: 0, maximum: Q15_FULL_SCALE },
      },
    },
  },
]);

export const AUDIO_ADSR_OPERATION = OPERATION_REGISTRY.get("audio.adsr", VERSION);
export const AUDIO_OSCILLATOR_OPERATION = OPERATION_REGISTRY.get("audio.oscillator", VERSION);
export const PROCEDURAL_AUDIO_OPERATIONS = OPERATION_REGISTRY.list();

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, location) {
  const object = plainObject(value, location);
  const expected = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return object;
}

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function roundRatioSigned(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("audio fixed-point ratio requires a safe integer numerator and positive denominator");
  }
  const half = Math.floor(denominator / 2);
  return numerator >= 0
    ? Math.floor((numerator + half) / denominator)
    : -Math.floor((-numerator + half) / denominator);
}

function sineQ15(index) {
  const normalized = ((index % SINE_PHASE_STEPS) + SINE_PHASE_STEPS) % SINE_PHASE_STEPS;
  const quadrant = Math.floor(normalized / 32);
  const offset = normalized % 32;
  if (quadrant === 0) return SINE_QUARTER_Q15[offset];
  if (quadrant === 1) return SINE_QUARTER_Q15[32 - offset];
  if (quadrant === 2) return -SINE_QUARTER_Q15[offset];
  return -SINE_QUARTER_Q15[32 - offset];
}

function sineFrameQ15(frame, frequencyHz, sampleRate) {
  const phaseNumerator = frame * frequencyHz * SINE_PHASE_STEPS;
  const wholeStep = Math.floor(phaseNumerator / sampleRate);
  const remainder = phaseNumerator % sampleRate;
  const current = sineQ15(wholeStep);
  const next = sineQ15(wholeStep + 1);
  return current + roundRatioSigned((next - current) * remainder, sampleRate);
}

function triangleFrameQ15(frame, frequencyHz, sampleRate) {
  const phase = (frame * frequencyHz) % sampleRate;
  const quarterPhase = phase * 4;
  let numerator;
  if (quarterPhase < sampleRate) {
    numerator = quarterPhase;
  } else if (quarterPhase < sampleRate * 2) {
    numerator = sampleRate * 2 - quarterPhase;
  } else if (quarterPhase < sampleRate * 3) {
    numerator = -(quarterPhase - sampleRate * 2);
  } else {
    numerator = -(sampleRate * 4 - quarterPhase);
  }
  return roundRatioSigned(numerator * Q15_FULL_SCALE, sampleRate);
}

function normalizeOscillatorParameters(value) {
  const parameters = exactKeys(
    value,
    ["waveform", "sampleRate", "channels", "frameCount", "frequencyHz", "amplitude"],
    "audio.oscillator parameters",
  );
  if (!["sine", "triangle"].includes(parameters.waveform)) {
    throw new Error("audio.oscillator waveform must be sine or triangle");
  }
  const sampleRate = integer(parameters.sampleRate, "audio.oscillator sampleRate", 8000, 192000);
  const frequencyHz = integer(
    parameters.frequencyHz,
    "audio.oscillator frequencyHz",
    1,
    Math.floor(sampleRate / 2),
  );
  return {
    waveform: parameters.waveform,
    sampleRate,
    channels: integer(parameters.channels, "audio.oscillator channels", 1, 2),
    frameCount: integer(parameters.frameCount, "audio.oscillator frameCount", 0, MAX_FRAME_COUNT),
    frequencyHz,
    amplitude: integer(parameters.amplitude, "audio.oscillator amplitude", 0, Q15_FULL_SCALE),
  };
}

function normalizeAdsrParameters(value) {
  const parameters = exactKeys(
    value,
    ["attackFrames", "decayFrames", "sustainLevelQ15", "releaseFrames"],
    "audio.adsr parameters",
  );
  return {
    attackFrames: integer(parameters.attackFrames, "audio.adsr attackFrames", 0, MAX_FRAME_COUNT),
    decayFrames: integer(parameters.decayFrames, "audio.adsr decayFrames", 0, MAX_FRAME_COUNT),
    sustainLevelQ15: integer(
      parameters.sustainLevelQ15,
      "audio.adsr sustainLevelQ15",
      0,
      Q15_FULL_SCALE,
    ),
    releaseFrames: integer(parameters.releaseFrames, "audio.adsr releaseFrames", 0, MAX_FRAME_COUNT),
  };
}

function assertAdsrBudget(parameters, frameCount) {
  const shapedFrames = parameters.attackFrames + parameters.decayFrames + parameters.releaseFrames;
  if (shapedFrames > frameCount) {
    throw new Error(
      `audio.adsr attackFrames + decayFrames + releaseFrames must not exceed source frameCount ${frameCount}`,
    );
  }
}

export function generateOscillatorAudio(value) {
  const parameters = normalizeOscillatorParameters(value);
  const samples = new Int16Array(parameters.frameCount * parameters.channels);
  for (let frame = 0; frame < parameters.frameCount; frame += 1) {
    const waveQ15 =
      parameters.waveform === "sine"
        ? sineFrameQ15(frame, parameters.frequencyHz, parameters.sampleRate)
        : triangleFrameQ15(frame, parameters.frequencyHz, parameters.sampleRate);
    const sample = roundRatioSigned(parameters.amplitude * waveQ15, Q15_FULL_SCALE);
    for (let channel = 0; channel < parameters.channels; channel += 1) {
      samples[frame * parameters.channels + channel] = sample;
    }
  }
  return { sampleRate: parameters.sampleRate, channels: parameters.channels, samples };
}

function adsrGainQ15(frame, frameCount, parameters) {
  const attackEnd = parameters.attackFrames;
  const decayEnd = attackEnd + parameters.decayFrames;
  const releaseStart = frameCount - parameters.releaseFrames;

  if (frame < attackEnd) {
    if (parameters.attackFrames === 1) return Q15_FULL_SCALE;
    return roundRatioSigned(frame * Q15_FULL_SCALE, parameters.attackFrames - 1);
  }

  if (frame < decayEnd) {
    const decayIndex = frame - attackEnd;
    const distance = Q15_FULL_SCALE - parameters.sustainLevelQ15;
    return (
      Q15_FULL_SCALE -
      roundRatioSigned((decayIndex + 1) * distance, parameters.decayFrames)
    );
  }

  if (frame < releaseStart || parameters.releaseFrames === 0) {
    return parameters.sustainLevelQ15;
  }

  const releaseIndex = frame - releaseStart;
  return (
    parameters.sustainLevelQ15 -
    roundRatioSigned(
      (releaseIndex + 1) * parameters.sustainLevelQ15,
      parameters.releaseFrames,
    )
  );
}

export function applyAdsrEnvelope(audioValue, parameterValue) {
  const audio = validateAudioBuffer(audioValue);
  const parameters = normalizeAdsrParameters(parameterValue);
  const frameCount = audioFrameCount(audio);
  assertAdsrBudget(parameters, frameCount);
  const samples = new Int16Array(audio.samples.length);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const gainQ15 = adsrGainQ15(frame, frameCount, parameters);
    for (let channel = 0; channel < audio.channels; channel += 1) {
      const index = frame * audio.channels + channel;
      samples[index] = roundRatioSigned(audio.samples[index] * gainQ15, Q15_FULL_SCALE);
    }
  }
  return { sampleRate: audio.sampleRate, channels: audio.channels, samples };
}

function normalizeParameters(operation, value) {
  if (operation.id === "audio.oscillator") return normalizeOscillatorParameters(value);
  if (operation.id === "audio.adsr") return normalizeAdsrParameters(value);
  throw new Error(`unsupported procedural audio operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("procedural audio operation root must be an absolute path");
  }
  return root;
}

async function implementationIdentity(operation) {
  if (operation.id === "audio.oscillator") {
    return {
      id: "builtin.audio.oscillator",
      version: VERSION,
      algorithm: "rational-phase-q15-table-linear-oscillator-v1",
      randomness: "none",
      sampleFormat: "pcm-s16le",
      phaseOrigin: "zero",
      sinePhaseSteps: SINE_PHASE_STEPS,
      tool: await captureToolIdentity(),
    };
  }
  return {
    id: "builtin.audio.adsr",
    version: VERSION,
    algorithm: "sample-exact-q15-adsr-v1",
    randomness: "none",
    sampleFormat: "pcm-s16le",
    gainEncoding: "q15",
    endpointSemantics: "attack-inclusive;decay-start-exclusive;release-start-exclusive",
    tool: await captureToolIdentity(),
  };
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizeParameters(operation, parameters),
    inputs,
  });
  if (operation.id === "audio.adsr") {
    const sourceRef = normalizeCanonicalAudioAssetRef(build.inputs.source);
    const source = assertCanonicalAudioBytes(
      await resolveAssetObject(assetRoot, sourceRef),
      sourceRef.metadata,
    );
    assertAdsrBudget(build.parameters, audioFrameCount(source));
  }
  return build;
}

async function storeCanonicalOutput(root, operation, audio, provenanceInputs) {
  const encoded = encodeCanonicalPcm16Wav(audio);
  const metadata = createCanonicalAudioMetadata({
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    frameCount: encoded.frameCount,
    operation: { id: operation.id, version: operation.version },
    inputs: provenanceInputs,
  });
  return storeAssetObject(assertRoot(root), {
    bytes: encoded.bytes,
    kind: "audio",
    mediaType: CANONICAL_AUDIO_MEDIA_TYPE,
    metadata,
  });
}

function standardObservations(audio) {
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    frameCount: audioFrameCount(audio),
  };
}

export async function createAudioOscillatorOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, AUDIO_OSCILLATOR_OPERATION, parameters, inputs);
}

export async function executeAudioOscillatorOperation(root, invocation = {}) {
  const build = await createAudioOscillatorOperationBuildIdentity(root, invocation);
  const audio = generateOscillatorAudio(build.parameters);
  const stored = await storeCanonicalOutput(root, AUDIO_OSCILLATOR_OPERATION, audio, []);
  return normalizeAssetOperationResult(AUDIO_OSCILLATOR_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      algorithm: build.implementation.algorithm,
      waveform: build.parameters.waveform,
      phaseOrigin: "zero",
      sinePhaseSteps: SINE_PHASE_STEPS,
      ...standardObservations(audio),
    },
  });
}

export async function createAudioAdsrOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, AUDIO_ADSR_OPERATION, parameters, inputs);
}

export async function executeAudioAdsrOperation(root, invocation = {}) {
  const build = await createAudioAdsrOperationBuildIdentity(root, invocation);
  const sourceRef = normalizeCanonicalAudioAssetRef(build.inputs.source);
  const source = assertCanonicalAudioBytes(
    await resolveAssetObject(assertRoot(root), sourceRef),
    sourceRef.metadata,
  );
  const audio = applyAdsrEnvelope(source, build.parameters);
  const stored = await storeCanonicalOutput(root, AUDIO_ADSR_OPERATION, audio, [
    { port: "source", sha256: sourceRef.sha256 },
  ]);
  return normalizeAssetOperationResult(AUDIO_ADSR_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      algorithm: build.implementation.algorithm,
      gainEncoding: "q15",
      sustainFrames:
        audioFrameCount(audio) -
        build.parameters.attackFrames -
        build.parameters.decayFrames -
        build.parameters.releaseFrames,
      parameters: build.parameters,
      ...standardObservations(audio),
    },
  });
}
