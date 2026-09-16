import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { storeAssetObject } from "../src/asset-store.js";
import { CANONICAL_AUDIO_MEDIA_TYPE, createCanonicalAudioMetadata } from "../src/audio.js";
import { createAudioModelGenerateOperationExecutor } from "../src/audio-model-operations.js";

test("model generation rejects conditioning bytes that disagree with canonical metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-audio-model-conditioning-"));
  try {
    const model = (await storeAssetObject(root, { bytes: Buffer.from("model"), kind: "model", mediaType: "application/octet-stream", metadata: {} })).asset;
    const metadata = createCanonicalAudioMetadata({ sampleRate: 8_000, channels: 1, frameCount: 1, operation: { id: "audio.synthesize", version: "1" } });
    const conditioning = (await storeAssetObject(root, { bytes: Buffer.from("not-a-wave-file"), kind: "audio", mediaType: CANONICAL_AUDIO_MEDIA_TYPE, metadata })).asset;
    let generateCalls = 0;
    const execute = createAudioModelGenerateOperationExecutor({
      id: "fixture.audio-model", version: "1", reproducibility: "approximate",
      async generate() { generateCalls += 1; throw new Error("adapter must not see invalid conditioning bytes"); },
    });
    await assert.rejects(execute(root, { parameters: { modelId: "fixture-model", modelRevision: "rev-1", prompt: "test", sampleRate: 8_000, channels: 1, frameCount: 1 }, inputs: { model, conditioning } }), /RIFF\/WAVE/);
    assert.equal(generateCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
