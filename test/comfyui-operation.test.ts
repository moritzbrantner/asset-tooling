/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#212, execution slice:
 * run one prepared, byte-pinned ComfyUI API-format workflow on an explicit local ComfyUI server
 * through a versioned asset operation, import the real PNG output, and record an honest receipt.
 *
 * Written by a separate acceptance context before any implementation exists. Spec sources: the
 * #212 issue body and the owner decision of 2026-10-16 (SD 1.5 on CPU, local WSL, prove the
 * generic provider boundary only), docs/comfyui-first.md, docs/prd-comfyui-provider.md, Decision
 * Atlas 4.1.1 / 5.1.1 and workflow-runner#8 (no implicit retry, no global interrupt).
 *
 * These tests run in CI with no ComfyUI, torch or model: test/fixtures/comfyui-fake-server.ts is
 * an in-process Bun.serve fake of the documented local routes (/system_stats, /prompt,
 * /history/{id}, /view). The real-server run is test/comfyui-local-server.test.ts.
 *
 * ─── Seams (all exported from src/comfyui-operation.ts) ─────────────────────────────────────────
 *
 *   COMFYUI_IMAGE_GENERATE_OPERATION
 *     Descriptor `image.comfyui.generate@1`.
 *     inputs:  `workflow` single, required, assetKinds ["workflow"], mediaTypes ["application/json"]
 *     outputs: `image`    single,           assetKinds ["image"],    mediaTypes ["image/png"]
 *     The checkpoint is NOT an input port (a multi-GB file is not copied into the object store);
 *     it is a declared identity in the parameters, verified on disk before dispatch.
 *
 *   probeComfyUiServer({ endpoint, timeoutMs? }) -> Promise<ComfyUiServerIdentity>
 *     GET {endpoint}/system_stats only. Returns a canonical-JSON object that includes at least
 *     `comfyuiVersion` (system.comfyui_version) and the reported python/pytorch versions and
 *     device types. Volatile fields (ram_free, vram_free, ...) are excluded, so two probes of an
 *     unchanged server are deepEqual. An unreachable server rejects with /unavailable/.
 *
 *   createComfyUiImageGenerateRegistration({
 *       endpoint,             // explicit loopback http URL (127.0.0.1, localhost or [::1]); no
 *                             // default, no credentials in the URL, anything else is rejected
 *       server,               // ComfyUiServerIdentity from probeComfyUiServer
 *       comfyuiCommit?,       // 40-hex commit from the setup receipt, when known
 *       checkpointDirectory,  // the directory the server loads checkpoints from
 *       timeoutMs?,           // total budget for submit + completion (default implementation's)
 *       pollIntervalMs?,      // /history polling interval
 *     }) -> AssetOperationRunRegistration   (src/asset-store.ts, for runAssetOperation)
 *     - `implementation` is a plain object with id, version, the provider ("comfyui"), the server
 *       identity, the commit when given and `reproducibility: "approximate"`. Creating it performs
 *       no network access.
 *     - `execute` performs every request through `globalThis.fetch`, looked up at call time (the
 *       tests spy on it), only to `endpoint`.
 *
 *   Parameters (closed shape; any unknown field is rejected):
 *     {
 *       provider: "comfyui",                         // explicit provider selection, required
 *       checkpoint: { name, sha256, byteLength, license },
 *       injections: {                                // the ONLY way to change workflow values
 *         checkpoint:     { node, input },           // receives checkpoint.name
 *         seed:           { node, input, value },    // non-negative safe integer
 *         positivePrompt: { node, input, value },    // string
 *         negativePrompt?:{ node, input, value },    // string, optional
 *         width:          { node, input, value },    // positive integer, multiple of 8
 *         height:         { node, input, value },    // positive integer, multiple of 8
 *       },
 *       output: { node },                            // the SaveImage node whose image is imported
 *     }
 *   Each injection must name an existing node and an existing literal (non-link) input of that
 *   node. Violations reject before any network request.
 *
 *   Execution (on a runAssetOperation miss):
 *     1. Verify the workflow AssetRef via loadPreparedComfyUiApiWorkflow; validate parameters.
 *     2. Hash <checkpointDirectory>/<checkpoint.name>; it must exist and match sha256/byteLength.
 *     3. GET /system_stats; the identity must equal the registration's `server`, else fail closed.
 *     4. POST /prompt with exactly { prompt, client_id }: `prompt` is the verified workflow with
 *        only the declared injections applied; `client_id` is a non-empty string.
 *     5. Poll GET /history/{prompt_id} until that prompt's record completes, then GET /view for
 *        the declared output node's image, exactly once.
 *     6. Verify the PNG signature and that the IHDR size equals the injected width x height,
 *        store the bytes as kind "image" / "image/png" with metadata { width, height, ... }.
 *   No automatic retry of /prompt; no POST /interrupt (global); a POST /queue may only be
 *   { delete: [<own prompt_id>] }. No model download or any other URL.
 *
 *   Receipt: result.observations includes
 *     provider "comfyui", reproducibility "approximate", promptId, clientId,
 *     workflow.sha256, submittedPrompt.sha256 (sha256 of canonicalJson(submitted prompt)),
 *     comfyui.version (server-reported) and comfyui.commit (when configured),
 *     checkpoint { name, sha256, byteLength, license },
 *     output { node, filename, subfolder, type, sha256 (= stored image sha256) }.
 *
 *   Failure visibility: every failure rejects with an Error whose message names ComfyUI (except
 *   pre-network parameter validation) and the cause, and stores no output object and no cache
 *   entry. A timeout or lost response after the /prompt body was sent is reported as ambiguous
 *   (/ambiguous/), with the prompt_id when one was received.
 *
 * Out of scope here (#212 remainder): candidate vs approved state, gallery preview, bundle export,
 * AbortSignal cancellation through workflow-runner, provider choice/default against Diffusers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assetObjectPortablePath, resolveAssetObject, runAssetOperation, storeAssetObject } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetOperationCacheKey } from "../src/operations.js";
import {
  createAssetOperationWorkflowExecutor,
  createAssetOperationWorkflowNodeTemplate,
} from "../src/workflow-operations.js";
import { readPngSize, startFakeComfyUi, type FakeComfyUi, type FakeComfyUiBehaviour } from "./fixtures/comfyui-fake-server.js";

const WORKFLOW_PATH = fileURLToPath(new URL("./fixtures/comfyui/sd15-txt2img.api.json", import.meta.url));
const CHECKPOINT_NAME = "sd15-fixture.safetensors";
const CHECKPOINT_BYTES = Buffer.from("fixture checkpoint bytes, never loaded by anything", "utf8");
const COMFYUI_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface Seams {
  COMFYUI_IMAGE_GENERATE_OPERATION: any;
  probeComfyUiServer(options: Record<string, unknown>): Promise<any>;
  createComfyUiImageGenerateRegistration(options: Record<string, unknown>): any;
}

async function seams(): Promise<Seams> {
  let module: Record<string, unknown>;
  try {
    module = await import("../src/comfyui-operation.js");
  } catch (error) {
    assert.fail(`src/comfyui-operation.ts must exist and load (#212): ${(error as Error).message}`);
  }
  assert.equal(typeof module.COMFYUI_IMAGE_GENERATE_OPERATION, "object", "export COMFYUI_IMAGE_GENERATE_OPERATION (#212)");
  assert.equal(typeof module.probeComfyUiServer, "function", "export probeComfyUiServer (#212)");
  assert.equal(
    typeof module.createComfyUiImageGenerateRegistration,
    "function",
    "export createComfyUiImageGenerateRegistration (#212)",
  );
  return module as unknown as Seams;
}

interface FetchSpy {
  calls: string[];
  restore(): void;
}

function spyOnFetch(): FetchSpy {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const spy = (input: any, init?: any) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return original(input, init);
  };
  globalThis.fetch = Object.assign(spy, original) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  } catch {
    return [];
  }
}

interface Harness {
  root: string;
  api: Seams;
  fake: FakeComfyUi;
  spy: FetchSpy;
  workflow: any;
  workflowBytes: Buffer;
  checkpointDirectory: string;
  checkpoint: { name: string; sha256: string; byteLength: number; license: string };
  server: any;
  registration: any;
  register(options?: Record<string, unknown>): any;
  parameters(overrides?: Record<string, any>): any;
  objects(): Promise<string[]>;
  cacheEntries(): Promise<string[]>;
}

async function withHarness(
  options: { behaviour?: FakeComfyUiBehaviour; registration?: Record<string, unknown>; serverCheckpoints?: string[] },
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const api = await seams();
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-op-"));
  const fake = await startFakeComfyUi({
    behaviour: options.behaviour ?? "success",
    checkpoints: options.serverCheckpoints ?? [CHECKPOINT_NAME],
  });
  const spy = spyOnFetch();
  try {
    const workflowBytes = await readFile(WORKFLOW_PATH);
    const workflow = (
      await storeAssetObject(root, {
        bytes: workflowBytes,
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
    const server = await api.probeComfyUiServer({ endpoint: fake.endpoint });
    const register = (extra: Record<string, unknown> = {}) =>
      api.createComfyUiImageGenerateRegistration({
        endpoint: fake.endpoint,
        server,
        comfyuiCommit: COMFYUI_COMMIT,
        checkpointDirectory,
        timeoutMs: 10_000,
        pollIntervalMs: 5,
        ...options.registration,
        ...extra,
      });
    const registration = register();
    const harness: Harness = {
      root,
      api,
      fake,
      spy,
      workflow,
      workflowBytes,
      checkpointDirectory,
      checkpoint,
      server,
      registration,
      register,
      parameters(overrides = {}) {
        const injections = {
          checkpoint: { node: "4", input: "ckpt_name" },
          seed: { node: "3", input: "seed", value: 1234 },
          positivePrompt: { node: "6", input: "text", value: "a small red apple on a wooden table, game icon" },
          negativePrompt: { node: "7", input: "text", value: "blurry, text, watermark" },
          width: { node: "5", input: "width", value: 64 },
          height: { node: "5", input: "height", value: 48 },
          ...overrides.injections,
        };
        const { injections: _ignored, ...rest } = overrides;
        return { provider: "comfyui", checkpoint, injections, output: { node: "9" }, ...rest };
      },
      objects: () => listFiles(path.join(root, ".asset-tooling", "objects")),
      cacheEntries: () => listFiles(path.join(root, ".asset-tooling", "cache")),
    };
    // Probing is allowed network; the tests below look at what happens after it.
    fake.requests.length = 0;
    spy.calls.length = 0;
    await run(harness);
  } finally {
    spy.restore();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

function expectedPrompt(h: Harness, parameters: any): Record<string, any> {
  const prompt = JSON.parse(h.workflowBytes.toString("utf8"));
  prompt["4"].inputs.ckpt_name = parameters.checkpoint.name;
  for (const name of ["seed", "positivePrompt", "negativePrompt", "width", "height"]) {
    const injection = parameters.injections[name];
    if (injection) prompt[injection.node].inputs[injection.input] = injection.value;
  }
  return prompt;
}

const ALLOWED_PATHS = /^\/(system_stats|prompt|history\/[^/]+|view|queue)$/;

function assertOnlyDocumentedRoutes(h: Harness): void {
  for (const request of h.fake.requests) {
    assert.match(request.path, ALLOWED_PATHS, `unexpected ComfyUI request ${request.method} ${request.path}`);
    if (request.path === "/queue") {
      assert.equal(request.method, "POST");
      assert.deepEqual(Object.keys(request.body as object), ["delete"], "only a scoped queue delete is allowed");
      for (const id of (request.body as any).delete) assert.ok(h.fake.promptIds.includes(id), "may only delete its own prompt");
    }
  }
  assert.equal(
    h.fake.requests.some((request) => request.path === "/interrupt"),
    false,
    "must never issue a global interrupt",
  );
  const origin = new URL(h.fake.endpoint).origin;
  for (const url of h.spy.calls) assert.equal(new URL(url).origin, origin, `network outside the configured endpoint: ${url}`);
}

async function assertFailsWithoutOutput(h: Harness, run: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const objectsBefore = await h.objects();
  let caught: unknown;
  await run.then(
    () => assert.fail("expected the ComfyUI run to fail visibly"),
    (error: unknown) => {
      caught = error;
    },
  );
  assert.ok(caught instanceof Error, "failure must be an Error");
  assert.match(caught.message, pattern);
  assert.deepEqual(await h.objects(), objectsBefore, "a failed run must not store any output object");
  assert.deepEqual(await h.cacheEntries(), [], "a failed run must not record an operation cache entry");
  return caught;
}

// ─── Descriptor and editor bridge ───────────────────────────────────────────────────────────────

test("#212: image.comfyui.generate@1 takes a verified workflow and produces one PNG image", async () => {
  const { COMFYUI_IMAGE_GENERATE_OPERATION: operation } = await seams();
  assert.equal(operation.id, "image.comfyui.generate");
  assert.equal(operation.version, "1");
  assert.deepEqual(
    operation.inputs.map((port: any) => [port.id, port.assetKinds, port.mediaTypes, port.cardinality, port.required]),
    [["workflow", ["workflow"], ["application/json"], "single", true]],
  );
  assert.deepEqual(
    operation.outputs.map((port: any) => [port.id, port.assetKinds, port.mediaTypes, port.cardinality]),
    [["image", ["image"], ["image/png"], "single"]],
  );
  const template = createAssetOperationWorkflowNodeTemplate(operation);
  assert.equal(template.id, "asset-operation:image.comfyui.generate@1");
});

// ─── Probe and registration ─────────────────────────────────────────────────────────────────────

test("#212: probing reads only /system_stats and ignores volatile memory figures", async () => {
  await withHarness({}, async (h) => {
    const first = await h.api.probeComfyUiServer({ endpoint: h.fake.endpoint });
    h.fake.ramFree = 42;
    const second = await h.api.probeComfyUiServer({ endpoint: h.fake.endpoint });
    assert.equal(first.comfyuiVersion, "0.3.66");
    assert.match(JSON.stringify(first), /2\.8\.0\+cpu/, "the reported pytorch version is part of the identity");
    assert.doesNotThrow(() => canonicalJson(first), "probe identity is canonical JSON");
    assert.deepEqual(second, first, "ram_free/vram_free must not change the server identity");
    assert.deepEqual(
      h.fake.requests.map((request) => `${request.method} ${request.path}`),
      ["GET /system_stats", "GET /system_stats"],
    );
    assertOnlyDocumentedRoutes(h);
  });
});

test("#212: the provider endpoint is an explicit local URL without credentials; registration does no I/O", async () => {
  await withHarness({}, async (h) => {
    for (const endpoint of [
      undefined,
      "",
      "http://example.com:8188",
      "http://192.0.2.10:8188",
      "http://user:secret@127.0.0.1:8188",
      "ftp://127.0.0.1:8188",
      "not a url",
    ]) {
      assert.throws(() => h.register({ endpoint }), Error, `endpoint ${String(endpoint)} must be rejected`);
    }
    for (const endpoint of ["http://127.0.0.1:8188", "http://localhost:8188", "http://[::1]:8188"]) {
      const registration = h.register({ endpoint });
      assert.equal(typeof registration.execute, "function");
    }
    assert.equal(h.fake.requests.length, 0, "creating a registration must not contact ComfyUI");
    assert.equal(h.spy.calls.length, 0);

    const implementation = h.registration.implementation;
    assert.equal(typeof implementation.id, "string");
    assert.equal(typeof implementation.version, "string");
    assert.equal(implementation.reproducibility, "approximate");
    const text = JSON.stringify(implementation);
    assert.match(text, /comfyui/i);
    assert.match(text, /0\.3\.66/, "server-reported ComfyUI version belongs to the implementation identity");
    assert.ok(text.includes(COMFYUI_COMMIT), "a configured ComfyUI commit belongs to the implementation identity");
    assert.equal(h.registration.descriptor.id, "image.comfyui.generate");
  });
});

// ─── Successful run ─────────────────────────────────────────────────────────────────────────────

test("#212: a run submits the verified workflow plus only declared injections and imports the real PNG", async () => {
  await withHarness({}, async (h) => {
    const parameters = h.parameters();
    const run = await runAssetOperation(h.root, h.registration, { parameters, inputs: { workflow: h.workflow } });
    assert.equal(run.status, "miss");

    // Submission: exactly one, the native graph plus only the declared injections, own client_id.
    assert.equal(h.fake.submissions.length, 1);
    const submission = h.fake.submissions[0]!;
    assert.deepEqual(Object.keys(submission).sort(), ["client_id", "prompt"], "submit only {prompt, client_id}");
    assert.equal(typeof submission.client_id, "string");
    assert.ok((submission.client_id as string).length > 0, "client_id must be set");
    assert.deepEqual(submission.prompt, expectedPrompt(h, parameters));
    // The stored workflow source is untouched.
    assert.deepEqual(await resolveAssetObject(h.root, h.workflow), h.workflowBytes);

    // Output: the actual served bytes, verified and stored as a content-addressed PNG.
    const image = run.result.outputs.image as any;
    assert.equal(image.kind, "image");
    assert.equal(image.mediaType, "image/png");
    assert.equal(h.fake.servedImages.length, 1, "the output is fetched exactly once");
    const served = h.fake.servedImages[0]!;
    const stored = await resolveAssetObject(h.root, image);
    assert.deepEqual(stored, served);
    assert.equal(image.sha256, sha256(served));
    assert.deepEqual(stored.subarray(0, 8), PNG_SIGNATURE);
    assert.deepEqual(readPngSize(stored), { width: 64, height: 48 });
    assert.equal(image.metadata.width, 64);
    assert.equal(image.metadata.height, 48);
    const objectFile = path.join(h.root, ...assetObjectPortablePath(image).split("/"));
    assert.deepEqual(await readFile(objectFile), served);

    // Receipt.
    const receipt = run.result.observations as any;
    assert.equal(receipt.provider, "comfyui");
    assert.equal(receipt.reproducibility, "approximate", "a seed is not proof of byte-identical replay");
    assert.equal(receipt.promptId, h.fake.promptIds[0]);
    assert.equal(receipt.clientId, submission.client_id);
    assert.equal(receipt.workflow.sha256, h.workflow.sha256);
    assert.equal(receipt.submittedPrompt.sha256, sha256(canonicalJson(submission.prompt)));
    assert.equal(receipt.comfyui.version, "0.3.66");
    assert.equal(receipt.comfyui.commit, COMFYUI_COMMIT);
    assert.deepEqual(receipt.checkpoint, h.checkpoint);
    assert.equal(receipt.output.node, "9");
    assert.equal(receipt.output.filename, "asset-tooling-212_00001_.png");
    assert.equal(receipt.output.subfolder, "");
    assert.equal(receipt.output.type, "output");
    assert.equal(receipt.output.sha256, image.sha256);
    assert.equal(run.buildIdentity.implementation.reproducibility, "approximate");

    // Transport: documented routes only, history polled until complete, all via fetch to the endpoint.
    assert.ok(h.fake.requests.filter((request) => request.path.startsWith("/history/")).length >= 2, "history is polled");
    assert.ok(
      h.fake.requests.every((request) => !request.path.startsWith("/history/") || request.path === `/history/${h.fake.promptIds[0]}`),
      "history is read for its own prompt id only",
    );
    assert.ok(h.spy.calls.length >= 4, "requests go through globalThis.fetch");
    assertOnlyDocumentedRoutes(h);
  });
});

test("#212: an unchanged invocation is a cache hit with no ComfyUI or network access", async () => {
  await withHarness({}, async (h) => {
    const invocation = { parameters: h.parameters(), inputs: { workflow: h.workflow } };
    const first = await runAssetOperation(h.root, h.registration, invocation);
    const requestsAfterFirst = h.fake.requests.length;
    const callsAfterFirst = h.spy.calls.length;

    const second = await runAssetOperation(h.root, h.registration, invocation);
    assert.equal(second.status, "hit");
    assert.deepEqual(second.result, first.result);
    // A fresh registration from the same recorded probe hits too, still without contacting the server.
    const third = await runAssetOperation(h.root, h.register(), invocation);
    assert.equal(third.status, "hit");
    assert.equal(h.fake.requests.length, requestsAfterFirst, "a hit must not contact ComfyUI");
    assert.equal(h.spy.calls.length, callsAfterFirst, "a hit must not use the network");

    // Changing a declared injection is a different build and runs again.
    const reseeded = await runAssetOperation(h.root, h.registration, {
      parameters: h.parameters({ injections: { seed: { node: "3", input: "seed", value: 99 } } }),
      inputs: { workflow: h.workflow },
    });
    assert.equal(reseeded.status, "miss");
    assert.equal(h.fake.submissions.length, 2);
    assert.equal(h.fake.submissions[1]!.prompt["3"].inputs.seed, 99);
  });
});

test("#212: build identity changes with workflow, injections, checkpoint and server-reported versions", async () => {
  await withHarness({}, async (h) => {
    const key = (registration: any, parameters: any, workflow = h.workflow) =>
      createAssetOperationCacheKey({
        operation: registration.descriptor,
        implementation: registration.implementation,
        parameters,
        inputs: { workflow },
      });
    const base = key(h.registration, h.parameters());
    assert.equal(key(h.register(), h.parameters()), base, "identity is stable for an unchanged declaration");

    const otherWorkflowBytes = Buffer.from(h.workflowBytes.toString("utf8").replace('"steps": 4', '"steps": 5'), "utf8");
    const otherWorkflow = (
      await storeAssetObject(h.root, { bytes: otherWorkflowBytes, kind: "workflow", mediaType: "application/json", metadata: { format: "comfyui-api-prompt" } })
    ).asset;
    const variants: Record<string, string> = {
      workflow: key(h.registration, h.parameters(), otherWorkflow),
      seed: key(h.registration, h.parameters({ injections: { seed: { node: "3", input: "seed", value: 1235 } } })),
      positivePrompt: key(h.registration, h.parameters({ injections: { positivePrompt: { node: "6", input: "text", value: "a green pear" } } })),
      width: key(h.registration, h.parameters({ injections: { width: { node: "5", input: "width", value: 72 } } })),
      checkpoint: key(h.registration, h.parameters({ checkpoint: { ...h.checkpoint, sha256: "b".repeat(64) } })),
      licence: key(h.registration, h.parameters({ checkpoint: { ...h.checkpoint, license: "other-licence" } })),
      commit: key(h.register({ comfyuiCommit: "f".repeat(40) }), h.parameters()),
    };
    h.fake.comfyuiVersion = "0.3.67";
    const reprobed = await h.api.probeComfyUiServer({ endpoint: h.fake.endpoint });
    variants.serverVersion = key(h.register({ server: reprobed }), h.parameters());

    for (const [name, variant] of Object.entries(variants)) assert.notEqual(variant, base, `${name} must change the build identity`);
    assert.equal(new Set(Object.values(variants)).size, Object.keys(variants).length, "each change yields a distinct identity");
  });
});

test("#212: the operation runs through the workflow-editor/runner bridge", async () => {
  await withHarness({}, async (h) => {
    const executor = createAssetOperationWorkflowExecutor({
      root: h.root,
      registrations: [{ operation: h.registration.descriptor, execute: h.registration.execute }],
    });
    const template = createAssetOperationWorkflowNodeTemplate(h.registration.descriptor, { parameters: h.parameters() });
    const result = await executor({ runId: "run-212", node: { ...template, id: "comfy" }, inputs: { workflow: h.workflow } });
    const image = (result as any).outputs.image;
    assert.equal(image.mediaType, "image/png");
    assert.deepEqual(await resolveAssetObject(h.root, image), h.fake.servedImages[0]);
  });
});

// ─── Fail closed before any network ─────────────────────────────────────────────────────────────

test("#212: undeclared overrides, bad bindings and a missing provider selection reject before any request", async () => {
  await withHarness({}, async (h) => {
    const cases: [string, any, RegExp][] = [
      ["missing provider", (({ provider: _p, ...rest }) => rest)(h.parameters()), /provider/i],
      ["other provider", h.parameters({ provider: "diffusers" }), /provider/i],
      ["unknown top-level field", h.parameters({ hiddenDownload: true }), /hiddenDownload/],
      ["undeclared injection name", h.parameters({ injections: { steps: { node: "3", input: "steps", value: 50 } } }), /steps/],
      ["injection into a missing node", h.parameters({ injections: { seed: { node: "99", input: "seed", value: 1 } } }), /99/],
      ["injection into a missing input", h.parameters({ injections: { seed: { node: "3", input: "noise_seed", value: 1 } } }), /noise_seed/],
      ["injection replacing a link", h.parameters({ injections: { positivePrompt: { node: "6", input: "clip", value: "x" } } }), /clip|link/i],
      ["value on the checkpoint injection", h.parameters({ injections: { checkpoint: { node: "4", input: "ckpt_name", value: "other.safetensors" } } }), /checkpoint|value/i],
      ["missing required injection", h.parameters({ injections: { seed: undefined } }), /seed/],
      ["non-integer seed", h.parameters({ injections: { seed: { node: "3", input: "seed", value: 1.5 } } }), /seed/],
      ["negative seed", h.parameters({ injections: { seed: { node: "3", input: "seed", value: -1 } } }), /seed/],
      ["non-string prompt", h.parameters({ injections: { positivePrompt: { node: "6", input: "text", value: 7 } } }), /positivePrompt|prompt/i],
      ["zero width", h.parameters({ injections: { width: { node: "5", input: "width", value: 0 } } }), /width/],
      ["width not a multiple of 8", h.parameters({ injections: { width: { node: "5", input: "width", value: 65 } } }), /width/],
      ["missing licence", h.parameters({ checkpoint: { ...h.checkpoint, license: undefined } }), /licen[cs]e/i],
      ["bad checkpoint sha", h.parameters({ checkpoint: { ...h.checkpoint, sha256: "nope" } }), /sha256/],
      ["checkpoint name escaping the directory", h.parameters({ checkpoint: { ...h.checkpoint, name: "../secret.safetensors" } }), /checkpoint|name|\.\./i],
      ["output node missing", h.parameters({ output: { node: "42" } }), /output|42/i],
    ];
    for (const [label, parameters, pattern] of cases) {
      // JSON round trip drops `undefined` members the way a serialized invocation would.
      const invocation = { parameters: JSON.parse(JSON.stringify(parameters)), inputs: { workflow: h.workflow } };
      await assert.rejects(runAssetOperation(h.root, h.registration, invocation), pattern, label);
    }
    assert.equal(h.fake.requests.length, 0, "invalid declarations must not reach ComfyUI");
    assert.equal(h.spy.calls.length, 0, "invalid declarations must not use the network");
    assert.deepEqual(await h.cacheEntries(), []);
  });
});

test("#212: a missing or mismatching local checkpoint fails before submission and never downloads", async () => {
  await withHarness({}, async (h) => {
    const checkpointFile = path.join(h.checkpointDirectory, CHECKPOINT_NAME);
    await writeFile(checkpointFile, Buffer.from("tampered checkpoint", "utf8"));
    await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /checkpoint/i,
    );
    await rm(checkpointFile);
    await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /checkpoint/i,
    );
    assert.equal(h.fake.submissions.length, 0, "no prompt is submitted without the declared checkpoint");
    assertOnlyDocumentedRoutes(h);
  });
});

test("#212: a server whose reported identity drifted since the probe fails closed before submission", async () => {
  await withHarness({}, async (h) => {
    h.fake.comfyuiVersion = "0.4.0";
    await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI[\s\S]*(drift|differ|changed|mismatch)/i,
    );
    assert.equal(h.fake.submissions.length, 0);
  });
});

test("#212: an unavailable server fails visibly", async () => {
  await withHarness({}, async (h) => {
    await h.fake.stop();
    await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI[\s\S]*unavailable/i,
    );
    await assert.rejects(h.api.probeComfyUiServer({ endpoint: h.fake.endpoint }), /unavailable/i);
    const origin = new URL(h.fake.endpoint).origin;
    for (const url of h.spy.calls) assert.equal(new URL(url).origin, origin, "no fallback endpoint or cloud provider");
  });
});

// ─── Failures reported by ComfyUI ───────────────────────────────────────────────────────────────

test("#212: a graph rejected with node_errors fails visibly with the node and reason", async () => {
  await withHarness({ behaviour: "node-errors" }, async (h) => {
    const error = await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI/,
    );
    assert.match(error.message, /value_not_in_list|Value not in list/);
    assert.match(error.message, /\b4\b/, "names the failing node");
    assert.equal(h.fake.submissions.length, 1, "a rejected prompt is not resubmitted");
    assertOnlyDocumentedRoutes(h);
  });
});

test("#212: a checkpoint the server does not have surfaces ComfyUI's validation error", async () => {
  await withHarness({ serverCheckpoints: ["something-else.safetensors"] }, async (h) => {
    const error = await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI/,
    );
    assert.ok(error.message.includes(CHECKPOINT_NAME), "names the missing checkpoint");
    assert.equal(h.fake.submissions.length, 1);
  });
});

test("#212: an execution error in history fails visibly with the prompt id and ComfyUI's message", async () => {
  await withHarness({ behaviour: "execution-error" }, async (h) => {
    const error = await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI/,
    );
    assert.match(error.message, /fake sampler exploded/);
    assert.ok(error.message.includes(h.fake.promptIds[0]!), "names the prompt id");
    assert.equal(h.fake.submissions.length, 1);
    assert.equal(h.fake.servedImages.length, 0, "no output is fetched from a failed run");
    assertOnlyDocumentedRoutes(h);
  });
});

test("#212: a timeout after acceptance is ambiguous, names the prompt id, and is neither retried nor globally interrupted", async () => {
  await withHarness({ behaviour: "never-completes", registration: { timeoutMs: 300, pollIntervalMs: 5 } }, async (h) => {
    const started = Date.now();
    const error = await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI[\s\S]*ambiguous|ambiguous[\s\S]*ComfyUI/i,
    );
    assert.ok(Date.now() - started < 5_000, "the configured timeout bounds the run");
    assert.ok(error.message.includes(h.fake.promptIds[0]!), "reports the accepted prompt id");
    assert.equal(h.fake.submissions.length, 1, "an accepted job is never resubmitted automatically");
    assertOnlyDocumentedRoutes(h);
  });
});

test("#212: a lost /prompt response is ambiguous and is not retried", async () => {
  await withHarness({ behaviour: "submit-hangs", registration: { timeoutMs: 300, pollIntervalMs: 5 } }, async (h) => {
    await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI[\s\S]*ambiguous|ambiguous[\s\S]*ComfyUI/i,
    );
    assert.equal(h.fake.submissions.length, 1, "a possibly accepted job is never resubmitted automatically");
    assertOnlyDocumentedRoutes(h);
  });
});

test("#212: history for a different prompt id or without the declared output is malformed, not imported", async () => {
  for (const behaviour of ["unknown-prompt-id", "malformed-history"] as const) {
    await withHarness({ behaviour, registration: { timeoutMs: 1_000, pollIntervalMs: 5 } }, async (h) => {
      await assertFailsWithoutOutput(
        h,
        runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
        /ComfyUI/,
      );
      assert.equal(h.fake.servedImages.length, 0, `${behaviour}: no output is fetched`);
      assert.equal(h.fake.submissions.length, 1, `${behaviour}: not resubmitted`);
    });
  }
});

// ─── Output verification ────────────────────────────────────────────────────────────────────────

test("#212: non-PNG output bytes are rejected", async () => {
  await withHarness({ behaviour: "non-png" }, async (h) => {
    await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI[\s\S]*PNG/,
    );
  });
});

test("#212: a PNG whose size differs from the injected width and height is rejected", async () => {
  await withHarness({ behaviour: "wrong-size" }, async (h) => {
    await assertFailsWithoutOutput(
      h,
      runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } }),
      /ComfyUI[\s\S]*(dimension|size|width|72)/i,
    );
  });
});

test("#212: the stored and recorded output are the bytes of the single fetch, even if the server would serve others later", async () => {
  await withHarness({ behaviour: "unstable-view" }, async (h) => {
    const run = await runAssetOperation(h.root, h.registration, { parameters: h.parameters(), inputs: { workflow: h.workflow } });
    assert.equal(h.fake.servedImages.length, 1, "the output is fetched exactly once");
    const image = run.result.outputs.image as any;
    assert.equal(image.sha256, sha256(h.fake.servedImages[0]!));
    assert.equal((run.result.observations as any).output.sha256, image.sha256);
    assert.deepEqual(await resolveAssetObject(h.root, image), h.fake.servedImages[0]);
  });
});
