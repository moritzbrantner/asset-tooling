import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAssetRefFromBytes, resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  assertCanonicalAudioBytes,
  CANONICAL_AUDIO_MEDIA_TYPE,
  createCanonicalAudioMetadata,
  decodePcmWav,
  encodeCanonicalPcm16Wav,
  normalizeCanonicalAudioAssetRef,
} from "../src/audio.js";
import {
  AUDIO_CHANNELS_OPERATION,
  AUDIO_FADE_OPERATION,
  AUDIO_GAIN_OPERATION,
  AUDIO_MIX_OPERATION,
  AUDIO_NORMALIZE_OPERATION,
  AUDIO_OPERATIONS,
  AUDIO_RESAMPLE_OPERATION,
  AUDIO_SYNTHESIZE_OPERATION,
  AUDIO_TRIM_OPERATION,
  executeAudioChannelsOperation,
  executeAudioFadeOperation,
  executeAudioGainOperation,
  executeAudioMixOperation,
  executeAudioNormalizeOperation,
  executeAudioResampleOperation,
  executeAudioSynthesizeOperation,
  executeAudioTrimOperation,
} from "../src/audio-operations.js";
import { createAssetOperationWorkflowNodeTemplate } from "../src/workflow-operations.js";

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-audio-"));
}

function pcm8Wav({ sampleRate, channels, samples }) {
  const data = Buffer.from(samples);
  const blockAlign = channels;
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + data.length, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

test("canonical audio metadata and bytes are exact and self-consistent", () => {
  const audio = {
    sampleRate: 48_000,
    channels: 2,
    samples: Int16Array.from([0, 0, 1000, -1000, 32767, -32768]),
  };
  const encoded = encodeCanonicalPcm16Wav(audio);
  const metadata = createCanonicalAudioMetadata({
    sampleRate: 48_000,
    channels: 2,
    frameCount: 3,
    operation: { id: "audio.synthesize", version: "1" },
  });
  const decoded = assertCanonicalAudioBytes(encoded.bytes, metadata);
  assert.equal(decoded.sampleRate, 48_000);
  assert.equal(decoded.channels, 2);
  assert.deepEqual([...decoded.samples], [...audio.samples]);
  assert.deepEqual(metadata.audio.duration, { numerator: 3, denominator: 48_000 });
  assert.throws(
    () =>
      assertCanonicalAudioBytes(encoded.bytes, {
        ...metadata,
        audio: { ...metadata.audio, frameCount: 4, duration: { numerator: 4, denominator: 48_000 } },
      }),
    /frameCount/,
  );
});

test("audio.normalize converts supported PCM WAV input into canonical content-addressed audio", async () => {
  const root = await workspace();
  try {
    const sourceBytes = pcm8Wav({
      sampleRate: 8_000,
      channels: 1,
      samples: [0, 64, 128, 192, 255, 192, 128, 64],
    });
    const source = (
      await storeAssetObject(root, {
        bytes: sourceBytes,
        kind: "audio",
        mediaType: "audio/wav",
        metadata: { fixture: "pcm8" },
      })
    ).asset;

    const result = await executeAudioNormalizeOperation(root, {
      parameters: { sampleRate: 16_000, channels: 2 },
      inputs: { source },
    });
    const output = normalizeCanonicalAudioAssetRef(result.outputs.output);
    assert.equal(output.mediaType, CANONICAL_AUDIO_MEDIA_TYPE);
    assert.equal(output.metadata.audio.codec, "pcm-s16le");
    assert.equal(output.metadata.audio.sampleRate, 16_000);
    assert.equal(output.metadata.audio.channels, 2);
    assert.equal(output.metadata.audio.frameCount, 16);
    assert.deepEqual(output.metadata.provenance.inputs, [{ port: "source", sha256: source.sha256 }]);
    assert.equal(result.observations.sourceBitsPerSample, 8);
    assert.equal(result.observations.resampled, true);
    assert.equal(result.observations.channelConverted, true);
    const decoded = assertCanonicalAudioBytes(await resolveAssetObject(root, output), output.metadata);
    assert.equal(decoded.samples.length, 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio.synthesize is deterministic and reuses one logical content identity", async () => {
  const root = await workspace();
  try {
    const invocation = {
      parameters: {
        waveform: "noise",
        sampleRate: 8_000,
        channels: 1,
        frameCount: 32,
        amplitude: 2_000,
        seed: "42",
      },
      inputs: {},
    };
    const first = await executeAudioSynthesizeOperation(root, invocation);
    const second = await executeAudioSynthesizeOperation(root, invocation);
    assert.deepEqual(second.outputs.output, first.outputs.output);
    assert.deepEqual(second.observations, first.observations);
    assert.equal(first.observations.algorithm, "sample-index-waveform-v1");
    assert.equal(first.observations.seed, "42");
    assert.equal(first.outputs.output.metadata.provenance.inputs.length, 0);
    const bytes = await resolveAssetObject(root, first.outputs.output);
    assertCanonicalAudioBytes(bytes, first.outputs.output.metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical transforms compose without changing ownership or introducing time-based semantics", async () => {
  const root = await workspace();
  try {
    const generated = await executeAudioSynthesizeOperation(root, {
      parameters: {
        waveform: "square",
        sampleRate: 8_000,
        channels: 1,
        frameCount: 8,
        frequencyHz: 1_000,
        amplitude: 1_000,
      },
      inputs: {},
    });
    const trimmed = await executeAudioTrimOperation(root, {
      parameters: { startFrame: 2, endFrame: 6 },
      inputs: { source: generated.outputs.output },
    });
    assert.equal(trimmed.outputs.output.metadata.audio.frameCount, 4);

    const resampled = await executeAudioResampleOperation(root, {
      parameters: { sampleRate: 16_000 },
      inputs: { source: trimmed.outputs.output },
    });
    assert.equal(resampled.outputs.output.metadata.audio.frameCount, 8);
    assert.equal(resampled.observations.algorithm, "linear-fixed-v1");

    const stereo = await executeAudioChannelsOperation(root, {
      parameters: { channels: 2 },
      inputs: { source: resampled.outputs.output },
    });
    assert.equal(stereo.outputs.output.metadata.audio.channelLayout, "stereo");

    const gained = await executeAudioGainOperation(root, {
      parameters: { numerator: 2, denominator: 1 },
      inputs: { source: stereo.outputs.output },
    });
    assert.equal(gained.observations.clipping, "saturate-int16");

    const faded = await executeAudioFadeOperation(root, {
      parameters: { fadeInFrames: 3, fadeOutFrames: 3 },
      inputs: { source: gained.outputs.output },
    });
    const decoded = decodePcmWav(await resolveAssetObject(root, faded.outputs.output));
    assert.equal(decoded.samples[0], 0);
    assert.equal(decoded.samples[1], 0);
    assert.equal(decoded.samples.at(-1), 0);
    assert.equal(decoded.samples.at(-2), 0);
    assert.deepEqual(faded.outputs.output.metadata.provenance.inputs, [
      { port: "source", sha256: gained.outputs.output.sha256 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio.mix preserves ordered input lineage, offsets, and saturating overlap", async () => {
  const root = await workspace();
  try {
    const first = await executeAudioSynthesizeOperation(root, {
      parameters: {
        waveform: "square",
        sampleRate: 8_000,
        channels: 1,
        frameCount: 4,
        frequencyHz: 1_000,
        amplitude: 24_000,
      },
      inputs: {},
    });
    const second = await executeAudioSynthesizeOperation(root, {
      parameters: {
        waveform: "square",
        sampleRate: 8_000,
        channels: 1,
        frameCount: 4,
        frequencyHz: 1_000,
        amplitude: 20_000,
      },
      inputs: {},
    });
    const mixed = await executeAudioMixOperation(root, {
      parameters: {
        tracks: [
          { startFrame: 0, gainNumerator: 1, gainDenominator: 1 },
          { startFrame: 2, gainNumerator: 1, gainDenominator: 1 },
        ],
      },
      inputs: { sources: [first.outputs.output, second.outputs.output] },
    });
    assert.equal(mixed.outputs.output.metadata.audio.frameCount, 6);
    assert.deepEqual(mixed.observations.orderedInputSha256, [
      first.outputs.output.sha256,
      second.outputs.output.sha256,
    ]);
    assert.deepEqual(mixed.outputs.output.metadata.provenance.inputs, [
      { port: "sources", sha256: first.outputs.output.sha256 },
      { port: "sources", sha256: second.outputs.output.sha256 },
    ]);
    const decoded = decodePcmWav(await resolveAssetObject(root, mixed.outputs.output));
    assert.ok([...decoded.samples].some((sample) => Math.abs(sample) === 32767 || sample === -32768));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio operations publish typed workflow-compatible ports", () => {
  assert.deepEqual(
    AUDIO_OPERATIONS.map((operation) => operation.id),
    [
      "audio.channels",
      "audio.fade",
      "audio.gain",
      "audio.mix",
      "audio.normalize",
      "audio.resample",
      "audio.synthesize",
      "audio.trim",
    ],
  );
  const synthesis = createAssetOperationWorkflowNodeTemplate(AUDIO_SYNTHESIZE_OPERATION, {
    parameters: { waveform: "silence", sampleRate: 8_000, channels: 1, frameCount: 1 },
  });
  assert.equal(synthesis.kind, "asset.operation");
  assert.equal(synthesis.outputs[0].metadata.assetOperationPort.assetKinds[0], "audio");
  assert.equal(
    synthesis.outputs[0].metadata.assetOperationPort.mediaTypes[0],
    CANONICAL_AUDIO_MEDIA_TYPE,
  );

  const mix = createAssetOperationWorkflowNodeTemplate(AUDIO_MIX_OPERATION, {
    parameters: { tracks: [{ startFrame: 0 }] },
  });
  assert.deepEqual(mix.inputs[0].metadata.assetOperationPort.cardinality, { min: 1, max: 32 });

  for (const operation of [
    AUDIO_NORMALIZE_OPERATION,
    AUDIO_TRIM_OPERATION,
    AUDIO_RESAMPLE_OPERATION,
    AUDIO_CHANNELS_OPERATION,
    AUDIO_GAIN_OPERATION,
    AUDIO_FADE_OPERATION,
  ]) {
    assert.equal(operation.outputs[0].mediaTypes[0], CANONICAL_AUDIO_MEDIA_TYPE);
  }
});

test("published audio schema remains a closed canonical AssetRef contract", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schemas/audio-asset-v1.schema.json", import.meta.url), "utf8"),
  );
  assert.equal(schema.properties.kind.const, "audio");
  assert.equal(schema.properties.mediaType.const, "audio/wav");
  assert.equal(schema.properties.metadata.additionalProperties, false);
  assert.equal(schema.properties.metadata.properties.audio.properties.codec.const, "pcm-s16le");
  assert.equal(schema.properties.metadata.properties.provenance.additionalProperties, false);

  const bytes = encodeCanonicalPcm16Wav({
    sampleRate: 8_000,
    channels: 1,
    samples: Int16Array.from([0]),
  }).bytes;
  const metadata = createCanonicalAudioMetadata({
    sampleRate: 8_000,
    channels: 1,
    frameCount: 1,
    operation: { id: "audio.synthesize", version: "1" },
  });
  const asset = createAssetRefFromBytes(bytes, {
    kind: "audio",
    mediaType: CANONICAL_AUDIO_MEDIA_TYPE,
    metadata,
  });
  assert.deepEqual(normalizeCanonicalAudioAssetRef(asset), asset);
});
