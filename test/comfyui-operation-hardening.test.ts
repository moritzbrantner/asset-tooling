/**
 * Regressions for the Codex review of PR #219 (asset-tooling#212):
 *   1. ComfyUI requests never follow redirects, so nothing leaves the validated loopback origin.
 *   2. Declared dependencies (the checkpoint) are verified before every cache lookup, through the
 *      optional `verifyDependencies` hook of `runAssetOperation`; hits included.
 *   3. History is imported only on an unambiguous success.
 * The #212 acceptance fake is reused unchanged behind test/fixtures/comfyui-proxy.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runAssetOperation, storeAssetObject, type AssetOperationRunRegistration } from "../src/asset-store.js";
import { createComfyUiImageGenerateRegistration, probeComfyUiServer } from "../src/comfyui-operation.js";
import { startFakeComfyUi, type FakeComfyUi } from "./fixtures/comfyui-fake-server.js";
import { startComfyUiProxy, startTrapServer, type ComfyUiProxy, type TrapServer } from "./fixtures/comfyui-proxy.js";

const WORKFLOW_PATH = fileURLToPath(new URL("./fixtures/comfyui/sd15-txt2img.api.json", import.meta.url));
const CHECKPOINT_NAME = "sd15-fixture.safetensors";
const CHECKPOINT_BYTES = Buffer.from("fixture checkpoint bytes, never loaded by anything", "utf8");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  } catch {
    return [];
  }
}

interface Rig {
  root: string;
  fake: FakeComfyUi;
  proxy: ComfyUiProxy;
  trap: TrapServer;
  checkpointFile: string;
  registration: AssetOperationRunRegistration;
  invocation: { parameters: Record<string, unknown>; inputs: Record<string, unknown> };
  objects(): Promise<string[]>;
  cacheEntries(): Promise<string[]>;
}

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-hardening-"));
  const fake = await startFakeComfyUi({ checkpoints: [CHECKPOINT_NAME] });
  const proxy = await startComfyUiProxy(fake.endpoint);
  const trap = await startTrapServer();
  try {
    const workflow = (
      await storeAssetObject(root, {
        bytes: await readFile(WORKFLOW_PATH),
        kind: "workflow",
        mediaType: "application/json",
        metadata: { format: "comfyui-api-prompt" },
      })
    ).asset;
    const checkpointDirectory = path.join(root, "models", "checkpoints");
    await mkdir(checkpointDirectory, { recursive: true });
    const checkpointFile = path.join(checkpointDirectory, CHECKPOINT_NAME);
    await writeFile(checkpointFile, CHECKPOINT_BYTES);
    const server = await probeComfyUiServer({ endpoint: proxy.endpoint });
    const registration = createComfyUiImageGenerateRegistration({
      endpoint: proxy.endpoint,
      server,
      checkpointDirectory,
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    });
    const parameters = {
      provider: "comfyui",
      checkpoint: { name: CHECKPOINT_NAME, sha256: sha256(CHECKPOINT_BYTES), byteLength: CHECKPOINT_BYTES.byteLength, license: "creativeml-openrail-m" },
      injections: {
        checkpoint: { node: "4", input: "ckpt_name" },
        seed: { node: "3", input: "seed", value: 7 },
        positivePrompt: { node: "6", input: "text", value: "a shield" },
        width: { node: "5", input: "width", value: 64 },
        height: { node: "5", input: "height", value: 48 },
      },
      output: { node: "9" },
    };
    fake.requests.length = 0;
    await run({
      root,
      fake,
      proxy,
      trap,
      checkpointFile,
      registration,
      invocation: { parameters, inputs: { workflow } },
      objects: () => listFiles(path.join(root, ".asset-tooling", "objects")),
      cacheEntries: () => listFiles(path.join(root, ".asset-tooling", "cache")),
    });
  } finally {
    await trap.stop();
    await proxy.stop();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function assertRejectsWithoutOutput(rig: Rig, run: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const objectsBefore = await rig.objects();
  const cacheBefore = await rig.cacheEntries();
  let caught: unknown;
  await run.then(
    () => assert.fail("expected the ComfyUI run to fail visibly"),
    (error: unknown) => {
      caught = error;
    },
  );
  assert.ok(caught instanceof Error);
  assert.match(caught.message, pattern);
  assert.deepEqual(await rig.objects(), objectsBefore, "no output object is stored");
  assert.deepEqual(await rig.cacheEntries(), cacheBefore, "no cache entry is recorded");
  return caught;
}

// ─── 1. Redirects ───────────────────────────────────────────────────────────────────────────────

const ROUTES: [string, (url: URL) => boolean][] = [
  ["/system_stats", (url) => url.pathname === "/system_stats"],
  ["/prompt", (url) => url.pathname === "/prompt"],
  ["/history/{id}", (url) => url.pathname.startsWith("/history/")],
  ["/view", (url) => url.pathname === "/view"],
];

for (const [label, matches] of ROUTES) {
  for (const status of [302, 307]) {
    test(`#219: a ${status} redirect on ${label} is rejected and its target is never contacted`, async () => {
      await withRig(async (rig) => {
        rig.proxy.intercept = (_request, url) =>
          matches(url) ? new Response(null, { status, headers: { location: `${rig.trap.origin}${url.pathname}${url.search}` } }) : undefined;
        const error = await assertRejectsWithoutOutput(rig, runAssetOperation(rig.root, rig.registration, rig.invocation), /ComfyUI/);
        assert.match(error.message, /redirect/i);
        assert.deepEqual(rig.trap.hits, [], "the redirect target must never be contacted");
        assert.ok(rig.fake.submissions.length <= 1, "never resubmitted");
      });
    });
  }
}

test("#219: probing does not follow a redirect either", async () => {
  await withRig(async (rig) => {
    rig.proxy.intercept = (_request, url) => new Response(null, { status: 302, headers: { location: `${rig.trap.origin}${url.pathname}` } });
    await assert.rejects(probeComfyUiServer({ endpoint: rig.proxy.endpoint }), /ComfyUI[\s\S]*redirect/i);
    assert.deepEqual(rig.trap.hits, []);
  });
});

// ─── 2. Dependencies are verified before every lookup ───────────────────────────────────────────

test("#219: a deleted or replaced checkpoint fails even when a cache entry exists", async () => {
  await withRig(async (rig) => {
    const first = await runAssetOperation(rig.root, rig.registration, rig.invocation);
    assert.equal(first.status, "miss");
    assert.equal((await runAssetOperation(rig.root, rig.registration, rig.invocation)).status, "hit");
    const requests = rig.fake.requests.length;

    // Replaced with other bytes of the same length.
    const replaced = Buffer.from(CHECKPOINT_BYTES);
    replaced[0] = replaced[0]! ^ 0xff;
    await rm(rig.checkpointFile);
    await writeFile(rig.checkpointFile, replaced);
    await assertRejectsWithoutOutput(rig, runAssetOperation(rig.root, rig.registration, rig.invocation), /checkpoint[\s\S]*sha256/i);

    // Deleted.
    await rm(rig.checkpointFile);
    await assertRejectsWithoutOutput(rig, runAssetOperation(rig.root, rig.registration, rig.invocation), /checkpoint[\s\S]*missing/i);
    assert.equal(rig.fake.requests.length, requests, "dependency failures do not contact ComfyUI");

    // Restored: the recorded result is reusable again.
    await writeFile(rig.checkpointFile, CHECKPOINT_BYTES);
    assert.equal((await runAssetOperation(rig.root, rig.registration, rig.invocation)).status, "hit");
  });
});

test("#219: runAssetOperation calls verifyDependencies before the lookup on hits and misses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-verify-deps-"));
  try {
    const calls: string[] = [];
    let healthy = true;
    const registration: AssetOperationRunRegistration = {
      descriptor: {
        schemaVersion: 1,
        id: "test.verify-dependencies",
        version: "1",
        category: "test",
        inputs: [],
        outputs: [{ id: "out", assetKinds: ["blob"], mediaTypes: ["text/plain"], cardinality: "single", required: true }],
        parameterSchema: {},
      },
      implementation: { id: "test", version: "1" },
      async verifyDependencies(_root, invocation) {
        calls.push(`verify ${JSON.stringify(invocation.parameters)}`);
        if (!healthy) throw new Error("declared dependency is gone");
      },
      async execute(executeRoot) {
        calls.push("execute");
        const stored = await storeAssetObject(executeRoot, { bytes: Buffer.from("x"), kind: "blob", mediaType: "text/plain" });
        return { outputs: { out: stored.asset }, observations: {} };
      },
    };
    const invocation = { parameters: { n: 1 } };
    assert.equal((await runAssetOperation(root, registration, invocation)).status, "miss");
    assert.equal((await runAssetOperation(root, registration, invocation)).status, "hit");
    assert.deepEqual(calls, ['verify {"n":1}', "execute", 'verify {"n":1}']);

    healthy = false;
    await assert.rejects(runAssetOperation(root, registration, invocation), /declared dependency is gone/);
    await assert.rejects(runAssetOperation(root, registration, { parameters: { n: 2 } }), /declared dependency is gone/);
    assert.equal(calls.filter((call) => call === "execute").length, 1, "a failed check neither reuses nor executes");
    assert.equal((await listFiles(path.join(root, ".asset-tooling", "cache"))).length, 1, "nothing new is recorded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── 3. Only an unambiguous successful history is imported ──────────────────────────────────────

const STATUS_CASES: [string, (status: Record<string, unknown>, promptId: string) => Record<string, unknown> | undefined][] = [
  ["status_str missing", (status) => ({ ...status, status_str: undefined })],
  ["unknown status_str", (status) => ({ ...status, status_str: "cancelled" })],
  ["completed false with success", (status) => ({ ...status, completed: false })],
  ["completed missing", (status) => ({ ...status, completed: undefined })],
  ["no status at all", () => undefined],
  [
    "success with an execution_error message",
    (status, promptId) => ({
      ...status,
      messages: [...(status.messages as unknown[]), ["execution_error", { prompt_id: promptId, node_id: "3", exception_message: "late failure" }]],
    }),
  ],
  [
    "success with an execution_interrupted message",
    (status, promptId) => ({ ...status, messages: [...(status.messages as unknown[]), ["execution_interrupted", { prompt_id: promptId }]] }),
  ],
];

test("#219: contradictory or unknown history statuses fail visibly and import nothing", async () => {
  for (const [label, rewrite] of STATUS_CASES) {
    await withRig(async (rig) => {
      rig.proxy.intercept = async (_request, url, forward) => {
        if (!url.pathname.startsWith("/history/")) return undefined;
        const body = (await (await forward()).json()) as Record<string, any>;
        for (const [promptId, record] of Object.entries(body)) {
          const status = rewrite(record.status, promptId);
          if (status === undefined) delete record.status;
          else record.status = JSON.parse(JSON.stringify(status));
        }
        return Response.json(body);
      };
      const error = await assertRejectsWithoutOutput(rig, runAssetOperation(rig.root, rig.registration, rig.invocation), /ComfyUI/);
      assert.doesNotMatch(error.message, /ambiguous/, `${label}: a finished record is reported, not waited out`);
      assert.ok(error.message.includes(rig.fake.promptIds[0]!), `${label}: names the prompt id`);
      assert.equal(rig.fake.servedImages.length, 0, `${label}: the output is not fetched`);
      assert.equal(rig.fake.submissions.length, 1, `${label}: not resubmitted`);
    });
  }
});
