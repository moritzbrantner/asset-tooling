import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  AUDIO_CODEC_OPERATIONS,
  createAudioDecodeOperationBuildIdentity,
  executeAudioDecodeOperation,
} from "../src/audio-codec-operations.js";
import { assertCanonicalAudioBytes, CANONICAL_AUDIO_MEDIA_TYPE } from "../src/audio.js";
import { executeAudioSynthesizeOperation } from "../src/audio-operations.js";

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
}

async function workspaceWithWav() {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-audio-codec-"));
  const synthesized = await executeAudioSynthesizeOperation(root, {
    parameters: {
      waveform: "square",
      sampleRate: 16_000,
      channels: 1,
      frameCount: 16_000,
      frequencyHz: 440,
      amplitude: 8_000,
    },
  });
  const bytes = await resolveAssetObject(root, synthesized.outputs.output);
  const stored = await storeAssetObject(root, {
    bytes,
    kind: "audio",
    mediaType: "audio/wav",
    metadata: { fixture: "standard-wav-input" },
  });
  return { root, source: stored.asset };
}

test("audio codec registry exposes one explicit standard decode boundary", () => {
  assert.deepEqual(AUDIO_CODEC_OPERATIONS.map((operation) => operation.id), ["audio.decode"]);
  const decode = AUDIO_CODEC_OPERATIONS[0];
  assert.equal(decode.outputs[0].mediaTypes[0], CANONICAL_AUDIO_MEDIA_TYPE);
  assert.ok(decode.inputs[0].mediaTypes.includes("audio/ogg"));
  assert.ok(decode.inputs[0].mediaTypes.includes("audio/mpeg"));
});

test("audio decode fails closed when the declared FFmpeg runtime is unavailable", async () => {
  const { root, source } = await workspaceWithWav();
  await assert.rejects(
    () =>
      createAudioDecodeOperationBuildIdentity(root, {
        parameters: { sampleRate: 16_000, channels: 1 },
        inputs: { source },
        runtime: { ffmpeg: "definitely-missing-ffmpeg" },
      }),
    /could not execute/i,
  );
});

if (hasFfmpeg()) {
  test("audio decode materializes deterministic canonical PCM at explicit rate and channels", async () => {
    const { root, source } = await workspaceWithWav();
    const invocation = {
      parameters: { sampleRate: 8_000, channels: 2 },
      inputs: { source },
    };
    const first = await executeAudioDecodeOperation(root, invocation);
    const second = await executeAudioDecodeOperation(root, invocation);

    assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
    assert.equal(first.observations.sampleRate, 8_000);
    assert.equal(first.observations.channels, 2);
    assert.equal(first.observations.frameCount, 8_000);
    const bytes = await resolveAssetObject(root, first.outputs.output);
    const decoded = assertCanonicalAudioBytes(bytes, first.outputs.output.metadata);
    assert.equal(decoded.sampleRate, 8_000);
    assert.equal(decoded.channels, 2);
    assert.equal(decoded.samples.length, 16_000);
  });
}
