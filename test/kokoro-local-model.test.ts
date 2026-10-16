/**
 * LOCAL real-model acceptance for moritzbrantner/asset-tooling#30 (Kokoro-82M speech adapter).
 *
 * Skipped (reported as skipped, not passed) unless both variables are set:
 *
 *   ASSET_TOOLING_KOKORO_PYTHON     the interpreter of a uv-managed Python 3.12 venv installed
 *                                   with `uv pip install --require-hashes -r requirements-kokoro.txt`
 *   ASSET_TOOLING_KOKORO_MODEL_ZIP  the `model.zip` produced by
 *                                   `python scripts/acquire-huggingface-model.py acquire
 *                                     --repo-id hexgrad/Kokoro-82M
 *                                     --revision f3ff3571791e39611d31c381e3a41a3af07b4987
 *                                     --expected-license apache-2.0 --destination <dir>`
 *
 * Optional:
 *   ASSET_TOOLING_KOKORO_THREADS       torch thread count (default 1)
 *   ASSET_TOOLING_KOKORO_EVIDENCE_DIR  where to write `kokoro-sample.wav` (for the listening and
 *                                      intelligibility note) and `kokoro-evidence.json` (probe
 *                                      components, both output hashes, whether they match)
 *
 * Run: ASSET_TOOLING_KOKORO_PYTHON=... ASSET_TOOLING_KOKORO_MODEL_ZIP=... \
 *        bun test test/kokoro-local-model.test.ts
 *
 * Seams: createKokoroAudioModelAdapter({ python, threads }) from src/model-backends.ts with the
 * audio.model.generate@2 executor; see test/kokoro-audio-adapter.test.ts for the full contract.
 *
 * What it proves on a real runtime: the sentence with Arius, homoousios, Athanasius and Nicaea
 * synthesizes with the supplied lexicon into non-silent, plausibly long 24 kHz mono audio; the
 * same sentence without the Arius entry fails closed naming "Arius" (real misaki, no espeak); and
 * a same-seed, same-thread rerun in a fresh process is recorded as byte-identical or not, while
 * the reproducibility label stays "approximate" either way. It does not judge pronunciation:
 * that is the listening note recorded from the evidence sample.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { decodePcmWav } from "../src/audio.js";
import {
  createAudioModelGenerateV2OperationBuildIdentity,
  createAudioModelGenerateV2OperationExecutor,
} from "../src/audio-model-operations.js";
import * as modelBackends from "../src/model-backends.js";

const PYTHON = process.env.ASSET_TOOLING_KOKORO_PYTHON;
const MODEL_ZIP = process.env.ASSET_TOOLING_KOKORO_MODEL_ZIP;
const THREADS = Number(process.env.ASSET_TOOLING_KOKORO_THREADS ?? "1");
const EVIDENCE_DIR = process.env.ASSET_TOOLING_KOKORO_EVIDENCE_DIR;
const SKIP =
  (!PYTHON || !MODEL_ZIP) &&
  "local Kokoro acceptance needs ASSET_TOOLING_KOKORO_PYTHON (prepared venv) and ASSET_TOOLING_KOKORO_MODEL_ZIP (acquired model.zip)";

const SENTENCE = "Arius and Athanasius disputed the homoousios at Nicaea.";
const LEXICON = {
  version: "seven-councils-local-acceptance-1",
  entries: {
    Arius: "ˈɛɹiəs",
    homoousios: "hˌOmOˈusiəs",
    Athanasius: "ˌæθənˈAʃəs",
    Nicaea: "nIsˈiə",
  },
};

function parameters(lexicon = LEXICON) {
  return {
    modelId: "hexgrad/Kokoro-82M",
    modelRevision: "f3ff3571791e39611d31c381e3a41a3af07b4987",
    prompt: SENTENCE,
    seed: "325",
    sampleRate: 24_000,
    channels: 1,
    adapterParameters: { voice: "af_heart", lexicon },
  };
}

test("real Kokoro-82M: lexicon-covered sentence, fail-closed OOV and a recorded same-seed rerun", { skip: SKIP, timeout: 900_000 }, async (t) => {
  const create = (modelBackends as Record<string, any>).createKokoroAudioModelAdapter;
  assert.equal(typeof create, "function", "src/model-backends.ts must export createKokoroAudioModelAdapter (#30)");
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-kokoro-local-"));
  try {
    const model = (await storeAssetObject(root, { bytes: await readFile(MODEL_ZIP!), kind: "model", mediaType: "application/zip", metadata: {} })).asset;
    const adapter = create({ python: PYTHON, threads: THREADS });
    assert.equal(adapter.reproducibility, "approximate");

    const components = await adapter.environmentComponents();
    const probeText = JSON.stringify(components);
    for (const name of [/kokoro/i, /misaki/i, /torch/i, /en.core.web.sm/i]) assert.match(probeText, name, "probe must fingerprint the runtime");

    const invocation = { parameters: parameters(), inputs: { model } };
    const build = await createAudioModelGenerateV2OperationBuildIdentity(adapter, invocation);
    assert.equal(build.implementation.reproducibility, "approximate");
    assert.ok(build.implementation.environment);

    const execute = createAudioModelGenerateV2OperationExecutor(adapter);
    const first = await execute(root, invocation);
    const output = first.outputs.output;
    assert.equal(output.metadata.audio.sampleRate, 24_000);
    assert.equal(output.metadata.audio.channels, 1);
    const seconds = output.metadata.audio.frameCount / 24_000;
    assert.ok(seconds >= 1.5 && seconds <= 30, `a nine-word sentence should last 1.5-30 s, got ${seconds.toFixed(2)} s`);
    const bytes = await resolveAssetObject(root, output);
    const decoded = decodePcmWav(bytes);
    let peak = 0;
    let energy = 0;
    for (const sample of decoded.samples) {
      peak = Math.max(peak, Math.abs(sample));
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / decoded.samples.length);
    assert.ok(peak > 1_000 && rms > 100, `output must not be silent (peak ${peak}, rms ${rms.toFixed(1)})`);

    // Real misaki without espeak: dropping one lexicon entry must fail closed, naming the word.
    const { Arius: _arius, ...withoutArius } = LEXICON.entries;
    await assert.rejects(
      execute(root, { parameters: parameters({ version: `${LEXICON.version}-without-arius`, entries: withoutArius }), inputs: { model } }),
      /Arius/,
    );

    // Fresh process, same seed and threads. Record, do not require, byte equality.
    const second = await execute(root, invocation);
    const match = second.outputs.output.sha256 === output.sha256;
    t.diagnostic(`kokoro same-seed rerun (threads=${THREADS}): ${match ? "byte-identical" : "bytes differ"} ${output.sha256} / ${second.outputs.output.sha256}`);
    for (const result of [first, second]) {
      assert.equal(result.observations.adapter.reproducibility, "approximate", "an equal rerun must not relabel the adapter exact");
    }

    if (EVIDENCE_DIR) {
      await mkdir(EVIDENCE_DIR, { recursive: true });
      await writeFile(path.join(EVIDENCE_DIR, "kokoro-sample.wav"), bytes);
      await writeFile(
        path.join(EVIDENCE_DIR, "kokoro-evidence.json"),
        `${JSON.stringify(
          {
            sentence: SENTENCE,
            lexicon: LEXICON,
            seed: "325",
            threads: THREADS,
            modelSha256: model.sha256,
            probe: components,
            frameCount: output.metadata.audio.frameCount,
            peak,
            rms,
            firstSha256: output.sha256,
            secondSha256: second.outputs.output.sha256,
            sameSeedRerunByteIdentical: match,
            reproducibility: "approximate",
          },
          null,
          2,
        )}\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
