/**
 * Regression for the PR #210 review (P2): lexicon phoneme strings are checked against misaki's
 * English phoneme symbols in TypeScript, so an invalid symbol never spawns the generate process.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { storeAssetObject } from "../src/asset-store.js";
import { createAudioModelGenerateV2OperationExecutor } from "../src/audio-model-operations.js";
import { createKokoroAudioModelAdapter, KOKORO_GB_PHONEMES, KOKORO_US_PHONEMES } from "../src/model-backends.js";

const FAKE_PYTHON = fileURLToPath(new URL("./fixtures/kokoro-fake-python.js", import.meta.url));

async function run(voice: string, entries: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-kokoro-lexicon-"));
  const stateDir = path.join(root, "fake-python");
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), "{}");
  const model = (
    await storeAssetObject(root, { bytes: Buffer.from("PK\u0005\u0006lexicon-fixture"), kind: "model", mediaType: "application/zip", metadata: {} })
  ).asset;
  const adapter = createKokoroAudioModelAdapter({ python: [process.execPath, FAKE_PYTHON, stateDir], threads: 1 });
  const invocation = {
    parameters: {
      modelId: "hexgrad/Kokoro-82M",
      modelRevision: "f3ff3571791e39611d31c381e3a41a3af07b4987",
      prompt: "Arius spoke.",
      seed: "1",
      sampleRate: 24_000,
      channels: 1,
      adapterParameters: { voice, lexicon: { version: "regression-1", entries } },
    },
    inputs: { model },
  };
  const generateCalls = async () => {
    try {
      const text = await readFile(path.join(stateDir, "invocations.jsonl"), "utf8");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.mode === "generate").length;
    } catch {
      return 0;
    }
  };
  return { root, execute: () => createAudioModelGenerateV2OperationExecutor(adapter)(root, invocation), generateCalls };
}

test("a lexicon entry with a symbol outside misaki's phoneme set is rejected before the generate process starts", async () => {
  for (const [voice, phonemes] of [["af_heart", "x"], ["bf_emma", "ˈɛɹi@s"], ["af_heart", "ˈɛɹiəś"]] as const) {
    const fixture = await run(voice, { Arius: phonemes });
    try {
      await assert.rejects(fixture.execute(), /lexicon[\s\S]*phoneme/);
      assert.equal(await fixture.generateCalls(), 0, `${voice} ${JSON.stringify(phonemes)} must not spawn generate`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("valid US and GB lexicon entries reach the generate process", async () => {
  for (const [voice, phonemes] of [["af_heart", "hˌOmOˈusiəs"], ["bf_emma", "ˈɛəɹɪəs"], ["bm_george", "nʌɪsˈiːə"]] as const) {
    const fixture = await run(voice, { Arius: phonemes });
    try {
      await fixture.execute();
      assert.equal(await fixture.generateCalls(), 1, `${voice} ${JSON.stringify(phonemes)} must be accepted`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
  assert.ok(KOKORO_US_PHONEMES.includes("O") && KOKORO_GB_PHONEMES.includes("Q") && KOKORO_GB_PHONEMES.includes("ː"));
});
