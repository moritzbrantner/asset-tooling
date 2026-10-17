/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#224: cancel a ComfyUI job
 * without affecting other jobs.
 *
 * Written by a separate acceptance context before the implementation. Spec sources: the #224
 * issue and the owner answers of 2026-10-17 (Atlas Decision 5.1.5), docs/prd-comfyui-provider.md,
 * docs/comfyui-first.md and workflow-runner#8 (no implicit retry, no global interrupt).
 *
 * No ComfyUI is involved: test/fixtures/comfyui-queue-fake-server.ts is an in-process loopback
 * fake that models GET/POST /queue with pending and running prompts, foreign prompts of other
 * clients, held POST /prompt answers and test-controlled completion.
 *
 * ─── Interface under test ───────────────────────────────────────────────────────────────────────
 *
 *   runAssetOperation(root, registration, invocation, { signal })
 *     - already-aborted signal: rejects before execute, no ComfyUI request, nothing cached
 *     - the signal reaches registration.execute through its 3rd (context) argument as { signal }
 *     - a cancellation rejects with name "AbortError" and a message starting with "cancelled";
 *       its result is never cached and no output object is stored
 *   createAssetOperationWorkflowExecutor forwards the runner context.signal to the operation
 *     (plain registrations and provider entries from createAssetOperationWorkflowProviderEntries).
 *
 *   image.comfyui.generate@1 and image.generate@1 (ComfyUI provider):
 *     queued   -> POST /queue {"delete":[ownPromptId]} exactly once; "cancelled: ... deleted from the queue"
 *     running  -> no delete, no interrupt; cancelled, ambiguous / "may still finish", names the prompt id
 *     race     -> history already complete (or /view in flight) when aborted: cancel wins, nothing stored
 *     submit   -> abort during POST /prompt: own client_id pending in /queue is deleted; otherwise an
 *                 ambiguous submission naming the client_id; exactly one POST /prompt, never resubmitted
 *     prompt   -> abort is observed during the poll interval, not after it
 *     scope    -> no POST /interrupt ever; other clients' prompts untouched; a concurrent operation
 *                 completes normally
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import {
  createAssetOperationWorkflowExecutor,
  createAssetOperationWorkflowNodeTemplate,
  createAssetOperationWorkflowProviderEntries,
} from "../src/workflow-operations.js";
import { startQueueFakeComfyUi, type QueueFake, type QueueJob } from "./fixtures/comfyui-queue-fake-server.js";

const WORKFLOW_PATH = fileURLToPath(new URL("./fixtures/comfyui/sd15-txt2img.api.json", import.meta.url));
const CHECKPOINT_NAME = "sd15-fixture.safetensors";
const CHECKPOINT_BYTES = Buffer.from("fixture checkpoint bytes, never loaded by anything", "utf8");
const ROLES = ["diffusionModel", "textEncoder", "vae"] as const;
const FLUX = "flux2-klein-4b";
/** Bounded so that a baseline that ignores the signal fails by timing out instead of hanging. */
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

// ─── Subjects: the two ComfyUI-backed operations ────────────────────────────────────────────────

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

// ─── Harness ────────────────────────────────────────────────────────────────────────────────────

interface Harness extends SubjectSetup {
  root: string;
  fake: QueueFake;
  fetchCalls: string[];
  objects(): Promise<string[]>;
  cacheEntries(): Promise<string[]>;
  /** The only own job, once POST /prompt was received. */
  ownJob(index?: number): QueueJob;
  /** Waits until the own job has been polled at least once in /history. */
  waitForPolling(index?: number): Promise<QueueJob>;
}

async function withHarness(subject: Subject, run: (h: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-cancel-"));
  const fake = await startQueueFakeComfyUi();
  const original = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = Object.assign((input: any, init?: any) => {
    fetchCalls.push(input instanceof Request ? input.url : String(input));
    return original(input, init);
  }, original) as typeof fetch;
  try {
    const setup = await subject.setup(root, fake);
    fake.requests.length = 0;
    fetchCalls.length = 0;
    const ownJob = (index = 0) => {
      const job = fake.ownJobs()[index];
      assert.ok(job, `own job #${index} must have been submitted`);
      return job;
    };
    await run({
      ...setup,
      root,
      fake,
      fetchCalls,
      objects: () => listFiles(path.join(root, ".asset-tooling", "objects")),
      cacheEntries: () => listFiles(path.join(root, ".asset-tooling", "cache")),
      ownJob,
      async waitForPolling(index = 0) {
        await fake.waitFor(() => fake.ownJobs().length > index, `own POST /prompt #${index}`);
        const job = ownJob(index);
        await fake.waitFor(() => fake.historyPolls(job.promptId) > 0, `first /history poll of ${job.promptId}`);
        return job;
      },
    });
  } finally {
    globalThis.fetch = original;
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

/** Await a rejection that must be a cancellation: AbortError, message starting "cancelled". */
async function expectCancelled(promise: Promise<unknown>, label: string): Promise<Error> {
  let caught: unknown;
  await promise.then(
    () => assert.fail(`${label}: expected the cancelled run to reject`),
    (error: unknown) => {
      caught = error;
    },
  );
  assert.ok(caught instanceof Error || (typeof caught === "object" && caught !== null), `${label}: rejection must be an error object`);
  const error = caught as Error;
  assert.equal(error.name, "AbortError", `${label}: error name must be AbortError (got ${error.name}: ${error.message})`);
  assert.match(error.message, /^cancelled/i, `${label}: message must start with "cancelled"`);
  return error;
}

/** Cancellation never touches anything but its own prompts. */
function assertScoped(h: Harness): void {
  assert.equal(h.fake.interrupts(), 0, "POST /interrupt must never be called");
  const own = new Set(h.fake.ownJobs().map((job) => job.promptId));
  for (const body of h.fake.queueDeletes()) {
    assert.ok(body && typeof body === "object", "POST /queue must carry a JSON body");
    assert.deepEqual(Object.keys(body as object), ["delete"], "only a scoped {delete: [...]} queue mutation is allowed");
    for (const id of (body as any).delete) assert.ok(own.has(id), `may only delete its own prompt, not ${id}`);
  }
  for (const job of h.fake.jobs.values()) {
    if (job.foreign) assert.notEqual(job.state, "deleted", `foreign prompt ${job.promptId} must be untouched`);
  }
  const origin = new URL(h.fake.endpoint).origin;
  for (const url of h.fetchCalls) assert.equal(new URL(url).origin, origin, `network outside the endpoint: ${url}`);
}

async function assertNothingStored(h: Harness, objectsBefore: string[]): Promise<void> {
  assert.deepEqual(await h.objects(), objectsBefore, "a cancelled run must store no output object");
  assert.deepEqual(await h.cacheEntries(), [], "a cancelled run must record no cache entry");
}

/** Keeps a run that a failed assertion leaves un-awaited from leaking its rejection into the next test. */
function guarded<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── runAssetOperation: signal plumbing ─────────────────────────────────────────────────────────

const STUB_OPERATION = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "test.cancellation.stub",
    version: "1",
    label: "Cancellation stub",
    description: "Stores one small blob; used to observe signal plumbing.",
    category: "image.generate",
    inputs: [],
    outputs: [{ id: "blob", label: "Blob", assetKinds: ["image"], mediaTypes: ["image/png"], cardinality: "single" }],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  } as any,
]).get("test.cancellation.stub", "1")!;

function stubRegistration(execute: (root: string, invocation: any, context: any) => Promise<any>) {
  return {
    descriptor: STUB_OPERATION,
    implementation: { id: "test.cancellation.stub", version: "1" },
    execute,
  } as any;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-cancel-stub-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const storeBlob = async (root: string) =>
  ({ outputs: { blob: (await storeAssetObject(root, { bytes: Buffer.from("stub"), kind: "image", mediaType: "image/png" })).asset } });

test("#224: an already-aborted signal rejects before execute and caches nothing", async () => {
  await withRoot(async (root) => {
    let calls = 0;
    const registration = stubRegistration(async (r) => {
      calls += 1;
      return storeBlob(r);
    });
    const controller = new AbortController();
    controller.abort();
    await expectCancelled(
      (runAssetOperation as any)(root, registration, { parameters: {}, inputs: {} }, { signal: controller.signal }),
      "pre-aborted",
    );
    assert.equal(calls, 0, "execute must not be called");
    assert.deepEqual(await listFiles(path.join(root, ".asset-tooling", "cache")), []);
    assert.deepEqual(await listFiles(path.join(root, ".asset-tooling", "objects")), []);
  });
});

test("#224: the signal reaches registration.execute through its context argument", async () => {
  await withRoot(async (root) => {
    const controller = new AbortController();
    let seen: any;
    const registration = stubRegistration(async (r, _invocation, context) => {
      seen = context;
      return storeBlob(r);
    });
    const run = await (runAssetOperation as any)(root, registration, { parameters: {}, inputs: {} }, { signal: controller.signal });
    assert.equal(run.status, "miss");
    assert.ok(seen && seen.signal instanceof AbortSignal, "execute must receive { signal } as its 3rd argument");
    assert.equal(seen.signal.aborted, false);
    controller.abort();
    assert.equal(seen.signal.aborted, true, "the context signal must follow the caller's signal");
  });
});

test("#224: a signal aborted while execute runs is not cached even if execute returns a result", async () => {
  await withRoot(async (root) => {
    const controller = new AbortController();
    const registration = stubRegistration(async (r) => {
      const result = await storeBlob(r);
      controller.abort();
      return result;
    });
    await expectCancelled(
      (runAssetOperation as any)(root, registration, { parameters: {}, inputs: {} }, { signal: controller.signal }),
      "aborted during execute",
    );
    assert.deepEqual(await listFiles(path.join(root, ".asset-tooling", "cache")), [], "the result must not be cached");
  });
});

// ─── Both ComfyUI operations ────────────────────────────────────────────────────────────────────

for (const subject of SUBJECTS) {
  const name = subject.name;
  const runWith = (h: Harness, registration: any, signal: AbortSignal | undefined, variant = 0) =>
    guarded((runAssetOperation as any)(h.root, registration, h.invocation(variant), signal ? { signal } : undefined));

  test(`#224 ${name}: an unaborted signal changes nothing; the run completes without queue mutation`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "done";
      const controller = new AbortController();
      const run = await runWith(h, h.register(), controller.signal);
      assert.equal(run.status, "miss");
      assert.deepEqual(await resolveAssetObject(h.root, run.result.outputs.image), h.fake.servedImages[0]);
      assert.equal(h.fake.queueDeletes().length, 0, "no POST /queue without a cancel");
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: an already-aborted signal sends no ComfyUI request`, async () => {
    await withHarness(subject, async (h) => {
      const objectsBefore = await h.objects();
      const controller = new AbortController();
      controller.abort();
      await expectCancelled(runWith(h, h.register(), controller.signal), "pre-aborted");
      assert.equal(h.fake.requests.length, 0, "no request may reach ComfyUI");
      await assertNothingStored(h, objectsBefore);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: cancelling a queued prompt deletes only that prompt from the queue`, async () => {
    await withHarness(subject, async (h) => {
      const foreignPending = h.fake.addForeignJob("pending");
      const foreignRunning = h.fake.addForeignJob("running");
      h.fake.initialState = "pending";
      const objectsBefore = await h.objects();
      const controller = new AbortController();
      const running = runWith(h, h.register(), controller.signal);
      const job = await h.waitForPolling();
      controller.abort();
      const error = await expectCancelled(running, "queued");
      assert.match(error.message, /deleted from the queue/i);

      assert.deepEqual(h.fake.queueDeletes(), [{ delete: [job.promptId] }], "exactly one POST /queue deleting only its own prompt");
      assert.equal(job.state, "deleted", "its own pending prompt is removed");
      assert.equal(foreignPending.state, "pending", "another client's pending prompt is untouched");
      assert.equal(foreignRunning.state, "running", "another client's running prompt is untouched");
      assert.equal(h.fake.views(), 0, "no output is fetched");
      assert.equal(h.fake.promptPosts(), 1);
      await assertNothingStored(h, objectsBefore);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: cancelling a running prompt never interrupts it and reports it as ambiguous`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.addForeignJob("pending");
      h.fake.initialState = "running";
      const objectsBefore = await h.objects();
      const controller = new AbortController();
      const running = runWith(h, h.register(), controller.signal);
      const job = await h.waitForPolling();
      controller.abort();
      const error = await expectCancelled(running, "running");
      assert.match(error.message, /ambiguous|may still finish/i, "a running prompt is reported as ambiguous");
      assert.ok(error.message.includes(job.promptId), "the message names the prompt id");
      assert.equal(h.fake.queueDeletes().length, 0, "a running prompt is not deleted");
      assert.equal(job.state, "running");

      // The server finishes it later; the cancelled operation must not come back for the output.
      h.fake.setState(job.promptId, "done");
      await settle(150);
      assert.equal(h.fake.views(), 0, "a cancelled operation never fetches the late output");
      await assertNothingStored(h, objectsBefore);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: completion race — aborted as the history reports success, nothing is imported`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "done";
      const controller = new AbortController();
      h.fake.onCompletedHistory = () => controller.abort();
      const objectsBefore = await h.objects();
      await expectCancelled(runWith(h, h.register(), controller.signal), "completion race (history)");
      await settle(50);
      await assertNothingStored(h, objectsBefore);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: completion race — aborted while the output download is in flight, nothing is imported`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "done";
      const controller = new AbortController();
      h.fake.onView = () => controller.abort();
      const objectsBefore = await h.objects();
      await expectCancelled(runWith(h, h.register(), controller.signal), "completion race (view)");
      await settle(50);
      await assertNothingStored(h, objectsBefore);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: abort during POST /prompt deletes the prompt found pending under its client_id`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.addForeignJob("pending");
      h.fake.submitMode = "hold-enqueued";
      const objectsBefore = await h.objects();
      const controller = new AbortController();
      const running = runWith(h, h.register(), controller.signal);
      await h.fake.waitFor(() => h.fake.ownJobs().length === 1, "held POST /prompt");
      const job = h.ownJob();
      assert.ok(job.clientId.length > 0, "the submission carries a client_id");
      controller.abort();
      await expectCancelled(running, "abort during submission (queued)");
      assert.deepEqual(h.fake.queueDeletes(), [{ delete: [job.promptId] }], "deletes exactly its own prompt, found by client_id");
      assert.equal(job.state, "deleted");

      h.fake.releaseHeld();
      await settle(150);
      assert.equal(h.fake.promptPosts(), 1, "never resubmitted");
      assert.equal(h.fake.views(), 0);
      await assertNothingStored(h, objectsBefore);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: abort during POST /prompt with no queued prompt reports an ambiguous submission`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.addForeignJob("pending");
      h.fake.submitMode = "hold-not-enqueued";
      const objectsBefore = await h.objects();
      const controller = new AbortController();
      const running = runWith(h, h.register(), controller.signal);
      await h.fake.waitFor(() => h.fake.submissions.length === 1, "held POST /prompt");
      const clientId = String(h.fake.submissions[0]!.client_id);
      controller.abort();
      const error = await expectCancelled(running, "abort during submission (not queued)");
      assert.match(error.message, /ambiguous/i);
      assert.ok(error.message.includes(clientId), "the ambiguous submission names its client_id");
      assert.equal(h.fake.queueDeletes().length, 0, "nothing of its own was queued, so nothing is deleted");

      h.fake.releaseHeld();
      await settle(150);
      assert.equal(h.fake.promptPosts(), 1, "never resubmitted");
      await assertNothingStored(h, objectsBefore);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: abort during POST /prompt whose prompt is already running is ambiguous, not deleted`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.submitMode = "hold-running";
      const objectsBefore = await h.objects();
      const controller = new AbortController();
      const running = runWith(h, h.register(), controller.signal);
      await h.fake.waitFor(() => h.fake.ownJobs().length === 1, "held POST /prompt");
      const job = h.ownJob();
      controller.abort();
      const error = await expectCancelled(running, "abort during submission (running)");
      assert.match(error.message, /ambiguous|may still finish/i);
      assert.ok(
        error.message.includes(job.clientId) || error.message.includes(job.promptId),
        "the message names the client_id (or the running prompt id)",
      );
      assert.equal(h.fake.queueDeletes().length, 0, "a running prompt is not deleted");
      assert.equal(job.state, "running");

      h.fake.releaseHeld();
      await settle(150);
      assert.equal(h.fake.promptPosts(), 1, "never resubmitted");
      await assertNothingStored(h, objectsBefore);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: an abort during history polling is observed promptly, not after the poll interval`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "running";
      const controller = new AbortController();
      const running = runWith(h, h.register({ pollIntervalMs: 10_000, timeoutMs: 12_000 }), controller.signal);
      await h.waitForPolling();
      await settle(50); // now inside the 10 s poll delay
      const started = Date.now();
      controller.abort();
      await expectCancelled(running, "prompt abort");
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2_000, `the cancel must not wait out the 10 s poll interval (took ${elapsed} ms)`);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);

  test(`#224 ${name}: a concurrent operation of another job completes while the first is cancelled`, async () => {
    await withHarness(subject, async (h) => {
      h.fake.initialState = "pending";
      const registration = h.register();
      const first = new AbortController();
      const second = new AbortController();
      const runA = runWith(h, registration, first.signal, 0);
      const jobA = await h.waitForPolling(0);
      const runB = runWith(h, registration, second.signal, 1);
      const jobB = await h.waitForPolling(1);
      assert.notEqual(jobA.clientId, jobB.clientId, "each operation uses its own client_id");

      first.abort();
      await expectCancelled(runA, "first (cancelled)");
      assert.deepEqual(h.fake.queueDeletes(), [{ delete: [jobA.promptId] }], "only the first prompt is deleted");
      assert.equal(jobB.state, "pending", "the second prompt stays queued");

      h.fake.setState(jobB.promptId, "done");
      const result = await runB;
      assert.equal(result.status, "miss");
      const stored = await resolveAssetObject(h.root, result.result.outputs.image);
      assert.deepEqual(stored, h.fake.servedImages.at(-1));
      assert.equal(result.result.observations.promptId, jobB.promptId);
      assert.equal((await h.cacheEntries()).length, 1, "only the completed operation is cached");
      assert.equal(second.signal.aborted, false);
      assertScoped(h);
    });
  }, TEST_TIMEOUT);
}

// ─── Workflow executor forwards the runner signal ───────────────────────────────────────────────

async function executorCancelsQueued(h: Harness, registrations: any[], template: any, inputs: any): Promise<void> {
  h.fake.addForeignJob("pending");
  h.fake.initialState = "pending";
  const objectsBefore = await h.objects();
  const executor = createAssetOperationWorkflowExecutor({ root: h.root, registrations });
  const controller = new AbortController();
  const running = guarded(executor({ runId: "run-224", node: { ...template, id: "comfy" }, inputs, signal: controller.signal } as any));
  const job = await h.waitForPolling();
  controller.abort();
  await expectCancelled(running, "workflow executor");
  assert.deepEqual(h.fake.queueDeletes(), [{ delete: [job.promptId] }]);
  await assertNothingStored(h, objectsBefore);
  assertScoped(h);
}

test("#224: the workflow executor forwards context.signal to a plain ComfyUI registration", async () => {
  await withHarness(comfyuiSubject, async (h) => {
    const registration = h.register();
    const { parameters, inputs } = h.invocation();
    const template = createAssetOperationWorkflowNodeTemplate(registration.descriptor, { parameters });
    await executorCancelsQueued(h, [{ operation: registration.descriptor, execute: registration.execute }], template, inputs);
  });
}, TEST_TIMEOUT);

test("#224: the workflow executor forwards context.signal through provider entries", async () => {
  await withHarness(comfyuiSubject, async (h) => {
    const entries = createAssetOperationWorkflowProviderEntries({ comfyui: h.providerConfig!() });
    const { parameters, inputs } = h.invocation();
    const operation = entries.registrations[0].operation;
    const template = createAssetOperationWorkflowNodeTemplate(operation, { parameters });
    await executorCancelsQueued(h, entries.registrations, template, inputs);
  });
}, TEST_TIMEOUT);

test("#224: the workflow executor hands context.signal to a plain registration's execute", async () => {
  await withRoot(async (root) => {
    let seen: any;
    const executor = createAssetOperationWorkflowExecutor({
      root,
      registrations: [
        {
          operation: STUB_OPERATION,
          async execute(r: string, _invocation: any, context: any) {
            seen = context;
            return storeBlob(r);
          },
        },
      ],
    });
    const controller = new AbortController();
    const template = createAssetOperationWorkflowNodeTemplate(STUB_OPERATION as any, { parameters: {} });
    await executor({ runId: "run-224", node: { ...template, id: "stub" }, inputs: {}, signal: controller.signal } as any);
    assert.ok(seen?.signal instanceof AbortSignal, "execute's context must carry the runner signal");
    controller.abort();
    assert.equal(seen.signal.aborted, true);
  });
});
