import { createAssetRef } from "./operations.js";

export const AUDIO_SCHEMA_VERSION = 1;
export const CANONICAL_AUDIO_MEDIA_TYPE = "audio/wav";
export const CANONICAL_AUDIO_CODEC = "pcm-s16le";
export const AUDIO_SAMPLE_BYTES = 2;
export const AUDIO_MAX_FRAME_COUNT = 10_000_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[A-Za-z0-9]+(?:[._+-][A-Za-z0-9]+)*$/;
const MASK_64 = (1n << 64n) - 1n;

function isObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function assertToken(value, location) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error(`${location} must be a lowercase dotted token`);
  }
  return value;
}

function assertVersion(value, location) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`${location} must be a portable version token`);
  }
  return value;
}

function assertSha256(value, location) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${location} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

function channelLayout(channels) {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  throw new Error("audio channels must be 1 or 2");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampInt16(value) {
  if (value < -32768) return -32768;
  if (value > 32767) return 32767;
  return value;
}

function roundDivideSigned(numerator, denominator) {
  if (denominator <= 0n) throw new Error("roundDivideSigned denominator must be positive");
  if (numerator >= 0n) return Number((numerator + denominator / 2n) / denominator);
  return -Number(((-numerator) + denominator / 2n) / denominator);
}

function splitMix64(seed) {
  let state = BigInt(seed) & MASK_64;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK_64;
    let value = state;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return (value ^ (value >> 31n)) & MASK_64;
  };
}

function normalizeProvenance(value) {
  const provenance = assertObject(value, "audio metadata provenance");
  assertExactKeys(provenance, new Set(["operation", "inputs"]), "audio metadata provenance");
  const operation = assertObject(provenance.operation, "audio metadata provenance.operation");
  assertExactKeys(operation, new Set(["id", "version"]), "audio metadata provenance.operation");
  if (!Array.isArray(provenance.inputs)) {
    throw new Error("audio metadata provenance.inputs must be an array");
  }
  return {
    operation: {
      id: assertToken(operation.id, "audio metadata provenance.operation.id"),
      version: assertVersion(operation.version, "audio metadata provenance.operation.version"),
    },
    inputs: provenance.inputs.map((entry, index) => {
      const input = assertObject(entry, `audio metadata provenance.inputs[${index}]`);
      assertExactKeys(
        input,
        new Set(["port", "sha256"]),
        `audio metadata provenance.inputs[${index}]`,
      );
      return {
        port: assertToken(input.port, `audio metadata provenance.inputs[${index}].port`),
        sha256: assertSha256(input.sha256, `audio metadata provenance.inputs[${index}].sha256`),
      };
    }),
  };
}

export function normalizeCanonicalAudioMetadata(value) {
  const metadata = assertObject(value, "canonical audio metadata");
  assertExactKeys(metadata, new Set(["audio", "provenance"]), "canonical audio metadata");
  const audio = assertObject(metadata.audio, "canonical audio metadata.audio");
  assertExactKeys(
    audio,
    new Set([
      "schemaVersion",
      "codec",
      "sampleRate",
      "channels",
      "channelLayout",
      "frameCount",
      "duration",
    ]),
    "canonical audio metadata.audio",
  );
  if (audio.schemaVersion !== AUDIO_SCHEMA_VERSION) {
    throw new Error(`canonical audio metadata.audio.schemaVersion must be ${AUDIO_SCHEMA_VERSION}`);
  }
  if (audio.codec !== CANONICAL_AUDIO_CODEC) {
    throw new Error(`canonical audio metadata.audio.codec must be '${CANONICAL_AUDIO_CODEC}'`);
  }
  const sampleRate = assertInteger(audio.sampleRate, "canonical audio metadata.audio.sampleRate", 8_000, 192_000);
  const channels = assertInteger(audio.channels, "canonical audio metadata.audio.channels", 1, 2);
  const expectedLayout = channelLayout(channels);
  if (audio.channelLayout !== expectedLayout) {
    throw new Error(`canonical audio metadata.audio.channelLayout must be '${expectedLayout}'`);
  }
  const frameCount = assertInteger(
    audio.frameCount,
    "canonical audio metadata.audio.frameCount",
    0,
    AUDIO_MAX_FRAME_COUNT,
  );
  const duration = assertObject(audio.duration, "canonical audio metadata.audio.duration");
  assertExactKeys(duration, new Set(["numerator", "denominator"]), "canonical audio metadata.audio.duration");
  if (duration.numerator !== frameCount || duration.denominator !== sampleRate) {
    throw new Error("canonical audio duration must equal frameCount/sampleRate exactly");
  }

  return {
    audio: {
      schemaVersion: AUDIO_SCHEMA_VERSION,
      codec: CANONICAL_AUDIO_CODEC,
      sampleRate,
      channels,
      channelLayout: expectedLayout,
      frameCount,
      duration: { numerator: frameCount, denominator: sampleRate },
    },
    provenance: normalizeProvenance(metadata.provenance),
  };
}

export function createCanonicalAudioMetadata({ sampleRate, channels, frameCount, operation, inputs = [] }) {
  return normalizeCanonicalAudioMetadata({
    audio: {
      schemaVersion: AUDIO_SCHEMA_VERSION,
      codec: CANONICAL_AUDIO_CODEC,
      sampleRate,
      channels,
      channelLayout: channelLayout(channels),
      frameCount,
      duration: { numerator: frameCount, denominator: sampleRate },
    },
    provenance: {
      operation,
      inputs,
    },
  });
}

export function normalizeCanonicalAudioAssetRef(value) {
  const asset = createAssetRef(value);
  if (asset.kind !== "audio") throw new Error("canonical audio asset kind must be 'audio'");
  if (asset.mediaType !== CANONICAL_AUDIO_MEDIA_TYPE) {
    throw new Error(`canonical audio asset mediaType must be '${CANONICAL_AUDIO_MEDIA_TYPE}'`);
  }
  return {
    ...asset,
    metadata: normalizeCanonicalAudioMetadata(asset.metadata),
  };
}

export function audioFrameCount(audio) {
  if (!(audio.samples instanceof Int16Array)) {
    throw new Error("audio samples must be an Int16Array");
  }
  const channels = assertInteger(audio.channels, "audio channels", 1, 2);
  if (audio.samples.length % channels !== 0) {
    throw new Error("audio sample count must be divisible by channels");
  }
  return audio.samples.length / channels;
}

export function validateAudioBuffer(audio) {
  const value = assertObject(audio, "audio buffer");
  assertExactKeys(value, new Set(["sampleRate", "channels", "samples"]), "audio buffer");
  const sampleRate = assertInteger(value.sampleRate, "audio buffer sampleRate", 8_000, 192_000);
  const channels = assertInteger(value.channels, "audio buffer channels", 1, 2);
  if (!(value.samples instanceof Int16Array)) {
    throw new Error("audio buffer samples must be an Int16Array");
  }
  const frameCount = audioFrameCount({ sampleRate, channels, samples: value.samples });
  if (frameCount > AUDIO_MAX_FRAME_COUNT) {
    throw new Error(`audio frameCount must not exceed ${AUDIO_MAX_FRAME_COUNT}`);
  }
  return { sampleRate, channels, samples: value.samples };
}

export function encodeCanonicalPcm16Wav(audioValue) {
  const audio = validateAudioBuffer(audioValue);
  const frameCount = audioFrameCount(audio);
  const dataSize = audio.samples.length * AUDIO_SAMPLE_BYTES;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(audio.channels, 22);
  bytes.writeUInt32LE(audio.sampleRate, 24);
  bytes.writeUInt32LE(audio.sampleRate * audio.channels * AUDIO_SAMPLE_BYTES, 28);
  bytes.writeUInt16LE(audio.channels * AUDIO_SAMPLE_BYTES, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < audio.samples.length; index += 1) {
    bytes.writeInt16LE(audio.samples[index], 44 + index * AUDIO_SAMPLE_BYTES);
  }
  return { bytes, frameCount };
}

export function decodePcmWav(bytesValue) {
  const bytes = Buffer.from(bytesValue);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("audio input must be a RIFF/WAVE file");
  }
  const declaredLength = bytes.readUInt32LE(4) + 8;
  if (declaredLength !== bytes.length) {
    throw new Error(`WAV RIFF length mismatch: header declares ${declaredLength}, got ${bytes.length}`);
  }

  let format;
  let data;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.length) throw new Error(`WAV chunk '${id}' exceeds file bounds`);
    if (id === "fmt ") {
      if (format) throw new Error("WAV must contain exactly one fmt chunk");
      if (size < 16) throw new Error("WAV fmt chunk must contain at least 16 bytes");
      const audioFormat = bytes.readUInt16LE(bodyStart);
      const channels = bytes.readUInt16LE(bodyStart + 2);
      const sampleRate = bytes.readUInt32LE(bodyStart + 4);
      const byteRate = bytes.readUInt32LE(bodyStart + 8);
      const blockAlign = bytes.readUInt16LE(bodyStart + 12);
      const bitsPerSample = bytes.readUInt16LE(bodyStart + 14);
      if (audioFormat !== 1) throw new Error("WAV input must use uncompressed PCM format 1");
      assertInteger(channels, "WAV channels", 1, 2);
      assertInteger(sampleRate, "WAV sampleRate", 8_000, 192_000);
      if (![8, 16].includes(bitsPerSample)) throw new Error("WAV PCM input must use 8-bit or 16-bit samples");
      const bytesPerSample = bitsPerSample / 8;
      if (blockAlign !== channels * bytesPerSample) throw new Error("WAV blockAlign is inconsistent with channels/sample size");
      if (byteRate !== sampleRate * blockAlign) throw new Error("WAV byteRate is inconsistent with sampleRate/blockAlign");
      format = { channels, sampleRate, bitsPerSample, blockAlign };
    } else if (id === "data") {
      if (data) throw new Error("WAV must contain exactly one data chunk");
      data = bytes.subarray(bodyStart, bodyEnd);
    }
    const paddedEnd = bodyEnd + (size % 2);
    if (paddedEnd > bytes.length) {
      throw new Error(`WAV chunk '${id}' is missing its required padding byte`);
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length) {
    throw new Error(`WAV contains ${bytes.length - offset} trailing byte(s) outside a complete chunk`);
  }
  if (!format) throw new Error("WAV input is missing fmt chunk");
  if (!data) throw new Error("WAV input is missing data chunk");
  if (data.length % format.blockAlign !== 0) throw new Error("WAV data length must align to complete audio frames");

  const sampleCount = data.length / (format.bitsPerSample / 8);
  const samples = new Int16Array(sampleCount);
  if (format.bitsPerSample === 16) {
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = data.readInt16LE(index * 2);
    }
  } else {
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = (data[index] - 128) << 8;
    }
  }

  const audio = {
    sampleRate: format.sampleRate,
    channels: format.channels,
    samples,
  };
  Object.defineProperty(audio, "sourceBitsPerSample", {
    value: format.bitsPerSample,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return audio;
}

export function assertCanonicalAudioBytes(bytesValue, metadataValue) {
  const metadata = normalizeCanonicalAudioMetadata(metadataValue);
  const decoded = decodePcmWav(bytesValue);
  if (decoded.sourceBitsPerSample !== 16) throw new Error("canonical audio bytes must use PCM 16-bit samples");
  const frameCount = audioFrameCount(decoded);
  if (decoded.sampleRate !== metadata.audio.sampleRate) throw new Error("canonical audio sampleRate does not match metadata");
  if (decoded.channels !== metadata.audio.channels) throw new Error("canonical audio channels do not match metadata");
  if (frameCount !== metadata.audio.frameCount) throw new Error("canonical audio frameCount does not match metadata");
  const canonical = encodeCanonicalPcm16Wav(decoded).bytes;
  if (!canonical.equals(Buffer.from(bytesValue))) throw new Error("canonical audio bytes must use the canonical WAV layout");
  return decoded;
}

export function trimAudio(audioValue, startFrame, endFrame) {
  const audio = validateAudioBuffer(audioValue);
  const frameCount = audioFrameCount(audio);
  const start = assertInteger(startFrame, "trim startFrame", 0, frameCount);
  const end = assertInteger(endFrame, "trim endFrame", start, frameCount);
  const samples = audio.samples.slice(start * audio.channels, end * audio.channels);
  return { sampleRate: audio.sampleRate, channels: audio.channels, samples };
}

export function convertAudioChannels(audioValue, targetChannels) {
  const audio = validateAudioBuffer(audioValue);
  const target = assertInteger(targetChannels, "targetChannels", 1, 2);
  if (audio.channels === target) return { ...audio, samples: audio.samples.slice() };
  const frameCount = audioFrameCount(audio);
  const samples = new Int16Array(frameCount * target);
  if (audio.channels === 1 && target === 2) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sample = audio.samples[frame];
      samples[frame * 2] = sample;
      samples[frame * 2 + 1] = sample;
    }
  } else {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const left = audio.samples[frame * 2];
      const right = audio.samples[frame * 2 + 1];
      samples[frame] = clampInt16(roundDivideSigned(BigInt(left + right), 2n));
    }
  }
  return { sampleRate: audio.sampleRate, channels: target, samples };
}

export function resampleAudio(audioValue, targetSampleRate) {
  const audio = validateAudioBuffer(audioValue);
  const targetRate = assertInteger(targetSampleRate, "targetSampleRate", 8_000, 192_000);
  if (audio.sampleRate === targetRate) return { ...audio, samples: audio.samples.slice() };
  const sourceFrames = audioFrameCount(audio);
  if (sourceFrames === 0) return { sampleRate: targetRate, channels: audio.channels, samples: new Int16Array(0) };

  const outputFrames = Math.max(
    1,
    Number(
      (BigInt(sourceFrames) * BigInt(targetRate) + BigInt(audio.sampleRate) / 2n) /
        BigInt(audio.sampleRate),
    ),
  );
  if (outputFrames > AUDIO_MAX_FRAME_COUNT) {
    throw new Error(`resampled audio frameCount must not exceed ${AUDIO_MAX_FRAME_COUNT}`);
  }
  const samples = new Int16Array(outputFrames * audio.channels);
  const denominator = BigInt(targetRate);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const position = BigInt(frame) * BigInt(audio.sampleRate);
    const leftFrame = Number(position / denominator);
    const remainder = position % denominator;
    const rightFrame = Math.min(leftFrame + 1, sourceFrames - 1);
    const safeLeft = Math.min(leftFrame, sourceFrames - 1);
    for (let channel = 0; channel < audio.channels; channel += 1) {
      const left = audio.samples[safeLeft * audio.channels + channel];
      const right = audio.samples[rightFrame * audio.channels + channel];
      const weighted = BigInt(left) * (denominator - remainder) + BigInt(right) * remainder;
      samples[frame * audio.channels + channel] = clampInt16(
        roundDivideSigned(weighted, denominator),
      );
    }
  }
  return { sampleRate: targetRate, channels: audio.channels, samples };
}

export function applyAudioGain(audioValue, numeratorValue, denominatorValue) {
  const audio = validateAudioBuffer(audioValue);
  const numerator = assertInteger(numeratorValue, "gain numerator", -160_000, 160_000);
  const denominator = assertInteger(denominatorValue, "gain denominator", 1, 10_000);
  const samples = new Int16Array(audio.samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = clampInt16(
      roundDivideSigned(BigInt(audio.samples[index]) * BigInt(numerator), BigInt(denominator)),
    );
  }
  return { sampleRate: audio.sampleRate, channels: audio.channels, samples };
}

export function applyAudioFade(audioValue, fadeInFramesValue, fadeOutFramesValue) {
  const audio = validateAudioBuffer(audioValue);
  const frameCount = audioFrameCount(audio);
  const fadeInFrames = assertInteger(fadeInFramesValue, "fadeInFrames", 0, frameCount);
  const fadeOutFrames = assertInteger(fadeOutFramesValue, "fadeOutFrames", 0, frameCount);
  const samples = audio.samples.slice();

  for (let frame = 0; frame < frameCount; frame += 1) {
    let numerator = 1n;
    let denominator = 1n;
    if (fadeInFrames > 0 && frame < fadeInFrames) {
      if (fadeInFrames === 1) {
        numerator = 0n;
        denominator = 1n;
      } else {
        numerator *= BigInt(frame);
        denominator *= BigInt(fadeInFrames - 1);
      }
    }
    const remaining = frameCount - 1 - frame;
    if (fadeOutFrames > 0 && remaining < fadeOutFrames) {
      if (fadeOutFrames === 1) {
        numerator = 0n;
        denominator = 1n;
      } else {
        numerator *= BigInt(remaining);
        denominator *= BigInt(fadeOutFrames - 1);
      }
    }
    if (numerator === denominator) continue;
    for (let channel = 0; channel < audio.channels; channel += 1) {
      const index = frame * audio.channels + channel;
      samples[index] = clampInt16(
        roundDivideSigned(BigInt(samples[index]) * numerator, denominator),
      );
    }
  }
  return { sampleRate: audio.sampleRate, channels: audio.channels, samples };
}

export function synthesizeAudio(parameters) {
  const value = assertObject(parameters, "audio synthesis parameters");
  assertExactKeys(
    value,
    new Set(["waveform", "sampleRate", "channels", "frameCount", "frequencyHz", "amplitude", "seed"]),
    "audio synthesis parameters",
  );
  if (!["silence", "square", "saw", "noise"].includes(value.waveform)) {
    throw new Error("audio synthesis waveform must be silence, square, saw, or noise");
  }
  const sampleRate = assertInteger(value.sampleRate, "audio synthesis sampleRate", 8_000, 192_000);
  const channels = assertInteger(value.channels, "audio synthesis channels", 1, 2);
  const frameCount = assertInteger(value.frameCount, "audio synthesis frameCount", 0, AUDIO_MAX_FRAME_COUNT);
  const amplitude = assertInteger(value.amplitude ?? 32767, "audio synthesis amplitude", 0, 32767);
  let frequencyHz;
  if (["square", "saw"].includes(value.waveform)) {
    frequencyHz = assertInteger(value.frequencyHz, "audio synthesis frequencyHz", 1, Math.floor(sampleRate / 2));
  } else if (value.frequencyHz !== undefined) {
    throw new Error(`audio synthesis waveform '${value.waveform}' does not accept frequencyHz`);
  }
  let next;
  if (value.waveform === "noise") {
    if (typeof value.seed !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.seed)) {
      throw new Error("audio synthesis noise seed must be a non-negative decimal integer string");
    }
    next = splitMix64(value.seed);
  } else if (value.seed !== undefined) {
    throw new Error(`audio synthesis waveform '${value.waveform}' does not accept seed`);
  }

  const samples = new Int16Array(frameCount * channels);
  const noiseRange = BigInt(amplitude * 2 + 1);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sample = 0;
    if (value.waveform === "square") {
      const phase = Number((BigInt(frame) * BigInt(frequencyHz)) % BigInt(sampleRate));
      sample = phase * 2 < sampleRate ? amplitude : -amplitude;
    } else if (value.waveform === "saw") {
      const phase = Number((BigInt(frame) * BigInt(frequencyHz)) % BigInt(sampleRate));
      sample = clampInt16(
        -amplitude +
          roundDivideSigned(BigInt(2 * amplitude * phase), BigInt(Math.max(1, sampleRate - 1))),
      );
    } else if (value.waveform === "noise") {
      sample = Number(next() % noiseRange) - amplitude;
    }
    for (let channel = 0; channel < channels; channel += 1) {
      samples[frame * channels + channel] = sample;
    }
  }
  return { sampleRate, channels, samples };
}

export function mixAudio(sourcesValue, tracksValue) {
  if (!Array.isArray(sourcesValue) || sourcesValue.length < 1 || sourcesValue.length > 32) {
    throw new Error("audio mix sources must contain 1..32 audio buffers");
  }
  if (!Array.isArray(tracksValue) || tracksValue.length !== sourcesValue.length) {
    throw new Error("audio mix tracks must contain one placement per source");
  }
  const sources = sourcesValue.map((source) => validateAudioBuffer(source));
  const sampleRate = sources[0].sampleRate;
  const channels = sources[0].channels;
  const tracks = tracksValue.map((trackValue, index) => {
    const track = assertObject(trackValue, `audio mix tracks[${index}]`);
    assertExactKeys(
      track,
      new Set(["startFrame", "gainNumerator", "gainDenominator"]),
      `audio mix tracks[${index}]`,
    );
    return {
      startFrame: assertInteger(track.startFrame, `audio mix tracks[${index}].startFrame`, 0, AUDIO_MAX_FRAME_COUNT),
      gainNumerator: assertInteger(track.gainNumerator ?? 1, `audio mix tracks[${index}].gainNumerator`, -160_000, 160_000),
      gainDenominator: assertInteger(track.gainDenominator ?? 1, `audio mix tracks[${index}].gainDenominator`, 1, 10_000),
    };
  });

  let outputFrames = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (source.sampleRate !== sampleRate || source.channels !== channels) {
      throw new Error("audio mix inputs must have identical sampleRate and channels; normalize first");
    }
    outputFrames = Math.max(outputFrames, tracks[index].startFrame + audioFrameCount(source));
  }
  if (outputFrames > AUDIO_MAX_FRAME_COUNT) {
    throw new Error(`mixed audio frameCount must not exceed ${AUDIO_MAX_FRAME_COUNT}`);
  }

  const samples = new Int16Array(outputFrames * channels);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      let sum = 0n;
      for (let index = 0; index < sources.length; index += 1) {
        const sourceFrame = frame - tracks[index].startFrame;
        const source = sources[index];
        if (sourceFrame < 0 || sourceFrame >= audioFrameCount(source)) continue;
        const sample = source.samples[sourceFrame * channels + channel];
        sum += BigInt(
          roundDivideSigned(
            BigInt(sample) * BigInt(tracks[index].gainNumerator),
            BigInt(tracks[index].gainDenominator),
          ),
        );
      }
      samples[frame * channels + channel] = clampInt16(Number(sum < -32768n ? -32768n : sum > 32767n ? 32767n : sum));
    }
  }
  return { sampleRate, channels, samples };
}

export function cloneAudioMetadata(value) {
  return cloneJson(normalizeCanonicalAudioMetadata(value));
}
