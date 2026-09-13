import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  createCanonicalAudioMetadata,
  decodePcmWav,
  encodeCanonicalPcm16Wav,
} from "../src/audio.js";
import { AUDIO_SYNTHESIZE_OPERATION } from "../src/audio-operations.js";
import {
  applyAdsrEnvelope,
  AUDIO_ADSR_OPERATION,
  AUDIO_OSCILLATOR_OPERATION,
  createAudioAdsrOperationBuildIdentity,
  createAudioOscillatorOperationBuildIdentity,
  executeAudioAdsrOperation,
  executeAudioOscillatorOperation,
  generateOscillatorAudio,
  PROCEDURAL_AUDIO_OPERATIONS,
} from "../src/audio-procedural-operations.js";
import { createAssetOperationWorkflowNodeTemplate } from "../src/workflow-operations.js";

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-audio-"));
}

async function storeCanonicalAudio(root, samples, { sampleRate = 8000, channels = 1 } = {}) {
  const audio = { sampleRate, channels, samples: Int16Array.from(samples) };
  const encoded = encodeCanonicalPcm16Wav(audio);
  const stored = await storeAssetObject(root, {
    bytes: encoded.bytes,
    kind: "audio",
    mediaType: "audio/wav",
    metadata: createCanonicalAudioMetadata({
      sampleRate,
      channels,
      frameCount: encoded.frameCount,
      operation: { id: "audio.test-source", version: "1" },
      inputs: [],
    }),
  });
  return stored.asset;
}

test("procedural audio registry adds oscillator and ADSR without widening audio.synthesize@1", () => {
  assert.deepEqual(
    PROCEDURAL_AUDIO_OPERATIONS.map((operation) => operation.id),
    ["audio.adsr", "audio.oscillator"],
  );
  assert.deepEqual(AUDIO_OSCILLATOR_OPERATION.parameterSchema.properties.waveform.enum, [
    "sine",
    "triangle",
  ]);
  assert.deepEqual(AUDIO_SYNTHESIZE_OPERATION.parameterSchema.properties.waveform.enum, [
    "silence",
    "square",
    "saw",
    "noise",
  ]);
  assert.equal(AUDIO_ADSR_OPERATION.inputs[0].mediaTypes[0], "audio/wav");
});

test("sine oscillator pins zero phase and fixed Q15 cardinal samples", () => {
  const audio = generateOscillatorAudio({
    waveform: "sine",
    sampleRate: 8000,
    channels: 1,
    frameCount: 8,
    frequencyHz: 1000,
    amplitude: 10000,
  });
  assert.deepEqual([...audio.samples], [0, 7071, 10000, 7071, 0, -7071, -10000, -7071]);
});

test("triangle oscillator pins exact rational phase samples and duplicates stereo channels", () => {
  const audio = generateOscillatorAudio({
    waveform: "triangle",
    sampleRate: 8000,
    channels: 2,
    frameCount: 8,
    frequencyHz: 1000,
    amplitude: 10000,
  });
  assert.deepEqual([...audio.samples], [
    0, 0,
    5000, 5000,
    10000, 10000,
    5000, 5000,
    0, 0,
    -5000, -5000,
    -10000, -10000,
    -5000, -5000,
  ]);
});

test("ADSR uses explicit stage endpoints and reaches exact release zero", () => {
  const source = {
    sampleRate: 8000,
    channels: 1,
    samples: Int16Array.from([10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000]),
  };
  const shaped = applyAdsrEnvelope(source, {
    attackFrames: 3,
    decayFrames: 2,
    sustainLevelQ15: 16384,
    releaseFrames: 2,
  });
  assert.deepEqual([...shaped.samples], [0, 5000, 10000, 7500, 5000, 5000, 2500, 0]);
});

test("ADSR fails closed when shaped stages exceed source frame budget", () => {
  assert.throws(
    () =>
      applyAdsrEnvelope(
        { sampleRate: 8000, channels: 1, samples: Int16Array.from([1, 1, 1, 1]) },
        { attackFrames: 2, decayFrames: 2, sustainLevelQ15: 20000, releaseFrames: 1 },
      ),
    /must not exceed source frameCount 4/,
  );
});

test("oscillator and ADSR build identities pin exact deterministic algorithms", async () => {
  const root = await workspace();
  try {
    const oscillator = await createAudioOscillatorOperationBuildIdentity(root, {
      parameters: {
        waveform: "sine",
        sampleRate: 8000,
        channels: 1,
        frameCount: 8,
        frequencyHz: 1000,
        amplitude: 10000,
      },
      inputs: {},
    });
    assert.equal(
      oscillator.implementation.algorithm,
      "rational-phase-q15-table-linear-oscillator-v1",
    );
    assert.equal(oscillator.implementation.randomness, "none");
    assert.equal(oscillator.implementation.sinePhaseSteps, 128);

    const source = await storeCanonicalAudio(root, [10000, 10000, 10000, 10000]);
    const adsr = await createAudioAdsrOperationBuildIdentity(root, {
      parameters: {
        attackFrames: 1,
        decayFrames: 1,
        sustainLevelQ15: 16384,
        releaseFrames: 1,
      },
      inputs: { source },
    });
    assert.equal(adsr.implementation.algorithm, "sample-exact-q15-adsr-v1");
    assert.equal(adsr.implementation.gainEncoding, "q15");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oscillator and ADSR operations are content-addressed and idempotent", async () => {
  const root = await workspace();
  try {
    const oscillatorInvocation = {
      parameters: {
        waveform: "sine",
        sampleRate: 8000,
        channels: 1,
        frameCount: 16,
        frequencyHz: 750,
        amplitude: 12000,
      },
      inputs: {},
    };
    const firstOscillator = await executeAudioOscillatorOperation(root, oscillatorInvocation);
    const secondOscillator = await executeAudioOscillatorOperation(root, oscillatorInvocation);
    assert.equal(firstOscillator.outputs.output.sha256, secondOscillator.outputs.output.sha256);
    assert.deepEqual(firstOscillator.observations, secondOscillator.observations);
    assert.equal(firstOscillator.observations.phaseOrigin, "zero");

    const adsrInvocation = {
      parameters: {
        attackFrames: 3,
        decayFrames: 3,
        sustainLevelQ15: 20000,
        releaseFrames: 4,
      },
      inputs: { source: firstOscillator.outputs.output },
    };
    const firstAdsr = await executeAudioAdsrOperation(root, adsrInvocation);
    const secondAdsr = await executeAudioAdsrOperation(root, adsrInvocation);
    assert.equal(firstAdsr.outputs.output.sha256, secondAdsr.outputs.output.sha256);
    assert.deepEqual(firstAdsr.observations, secondAdsr.observations);
    assert.equal(firstAdsr.observations.sustainFrames, 6);
    assert.deepEqual(firstAdsr.outputs.output.metadata.provenance.inputs, [
      { port: "source", sha256: firstOscillator.outputs.output.sha256 },
    ]);
    const decoded = decodePcmWav(await resolveAssetObject(root, firstAdsr.outputs.output));
    assert.equal(decoded.samples.at(-1), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new audio operations remain workflow-template compatible and publicly importable", async () => {
  const oscillator = createAssetOperationWorkflowNodeTemplate(AUDIO_OSCILLATOR_OPERATION, {
    parameters: {
      waveform: "triangle",
      sampleRate: 8000,
      channels: 1,
      frameCount: 8,
      frequencyHz: 1000,
      amplitude: 10000,
    },
  });
  assert.equal(oscillator.kind, "asset.operation");
  assert.equal(oscillator.outputs[0].metadata.assetOperationPort.assetKinds[0], "audio");

  const publicModule = await import("asset-tooling/operations/audio/procedural");
  assert.equal(publicModule.AUDIO_OSCILLATOR_OPERATION.id, "audio.oscillator");
  assert.equal(publicModule.AUDIO_ADSR_OPERATION.id, "audio.adsr");
});
