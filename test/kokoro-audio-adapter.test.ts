/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#30, concrete adapter:
 * local Kokoro-82M text-to-speech for `audio.model.generate@2`.
 *
 * Written by a separate acceptance context before any implementation exists. Spec sources: the
 * #30 issue comments of 2026-10-16 (speech-adapter preflight, owner answer, concrete scope) and
 * interactive-videos Decisions 3.22 and 3.24. These tests run in CI without torch, kokoro, misaki
 * or the model: a fake interpreter (test/fixtures/kokoro-fake-python.js) speaks the
 * process-adapter protocol in place of the venv Python.
 *
 * Public seams targeted (TypeScript):
 *
 *   createKokoroAudioModelAdapter({ python?, threads? })  exported from src/model-backends.ts
 *     -> v2 adapter `{ id: "kokoro", version: "1", reproducibility: "approximate",
 *                      generate, environmentComponents }`
 *        for createAudioModelGenerateV2OperationExecutor / ...BuildIdentity.
 *     - `python`: the interpreter command, either one executable or a non-empty array
 *       `[executable, ...launcherArguments]` (for example a venv python, or
 *       `["uv", "run", "--frozen", "python"]`). The adapter runs
 *       `<python...> <repo>/adapters/python/kokoro_tts.py probe|generate ...` through
 *       probeProcessAdapter/runProcessAdapter (src/process-adapter.ts), so the forced offline
 *       variables apply.
 *     - `threads`: positive integer torch thread count (default chosen by the implementation).
 *       It is part of the build identity.
 *     - `environmentComponents()` returns the Python probe's component array (plus anything the
 *       adapter adds, such as the thread count), so the probed runtime is part of the identity.
 *
 *   Pinned model: modelId "hexgrad/Kokoro-82M", modelRevision
 *   "f3ff3571791e39611d31c381e3a41a3af07b4987". The `model` input is the acquisition
 *   `model.zip` stored as kind "model", mediaType "application/zip"
 *   (scripts/acquire-huggingface-model.py --expected-license apache-2.0). The adapter hands the
 *   Python process a path to a file whose bytes are exactly that AssetRef's bytes.
 *
 *   Parameters: sampleRate must be 24000, channels 1, `seed` is required and forwarded,
 *   no conditioning input. adapterParameters (closed shape):
 *     { voice: <Kokoro v1.0 English voice id: af_*, am_*, bf_*, bm_* at the pinned revision>,
 *       lexicon: { version: non-empty string, entries: { <word>: <phonemes> } },
 *       speed?: finite number > 0 }
 *   Malformed parameters, an unknown or non-English voice, a model id/revision/AssetRef mismatch
 *   and a non-24 kHz/mono request are rejected before the generate process starts (the probe may
 *   already have run, because the operation captures the environment before calling generate).
 *
 *   Output: the generate process writes a PCM16 WAV; the adapter returns it as 24 kHz mono audio.
 *   The frame count is derived from the output (no frameCount in the request). A WAV that is not
 *   24000 Hz mono, is not a WAV, or has zero frames fails closed.
 *
 * Request fields the fake interpreter inspects: it records the whole request.json; tests require
 * the keys `seed` and `threads` somewhere in it, the prompt, voice and lexicon entries in it, and a
 * string naming an existing file whose SHA-256 is the model AssetRef's.
 *
 * The Python-side seams (OOV detection with a stub tokenizer, bundle pinning, static offline
 * checks, hash-locked requirements, docs) are in test/kokoro-tts-python.test.ts; the real-model
 * run is test/kokoro-local-model.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assetObjectPortablePath, resolveAssetObject, runAssetOperation, storeAssetObject } from "../src/asset-store.js";
import { createCanonicalAudioMetadata, decodePcmWav, encodeCanonicalPcm16Wav } from "../src/audio.js";
import {
  AUDIO_MODEL_GENERATE_V2_OPERATION,
  createAudioModelGenerateV2OperationBuildIdentity,
  createAudioModelGenerateV2OperationExecutor,
} from "../src/audio-model-operations.js";
import * as modelBackends from "../src/model-backends.js";

const KOKORO_MODEL_ID = "hexgrad/Kokoro-82M";
const KOKORO_MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987";
const FAKE_PYTHON = fileURLToPath(new URL("./fixtures/kokoro-fake-python.js", import.meta.url));
const KOKORO_SCRIPT = fileURLToPath(new URL("../adapters/python/kokoro_tts.py", import.meta.url));

type Factory = (options?: Record<string, unknown>) => any;

function factory(): Factory {
  const create = (modelBackends as Record<string, unknown>).createKokoroAudioModelAdapter;
  assert.equal(typeof create, "function", "src/model-backends.ts must export createKokoroAudioModelAdapter (#30)");
  return create as Factory;
}

const LEXICON = {
  version: "seven-councils-2026-10-16",
  entries: {
    Arius: "ˈɛɹiəs",
    homoousios: "hˌOmOˈusiəs",
    Athanasius: "ˌæθənˈAʃəs",
    Nicaea: "nIsˈiə",
  },
};

const PARAMETERS = {
  modelId: KOKORO_MODEL_ID,
  modelRevision: KOKORO_MODEL_REVISION,
  prompt: "Arius and Athanasius disputed the homoousios at Nicaea.",
  seed: "7",
  sampleRate: 24_000,
  channels: 1,
  adapterParameters: { voice: "af_heart", lexicon: LEXICON },
};

interface Fake {
  root: string;
  stateDir: string;
  python: string[];
  configure(config: Record<string, unknown>): Promise<void>;
  invocations(): Promise<any[]>;
  model: any;
  modelBytes: Buffer;
}

async function fake(initialConfig: Record<string, unknown> = {}): Promise<Fake> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-kokoro-"));
  const stateDir = path.join(root, "fake-python");
  await mkdir(stateDir);
  const configure = (config: Record<string, unknown>) => writeFile(path.join(stateDir, "config.json"), JSON.stringify(config));
  await configure(initialConfig);
  // Stand-in for the acquisition model.zip: real bytes, never inspected by the fake.
  const modelBytes = Buffer.from("PK\u0005\u0006fixture-kokoro-model-zip-v1", "utf8");
  const model = (await storeAssetObject(root, { bytes: modelBytes, kind: "model", mediaType: "application/zip", metadata: {} })).asset;
  return {
    root,
    stateDir,
    python: [process.execPath, FAKE_PYTHON, stateDir],
    configure,
    async invocations() {
      try {
        const text = await readFile(path.join(stateDir, "invocations.jsonl"), "utf8");
        return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    model,
    modelBytes,
  };
}

function generateCalls(invocations: any[]) {
  return invocations.filter((entry) => entry.mode === "generate");
}

function findKey(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((entry) => findKey(entry, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([name, entry]) => [...(name === key ? [entry] : []), ...findKey(entry, key)]);
  }
  return [];
}

async function registrationFor(adapter: any, invocation: any) {
  const build = await createAudioModelGenerateV2OperationBuildIdentity(adapter, invocation);
  return {
    build,
    registration: {
      descriptor: AUDIO_MODEL_GENERATE_V2_OPERATION,
      implementation: build.implementation,
      execute: createAudioModelGenerateV2OperationExecutor(adapter),
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter shape
// ---------------------------------------------------------------------------

test("kokoro adapter: id, version, approximate reproducibility and a probed environment", () => {
  const adapter = factory()({ python: [process.execPath, FAKE_PYTHON, "/unused"], threads: 1 });
  assert.equal(adapter.id, "kokoro");
  assert.equal(adapter.version, "1");
  assert.equal(adapter.reproducibility, "approximate", "a fixed seed is not evidence of exact replay (AGENTS.md)");
  assert.equal(typeof adapter.generate, "function");
  assert.equal(typeof adapter.environmentComponents, "function");
  assert.deepEqual(Object.keys(adapter).sort(), ["environmentComponents", "generate", "id", "reproducibility", "version"]);
  // Accepted by the closed v2 adapter shape.
  assert.equal(typeof createAudioModelGenerateV2OperationExecutor(adapter), "function");
});

test("kokoro adapter rejects malformed factory options", () => {
  const create = factory();
  for (const threads of [0, -1, 1.5, "2", Number.NaN]) {
    assert.throws(() => create({ python: [process.execPath, FAKE_PYTHON, "/unused"], threads }), /threads/);
  }
  assert.throws(() => create({ python: [] }), /python/);
  assert.throws(() => create({ python: "" }), /python/);
  assert.throws(() => create({ python: [process.execPath], hidden: true }), /hidden/);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("environmentComponents runs kokoro_tts.py probe and its components are part of the identity", async () => {
  const f = await fake({ probe: [{ id: "torch", version: "2.8.0+cpu" }, { id: "kokoro", version: "0.9.4" }] });
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    const components = await adapter.environmentComponents();
    assert.ok(Array.isArray(components));
    assert.ok(JSON.stringify(components).includes("2.8.0+cpu"), "the probe output must be carried into the components");
    const probes = (await f.invocations()).filter((entry) => entry.mode === "probe");
    assert.equal(probes.length, 1);
    assert.equal(path.resolve(probes[0].scriptPath), path.resolve(KOKORO_SCRIPT), "the probe must run adapters/python/kokoro_tts.py");

    const build = await createAudioModelGenerateV2OperationBuildIdentity(adapter, { parameters: PARAMETERS, inputs: { model: f.model } });
    assert.equal(build.implementation.id, "kokoro");
    assert.equal(build.implementation.reproducibility, "approximate");
    assert.deepEqual(build.implementation.model, { id: KOKORO_MODEL_ID, revision: KOKORO_MODEL_REVISION });
    assert.ok(build.implementation.environment, "the probed runtime must be in the build identity");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a changed probe gives a different cache key and re-executes; an identical probe hits", async () => {
  const f = await fake({ probe: [{ id: "torch", version: "2.8.0+cpu" }] });
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    const invocation = { parameters: PARAMETERS, inputs: { model: f.model } };

    const first = await registrationFor(adapter, invocation);
    const firstRun = await runAssetOperation(f.root, first.registration, invocation);
    assert.equal(firstRun.status, "miss");
    assert.equal(generateCalls(await f.invocations()).length, 1);

    const same = await registrationFor(adapter, invocation);
    const sameRun = await runAssetOperation(f.root, same.registration, invocation);
    assert.equal(sameRun.status, "hit");
    assert.equal(sameRun.cacheKey, firstRun.cacheKey);
    assert.equal(generateCalls(await f.invocations()).length, 1, "an identical runtime reuses the verified result");

    await f.configure({ probe: [{ id: "torch", version: "2.9.0+cpu" }] });
    const drifted = await registrationFor(adapter, invocation);
    const driftedRun = await runAssetOperation(f.root, drifted.registration, invocation);
    assert.notEqual(driftedRun.cacheKey, firstRun.cacheKey);
    assert.equal(driftedRun.status, "miss");
    assert.equal(generateCalls(await f.invocations()).length, 2, "a changed runtime must re-execute");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the thread count is part of the build identity", async () => {
  const f = await fake();
  try {
    const invocation = { parameters: PARAMETERS, inputs: { model: f.model } };
    const one = await createAudioModelGenerateV2OperationBuildIdentity(factory()({ python: f.python, threads: 1 }), invocation);
    const two = await createAudioModelGenerateV2OperationBuildIdentity(factory()({ python: f.python, threads: 2 }), invocation);
    assert.notDeepEqual(one.implementation, two.implementation);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("voice, lexicon entries, lexicon version and seed are part of the identity", async () => {
  const f = await fake();
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    const key = async (parameters: any) => {
      const invocation = { parameters, inputs: { model: f.model } };
      return (await runAssetOperation(f.root, (await registrationFor(adapter, invocation)).registration, invocation)).cacheKey;
    };
    const base = await key(PARAMETERS);
    const variants = [
      { ...PARAMETERS, adapterParameters: { ...PARAMETERS.adapterParameters, voice: "bf_emma" } },
      { ...PARAMETERS, adapterParameters: { ...PARAMETERS.adapterParameters, lexicon: { ...LEXICON, version: "seven-councils-2026-10-17" } } },
      { ...PARAMETERS, adapterParameters: { ...PARAMETERS.adapterParameters, lexicon: { ...LEXICON, entries: { ...LEXICON.entries, Arius: "əɹˈIəs" } } } },
      { ...PARAMETERS, seed: "8" },
    ];
    const keys = new Set([base]);
    for (const variant of variants) keys.add(await key(variant));
    assert.equal(keys.size, variants.length + 1, "every identity-bearing change must give a distinct cache key");
    assert.equal(generateCalls(await f.invocations()).length, variants.length + 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Generation through the fake process
// ---------------------------------------------------------------------------

test("generate forwards prompt, seed, threads, voice, lexicon and the exact model bytes", async () => {
  const f = await fake();
  try {
    const adapter = factory()({ python: f.python, threads: 3 });
    await createAudioModelGenerateV2OperationExecutor(adapter)(f.root, { parameters: PARAMETERS, inputs: { model: f.model } });
    const [call] = generateCalls(await f.invocations());
    assert.ok(call, "generate must run the process adapter");
    assert.equal(path.resolve(call.scriptPath), path.resolve(KOKORO_SCRIPT));
    const request = call.request;
    const text = JSON.stringify(request);
    assert.ok(text.includes(JSON.stringify(PARAMETERS.prompt)), "the prompt must be forwarded verbatim");
    assert.ok(findKey(request, "seed").some((value) => String(value) === "7"), "the request seed must be forwarded");
    assert.ok(findKey(request, "threads").some((value) => value === 3), "the thread count must be forwarded");
    assert.ok(text.includes('"af_heart"'));
    assert.ok(text.includes(JSON.stringify(LEXICON.version)));
    for (const [word, phonemes] of Object.entries(LEXICON.entries)) {
      assert.ok(text.includes(JSON.stringify(word)) && text.includes(JSON.stringify(phonemes)), `lexicon entry ${word} must be forwarded`);
    }
    const expected = createHash("sha256").update(f.modelBytes).digest("hex");
    assert.equal(expected, f.model.sha256);
    assert.ok(
      Object.values(call.files).includes(f.model.sha256),
      "the request must name a file holding exactly the model AssetRef bytes",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the result is canonical 24 kHz mono audio with the frame count derived from the output", async () => {
  const f = await fake({ output: { sampleRate: 24_000, channels: 1, frames: 36_123 }, observations: { voice: "af_heart" } });
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    const result = await createAudioModelGenerateV2OperationExecutor(adapter)(f.root, { parameters: PARAMETERS, inputs: { model: f.model } });
    const output = result.outputs.output;
    assert.equal(output.kind, "audio");
    assert.equal(output.mediaType, "audio/wav");
    assert.equal(output.metadata.audio.sampleRate, 24_000);
    assert.equal(output.metadata.audio.channels, 1);
    assert.equal(output.metadata.audio.frameCount, 36_123);
    assert.deepEqual(output.metadata.audio.duration, { numerator: 36_123, denominator: 24_000 });
    assert.deepEqual(output.metadata.provenance.operation, { id: "audio.model.generate", version: "2" });
    assert.equal(result.observations.frameCount, 36_123);
    assert.equal(result.observations.seed, "7");
    assert.deepEqual(result.observations.adapter, { id: "kokoro", version: "1", reproducibility: "approximate" });
    assert.deepEqual(result.observations.model, { id: KOKORO_MODEL_ID, revision: KOKORO_MODEL_REVISION, sha256: f.model.sha256 });
    const decoded = decodePcmWav(await resolveAssetObject(f.root, output));
    assert.equal(decoded.sampleRate, 24_000);
    assert.equal(decoded.channels, 1);
    assert.equal(decoded.samples.length, 36_123);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("output that is not 24 kHz mono PCM WAV, or is empty, fails closed", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ sampleRate: 22_050, channels: 1, frames: 100 }, /24000|22050|sampleRate/],
    [{ sampleRate: 24_000, channels: 2, frames: 100 }, /channel|mono/],
    [{ raw: "not a wav" }, /WAV|RIFF|wav/],
    [{ sampleRate: 24_000, channels: 1, frames: 0 }, /empty|frame|silent|no audio/i],
  ];
  for (const [output, pattern] of cases) {
    const f = await fake({ output });
    try {
      const adapter = factory()({ python: f.python, threads: 1 });
      await assert.rejects(
        createAudioModelGenerateV2OperationExecutor(adapter)(f.root, { parameters: PARAMETERS, inputs: { model: f.model } }),
        pattern,
        `output ${JSON.stringify(output)} must be rejected`,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("an out-of-vocabulary failure from the Python adapter fails closed and names the token", async () => {
  const f = await fake({ generateExitCode: 1, generateStderr: "out-of-vocabulary token(s) with no lexicon entry: 'Hosius'\n" });
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    await assert.rejects(
      createAudioModelGenerateV2OperationExecutor(adapter)(f.root, {
        parameters: { ...PARAMETERS, prompt: "Hosius presided." },
        inputs: { model: f.model },
      }),
      /Hosius/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a failing probe (missing runtime) fails closed before generation", async () => {
  const f = await fake({ probeExitCode: 1, probeStderr: "required Python package 'kokoro' is not installed\n" });
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    await assert.rejects(
      createAudioModelGenerateV2OperationExecutor(adapter)(f.root, { parameters: PARAMETERS, inputs: { model: f.model } }),
      /kokoro/,
    );
    assert.equal(generateCalls(await f.invocations()).length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

test("probe and generate run with the forced offline variables and without ambient credentials", async () => {
  const f = await fake();
  const saved = { HF_TOKEN: process.env.HF_TOKEN, HF_ENDPOINT: process.env.HF_ENDPOINT, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE };
  process.env.HF_TOKEN = "hf_ambient_secret";
  process.env.HF_ENDPOINT = "https://example.invalid";
  process.env.HF_HUB_OFFLINE = "0";
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("network access is forbidden during generation");
  }) as typeof fetch;
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    await createAudioModelGenerateV2OperationExecutor(adapter)(f.root, { parameters: PARAMETERS, inputs: { model: f.model } });
    const invocations = await f.invocations();
    assert.deepEqual(invocations.map((entry) => entry.mode).sort(), ["generate", "probe"]);
    for (const entry of invocations) {
      assert.equal(entry.env.HF_HUB_OFFLINE, "1", `${entry.mode} must run with HF_HUB_OFFLINE=1`);
      assert.equal(entry.env.TRANSFORMERS_OFFLINE, "1", `${entry.mode} must run with TRANSFORMERS_OFFLINE=1`);
      assert.equal(entry.env.HF_HUB_DISABLE_TELEMETRY, "1");
      assert.equal(entry.env.HF_TOKEN, undefined, "an ambient token must not reach the adapter");
      assert.equal(entry.env.HF_ENDPOINT, undefined, "an ambient endpoint must not reach the adapter");
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rejected before the generate process starts
// ---------------------------------------------------------------------------

async function assertRejectedBeforeGenerate(parameters: any, pattern: RegExp, inputs?: (f: Fake) => any) {
  const f = await fake();
  try {
    const adapter = factory()({ python: f.python, threads: 1 });
    await assert.rejects(
      createAudioModelGenerateV2OperationExecutor(adapter)(f.root, { parameters, inputs: inputs ? await inputs(f) : { model: f.model } }),
      pattern,
      `${JSON.stringify(parameters).slice(0, 160)} must be rejected`,
    );
    assert.equal(generateCalls(await f.invocations()).length, 0, "the generate process must not start");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}

function withAdapterParameters(adapterParameters: unknown) {
  return { ...PARAMETERS, adapterParameters };
}

test("a malformed lexicon is rejected before the process starts", async () => {
  const voice = "af_heart";
  const malformed: unknown[] = [
    { voice },
    { voice, lexicon: "seven-councils" },
    { voice, lexicon: { entries: LEXICON.entries } },
    { voice, lexicon: { version: "", entries: LEXICON.entries } },
    { voice, lexicon: { version: 3, entries: LEXICON.entries } },
    { voice, lexicon: { version: "v1" } },
    { voice, lexicon: { version: "v1", entries: [["Arius", "ˈɛɹiəs"]] } },
    { voice, lexicon: { version: "v1", entries: { Arius: "" } } },
    { voice, lexicon: { version: "v1", entries: { Arius: 1 } } },
    { voice, lexicon: { version: "v1", entries: { "": "ˈɛɹiəs" } } },
    { voice, lexicon: { version: "v1", entries: { "Arius Athanasius": "ˈɛɹiəs" } } },
    { voice, lexicon: { version: "v1", entries: {}, fallback: "espeak" } },
  ];
  for (const adapterParameters of malformed) {
    await assertRejectedBeforeGenerate(withAdapterParameters(adapterParameters), /lexicon/);
  }
});

test("an unknown, missing or non-English voice is rejected before the process starts", async () => {
  for (const voice of [undefined, "", "xx_nobody", "af_heart.pt", "../voices/af_heart", "jf_alpha", "zf_xiaobei", 7]) {
    const adapterParameters: Record<string, unknown> = { lexicon: LEXICON };
    if (voice !== undefined) adapterParameters.voice = voice;
    await assertRejectedBeforeGenerate(withAdapterParameters(adapterParameters), /voice/);
  }
});

test("unknown adapterParameters fields and a malformed speed are rejected before the process starts", async () => {
  await assertRejectedBeforeGenerate(withAdapterParameters({ voice: "af_heart", lexicon: LEXICON, espeak: true }), /espeak/);
  for (const speed of [0, -1, "fast", Number.POSITIVE_INFINITY]) {
    // Infinity is not canonical JSON and is already rejected by the operation; the others by the adapter.
    await assertRejectedBeforeGenerate(withAdapterParameters({ voice: "af_heart", lexicon: LEXICON, speed }), /speed|non-finite/);
  }
});

test("a request that is not 24 kHz mono, has no seed or carries conditioning is rejected before the process starts", async () => {
  await assertRejectedBeforeGenerate({ ...PARAMETERS, sampleRate: 22_050 }, /24000|sampleRate/);
  await assertRejectedBeforeGenerate({ ...PARAMETERS, channels: 2 }, /mono|channels/);
  const { seed: _seed, ...withoutSeed } = PARAMETERS;
  await assertRejectedBeforeGenerate(withoutSeed, /seed/);
  await assertRejectedBeforeGenerate(PARAMETERS, /conditioning/, async (f) => {
    const samples = new Int16Array(240);
    const encoded = encodeCanonicalPcm16Wav({ sampleRate: 24_000, channels: 1, samples });
    const conditioning = (
      await storeAssetObject(f.root, {
        bytes: encoded.bytes,
        kind: "audio",
        mediaType: "audio/wav",
        metadata: createCanonicalAudioMetadata({
          sampleRate: 24_000,
          channels: 1,
          frameCount: encoded.frameCount,
          operation: { id: "audio.synthesize", version: "1" },
        }),
      })
    ).asset;
    return { model: f.model, conditioning };
  });
});

test("a model id, revision or AssetRef that does not match the pinned Kokoro bundle is rejected", async () => {
  await assertRejectedBeforeGenerate({ ...PARAMETERS, modelId: "hexgrad/Kokoro-82M-v1.1-zh" }, /Kokoro-82M|modelId|model id/);
  await assertRejectedBeforeGenerate({ ...PARAMETERS, modelRevision: "main" }, /revision|f3ff3571/);
  await assertRejectedBeforeGenerate({ ...PARAMETERS, modelRevision: KOKORO_MODEL_REVISION.slice(0, 12) }, /revision|f3ff3571/);
  // A model AssetRef that is not the acquisition ZIP bundle.
  await assertRejectedBeforeGenerate(PARAMETERS, /zip|mediaType|bundle/, async (f) => ({
    model: (await storeAssetObject(f.root, { bytes: Buffer.from("raw-weights"), kind: "model", mediaType: "application/octet-stream", metadata: {} })).asset,
  }));
  // A model AssetRef whose stored bytes were tampered with never reaches the process.
  await assertRejectedBeforeGenerate(PARAMETERS, /sha|hash|mismatch|integrity/i, async (f) => {
    await writeFile(path.join(f.root, assetObjectPortablePath(f.model)), Buffer.from("tampered"));
    return { model: f.model };
  });
});
