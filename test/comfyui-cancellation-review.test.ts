/**
 * Regression tests for the Codex review findings on PR #247 (asset-tooling#224, scoped ComfyUI
 * cancellation). Written by the independent acceptance context; see
 * test/comfyui-cancellation.test.ts for the base contract (Atlas Decision 5.1.5).
 *
 * P1  runAssetOperation: cancellation wins every settlement race. An abort while
 *     verifyDependencies runs, or during cached-output verification, never returns a cached hit;
 *     an abort during output verification or the cache write on a miss leaves no cache entry
 *     (one that was just written is removed).
 * P2a An abort after the ComfyUI output was fetched, while/after it is stored, leaves no NEW object
 *     in .asset-tooling/objects; an object that already existed before the run is never removed.
 * P2b cancelPrompt deletes a queued prompt only when both the prompt id and the submitted client_id
 *     match; a queue entry with the run's prompt id but another client's client_id is not deleted
 *     and the cancellation is reported as ambiguous.
 *
 * Deterministic race seams (no timing): stub registrations with controllable promises, a Proxy
 * descriptor that aborts on the next access once armed, and an AbortSignal whose `aborted` /
 * `throwIfAborted` turn true (and abort the controller) as soon as a watched directory gains a file.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { resolveAssetObject, runAssetOperation, storeAssetObject } from "../src/asset-store.js";
import { createComfyUiImageGenerateRegistration, probeComfyUiServer } from "../src/comfyui-operation.js";
import {
  IMAGE_GENERATE_MODEL_PROFILES,
  createImageGenerateRegistration,
  resolveImageGenerateParameters,
} from "../src/image-generate-operation.js";
import { createAssetOperationRegistry } from "../src/operations.js";
import { startQueueFakeComfyUi, type QueueFake } from "./fixtures/comfyui-queue-fake-server.js";

const WORKFLOW_PATH = fileURLToPath(new URL("./fixtures/comfyui/sd15-txt2img.api.json", import.meta.url));
const CHECKPOINT_NAME = "sd15-fixture.safetensors";
const CHECKPOINT_BYTES = Buffer.from("fixture checkpoint bytes, never loaded by anything", "utf8");
const ROLES = ["diffusionModel", "textEncoder", "vae"] as const;
const FLUX = "flux2-klein-4b";
const RUN_TIMEOUT_MS = 4_000;
const TEST_TIMEOUT = 30_000;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  } catch {
    return [];
  }
}

function countFilesSync(directory: string): number {
  try {
    return readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

const cacheDir = (root: string) => path.join(root, ".asset-tooling", "cache");
const objectsDir = (root: string) => path.join(root, ".asset-tooling", "objects");

/** Keeps a run that a failed assertion leaves un-awaited from leaking its rejection into the next test. */
function guarded<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** Await a rejection that must be a cancellation: AbortError, message starting "cancelled". */
async function expectCancelled(promise: Promise<unknown>, label: string): Promise<Error> {
  let caught: unknown;
  let resolved: unknown;
  await promise.then(
    (value) => {
      resolved = value;
    },
    (error: unknown) => {
      caught = error;
    },
  );
  if (caught === undefined) {
    assert.fail(`${label}: expected the cancelled run to reject, but it resolved with status ${(resolved as any)?.status}`);
  }
  const error = caught as Error;
  assert.equal(error.name, "AbortError", `${label}: error name must be AbortError (got ${error.name}: ${error.message})`);
  assert.match(error.message, /^cancelled/i, `${label}: message must start with "cancelled"`);
  return error;
}

/**
 * An AbortSignal that becomes aborted the moment `trigger()` is true when anyone looks at it
 * (`aborted`, `reason`, `throwIfAborted`); the underlying controller is aborted then, so listeners fire too.
 */
function signalAbortingWhen(trigger: () => boolean): { controller: AbortController; signal: AbortSignal; fired(): boolean } {
  const controller = new AbortController();
  const signal = controller.signal;
  const native = {
    aborted: Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!,
    reason: Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")!.get!,
    throwIfAborted: AbortSignal.prototype.throwIfAborted,
  };
  let fired = false;
  const check = () => {
    if (!fired && trigger()) {
      fired = true;
      controller.abort();
    }
    return native.aborted.call(signal) as boolean;
  };
  Object.defineProperty(signal, "aborted", { configurable: true, get: check });
  Object.defineProperty(signal, "reason", {
    configurable: true,
    get() {
      check();
      return native.reason.call(signal);
    },
  });
  Object.defineProperty(signal, "throwIfAborted", {
    configurable: true,
    value() {
      check();
      return native.throwIfAborted.call(signal);
    },
  });
  return { controller, signal, fired: () => fired };
}

// ─── P1: runAssetOperation settlement races (stub registrations) ────────────────────────────────

const STUB_OPERATION = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "test.cancellation.review-stub",
    version: "1",
    label: "Cancellation review stub",
    description: "Stores one small blob; used to observe settlement races.",
    category: "image.generate",
    inputs: [],
    outputs: [{ id: "blob", label: "Blob", assetKinds: ["image"], mediaTypes: ["image/png"], cardinality: "single" }],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  } as any,
]).get("test.cancellation.review-stub", "1")!;

interface Stub {
  registration: any;
  executeCalls: number;
  /** When armed, the next access to `descriptor.outputs` runs `onArmedAccess` once. */
  arm(onArmedAccess: () => void): void;
}

function createStub(hooks: {
  verifyDependencies?: () => Promise<void>;
  afterExecute?: (stub: Stub) => void;
} = {}): Stub {
  let armed: (() => void) | undefined;
  const descriptor = new Proxy(STUB_OPERATION as any, {
    get(target, key, receiver) {
      if (key === "outputs" && armed) {
        const run = armed;
        armed = undefined;
        run();
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const stub: Stub = {
    executeCalls: 0,
    arm(onArmedAccess) {
      armed = onArmedAccess;
    },
    registration: undefined,
  };
  stub.registration = {
    descriptor,
    implementation: { id: "test.cancellation.review-stub", version: "1" },
    ...(hooks.verifyDependencies ? { verifyDependencies: () => hooks.verifyDependencies!() } : {}),
    async execute(root: string) {
      stub.executeCalls += 1;
      const stored = await storeAssetObject(root, { bytes: Buffer.from("review stub output"), kind: "image", mediaType: "image/png" });
      hooks.afterExecute?.(stub);
      return { outputs: { blob: stored.asset } };
    },
  };
  return stub;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-cancel-review-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const invoke = (root: string, registration: any, signal?: AbortSignal) =>
  guarded((runAssetOperation as any)(root, registration, { parameters: {}, inputs: {} }, signal ? { signal } : undefined));

/** Records a cache entry for the stub's invocation with an uncancelled run. */
async function primeCache(root: string, stub: Stub): Promise<void> {
  const first = await invoke(root, stub.registration);
  assert.equal(first.status, "miss");
  assert.equal((await listFiles(cacheDir(root))).length, 1, "the priming run records one cache entry");
}

test("#247 P1: an abort while verifyDependencies runs never returns the cached hit", async () => {
  await withRoot(async (root) => {
    let blockOnAbort = false;
    let entered!: () => void;
    const enteredVerify = new Promise<void>((resolve) => (entered = resolve));
    let signalForVerify: AbortSignal | undefined;
    const stub = createStub({
      async verifyDependencies() {
        if (!blockOnAbort) return;
        entered();
        // A slow dependency hash that completes successfully only after the cancel arrived.
        await new Promise<void>((resolve) => signalForVerify!.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    await primeCache(root, stub);
    const executesBefore = stub.executeCalls;

    blockOnAbort = true;
    const controller = new AbortController();
    signalForVerify = controller.signal;
    const run = invoke(root, stub.registration, controller.signal);
    await enteredVerify;
    controller.abort();
    await expectCancelled(run, "abort during verifyDependencies");
    assert.equal(stub.executeCalls, executesBefore, "a cancelled run never executes");
  });
}, TEST_TIMEOUT);

test("#247 P1: an abort during cached-output verification never returns the cached hit", async () => {
  await withRoot(async (root) => {
    const controller = new AbortController();
    let armOnVerify = false;
    let stub!: Stub;
    stub = createStub({
      // Runs after input verification, right before the cache lookup; the next descriptor access
      // is the hit branch normalising and verifying the cached outputs.
      async verifyDependencies() {
        if (armOnVerify) stub.arm(() => controller.abort());
      },
    });
    await primeCache(root, stub);
    armOnVerify = true;
    await expectCancelled(invoke(root, stub.registration, controller.signal), "abort during cached-output verification");
    assert.equal(controller.signal.aborted, true, "the race seam fired");
  });
}, TEST_TIMEOUT);

test("#247 P1: an abort during output verification on a miss leaves no cache entry", async () => {
  await withRoot(async (root) => {
    const controller = new AbortController();
    // Armed as execute returns: the next descriptor access is runAssetOperation normalising and
    // verifying the fresh result, i.e. after its post-execute cancellation check.
    const stub = createStub({ afterExecute: (self) => self.arm(() => controller.abort()) });
    await expectCancelled(invoke(root, stub.registration, controller.signal), "abort during output verification");
    assert.equal(controller.signal.aborted, true, "the race seam fired");
    assert.deepEqual(await listFiles(cacheDir(root)), [], "a cancelled miss records no cache entry");
  });
}, TEST_TIMEOUT);

test("#247 P1: an abort during the cache write on a miss removes the just-written entry", async () => {
  await withRoot(async (root) => {
    // The signal turns aborted as soon as a cache entry exists on disk.
    const { signal, fired } = signalAbortingWhen(() => countFilesSync(cacheDir(root)) > 0);
    const stub = createStub();
    const outcome = await invoke(root, stub.registration, signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    assert.ok(fired(), "the signal must be consulted after the cache entry was written (race seam fired)");
    assert.ok("error" in outcome, "the abort during the cache write must win: the run rejects");
    await expectCancelled(Promise.reject((outcome as any).error), "abort during the cache write");
    assert.deepEqual(await listFiles(cacheDir(root)), [], "the just-written cache entry is removed");
  });
}, TEST_TIMEOUT);

// ─── ComfyUI subjects (same setup as test/comfyui-cancellation.test.ts) ────────────────────────

interface SubjectSetup {
  /** Registration options are { timeoutMs, pollIntervalMs } overrides. */
  register(extra?: Record<string, unknown>): any;
  /** A valid invocation; `variant` changes the seed so two runs have distinct cache keys. */
  invocation(variant?: number): { parameters: any; inputs: any };
  /** Options for createAssetOperationWorkflowProviderEntries, when the subject has provider entries. */
  providerConfig?(extra?: Record<string, unknown>): Record<string, unknown>;
}

interface Subject {
  name: string;
  setup(root: string, fake: QueueFake): Promise<SubjectSetup>;
}

const comfyuiSubject: Subject = {
  name: "image.comfyui.generate@1",
  async setup(root, fake) {
    const workflow = (
      await storeAssetObject(root, {
        bytes: await readFile(WORKFLOW_PATH),
        kind: "workflow",
        mediaType: "application/json",
        metadata: { format: "comfyui-api-prompt" },
      })
    ).asset;
    const checkpointDirectory = path.join(root, "comfyui-models", "checkpoints");
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(path.join(checkpointDirectory, CHECKPOINT_NAME), CHECKPOINT_BYTES);
    const checkpoint = {
      name: CHECKPOINT_NAME,
      sha256: sha256(CHECKPOINT_BYTES),
      byteLength: CHECKPOINT_BYTES.byteLength,
      license: "creativeml-openrail-m",
    };
    const server = await probeComfyUiServer({ endpoint: fake.endpoint });
    const options = (extra: Record<string, unknown> = {}) => ({
      endpoint: fake.endpoint,
      server,
      checkpointDirectory,
      timeoutMs: RUN_TIMEOUT_MS,
      pollIntervalMs: 5,
      ...extra,
    });
    const parameters = (variant = 0) => ({
      provider: "comfyui",
      checkpoint,
      injections: {
        checkpoint: { node: "4", input: "ckpt_name" },
        seed: { node: "3", input: "seed", value: 1234 + variant },
        positivePrompt: { node: "6", input: "text", value: "a small red apple, game icon" },
        negativePrompt: { node: "7", input: "text", value: "blurry" },
        width: { node: "5", input: "width", value: 64 },
        height: { node: "5", input: "height", value: 48 },
      },
      output: { node: "9" },
    });
    return {
      register: (extra) => createComfyUiImageGenerateRegistration(options(extra)),
      invocation: (variant = 0) => ({ parameters: parameters(variant), inputs: { workflow } }),
      providerConfig: (extra) => options(extra),
    };
  },
};

const imageGenerateSubject: Subject = {
  name: "image.generate@1",
  async setup(root, fake) {
    const modelsDirectory = path.join(root, "comfyui-models");
    const profiles: Record<string, any> = {};
    for (const [id, profile] of Object.entries(IMAGE_GENERATE_MODEL_PROFILES)) {
      const clone = structuredClone(profile) as any;
      for (const role of ROLES) {
        const bytes = Buffer.from(`asset-tooling#224 fake model bytes for ${clone.files[role].name}`, "utf8");
        clone.files[role].sha256 = sha256(bytes);
        clone.files[role].byteLength = bytes.byteLength;
        await mkdir(path.join(modelsDirectory, clone.files[role].directory), { recursive: true });
        await writeFile(path.join(modelsDirectory, clone.files[role].directory, clone.files[role].name), bytes);
      }
      profiles[id] = clone;
    }
    const server = await probeComfyUiServer({ endpoint: fake.endpoint });
    return {
      register: (extra = {}) =>
        createImageGenerateRegistration({
          provider: "comfyui",
          endpoint: fake.endpoint,
          server,
          modelsDirectory,
          timeoutMs: RUN_TIMEOUT_MS,
          pollIntervalMs: 5,
          profiles,
          ...extra,
        } as any),
      invocation: (variant = 0) => ({
        parameters: resolveImageGenerateParameters({
          provider: "comfyui",
          model: FLUX,
          prompt: "a warden shield icon, flat game art",
          seed: 1234 + variant,
          width: 64,
          height: 48,
        } as any),
        inputs: {},
      }),
    };
  },
};

const SUBJECTS = [comfyuiSubject, imageGenerateSubject];

interface Harness extends SubjectSetup {
  root: string;
  fake: QueueFake;
  objects(): Promise<string[]>;
  cacheEntries(): Promise<string[]>;
}

async function withHarness(subject: Subject, run: (h: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-cancel-review-"));
  const fake = await startQueueFakeComfyUi();
  try {
    const setup = await subject.setup(root, fake);
    fake.requests.length = 0;
    await run({
      ...setup,
      root,
      fake,
      objects: () => listFiles(objectsDir(root)),
      cacheEntries: () => listFiles(cacheDir(root)),
    });
  } finally {
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const subject of SUBJECTS) {
  const name = subject.name;
  const runWith = (h: Harness, registration: any, signal: AbortSignal | undefined, variant = 0) =>
    guarded((runAssetOperation as any)(h.root, registration, h.invocation(variant), signal ? { signal } : undefined));

  // ─── P2a: the output import is cancellation-aware ─────────────────────────────────────────────

  test(`#247 P2a ${name}: an abort once the fetched output was stored removes the new object`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "done";
      const objectsBefore = await h.objects();
      // Aborts the moment the imported PNG lands in .asset-tooling/objects, i.e. after every
      // pre-import cancellation check and before the run settles.
      const { signal, fired } = signalAbortingWhen(() => countFilesSync(objectsDir(h.root)) > objectsBefore.length);
      const outcome = runWith(h, h.register(), signal);
      await expectCancelled(outcome, "abort while importing the output");
      assert.ok(fired(), "the race seam fired after the output was written");
      assert.equal(h.fake.views(), 1, "the output was fetched once");
      assert.deepEqual(await h.objects(), objectsBefore, "the newly created output object is removed");
      assert.deepEqual(await h.cacheEntries(), [], "nothing is cached");
      assert.equal(h.fake.interrupts(), 0);
    });
  }, TEST_TIMEOUT);

  test(`#247 P2a ${name}: an abort during the import never removes an object that existed before the run`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "done";
      // A first, uncancelled run imports the very bytes the next run will fetch.
      const first = await runWith(h, h.register(), undefined);
      assert.equal(first.status, "miss");
      const existing = first.result.outputs.image;
      const existingBytes = await resolveAssetObject(h.root, existing);
      await rm(cacheDir(h.root), { recursive: true, force: true }); // force a miss
      const objectsBefore = await h.objects();
      const viewsBefore = h.fake.views();

      // Aborts at the first look at the signal after the second /view was served from outside the
      // ComfyUI provider modules (the run-level settlement after the import).
      const { signal, fired } = signalAbortingWhen(() => {
        if (h.fake.views() <= viewsBefore) return false;
        const caller = (new Error().stack ?? "").split("\n").slice(2, 4).join("\n");
        return !/comfyui-transport|comfyui-operation|image-generate-operation/.test(caller);
      });
      await expectCancelled(runWith(h, h.register(), signal), "abort with a pre-existing output object");
      assert.ok(fired(), "the race seam fired");
      assert.equal(h.fake.views(), viewsBefore + 1, "the second run fetched the output");
      assert.deepEqual(await h.objects(), objectsBefore, "no object is added or removed");
      assert.deepEqual(await resolveAssetObject(h.root, existing), existingBytes, "the pre-existing object is intact");
      assert.deepEqual(await h.cacheEntries(), [], "nothing is cached");
    });
  }, TEST_TIMEOUT);

  // ─── P2b: queue ownership is prompt id AND client_id ──────────────────────────────────────────

  test(`#247 P2b ${name}: a queued entry with the run's prompt id but another client_id is never deleted`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "pending";
      const objectsBefore = await h.objects();
      const controller = new AbortController();
      const running = runWith(h, h.register(), controller.signal);
      await h.fake.waitFor(() => h.fake.ownJobs().length === 1, "POST /prompt");
      const job = h.fake.ownJobs()[0]!;
      const submittedClientId = job.clientId;
      // The answered prompt id now names a queue entry that carries another client's client_id
      // (a stale, reused or inconsistent POST /prompt answer).
      job.clientId = `someone-else-${crypto.randomUUID()}`;
      await h.fake.waitFor(() => h.fake.historyPolls(job.promptId) > 0, "first /history poll");
      controller.abort();
      const error = await expectCancelled(running, "foreign queue entry");
      assert.match(error.message, /ambiguous/i, "an entry this run cannot prove it owns is reported as ambiguous");
      assert.deepEqual(h.fake.queueDeletes(), [], "no POST /queue delete for an entry owned by another client_id");
      assert.equal(job.state, "pending", "the other client's queued prompt is untouched");
      assert.equal(h.fake.interrupts(), 0);
      assert.ok(submittedClientId.length > 0);
      await settle(50);
      assert.deepEqual(await h.objects(), objectsBefore);
      assert.deepEqual(await h.cacheEntries(), []);
    });
  }, TEST_TIMEOUT);
}
