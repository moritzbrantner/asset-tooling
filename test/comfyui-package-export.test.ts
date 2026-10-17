/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#221: export and register
 * `image.comfyui.generate@1` for consumers and the workflow bridge.
 *
 * Written by a separate acceptance context before any implementation exists. Spec sources: the
 * #221 issue body, closed #212 with its comments, PR #219 (the merged execution slice),
 * docs/prd-comfyui-provider.md, docs/operations.md ("Workflow bridge"), AGENTS.md (no ambient
 * state, fail closed, no hidden network), package.json / scripts/check-package-shape.ts and the
 * precedent of the Kokoro provider export (`asset-tooling/operations/audio/model/kokoro`).
 *
 * Every test here uses package specifiers (`asset-tooling/...`), never deep `../src/...` paths,
 * except where a test explicitly compares the exported value with the existing module.
 * The fake server is test/fixtures/comfyui-fake-server.ts (unchanged from #212).
 *
 * ─── Seam 1: consumer subpath ───────────────────────────────────────────────────────────────────
 *
 *   package.json  "./operations/image/comfyui": "./src/<module>.ts"
 *     (follows the `./operations/image/<family>` naming; the target may be src/comfyui-operation.ts
 *     itself or a thin entry module like src/kokoro-audio-model.ts that re-exports it)
 *   The subpath exports, identical (===) to the values in src/comfyui-operation.ts:
 *     COMFYUI_IMAGE_GENERATE_OPERATION
 *     probeComfyUiServer
 *     createComfyUiImageGenerateRegistration
 *   and the types ComfyUiImageGenerateRegistrationOptions and ComfyUiServerIdentity. The subpath
 *   must type-check for a strict consumer that resolves it through package.json "exports".
 *   scripts/check-package-shape.ts lists the subpath in `expectedSourceExports`, and the packed
 *   tarball (`bun pm pack --dry-run`) contains the target and every module it imports.
 *
 * ─── Seam 2: workflow-bridge registration (asset-tooling/operations/workflow) ──────────────────
 *
 *   createAssetOperationWorkflowProviderEntries(config?: {
 *     comfyui?: ComfyUiImageGenerateRegistrationOptions;   // { endpoint, server, checkpointDirectory,
 *   }) -> {                                                 //   comfyuiCommit?, timeoutMs?, pollIntervalMs? }
 *     templates:     WorkflowNodeTemplate[];   // editor templates, sorted by id
 *     registrations: { operation, execute }[]; // pass to createAssetOperationWorkflowExecutor
 *   }
 *
 *   - Provider configuration is passed explicitly by the host. The function reads no environment
 *     variable, file or global, and performs no network or file I/O (the host probes the server
 *     with probeComfyUiServer beforehand and passes the identity as `server`).
 *   - No config, `{}` or `{ comfyui: undefined }`: both lists are empty, so the editor does not
 *     offer the operation and an executor built from these registrations rejects a node that
 *     selects it with /not registered/, before any network access.
 *   - `comfyui` present but invalid (no endpoint, non-loopback endpoint, missing server identity,
 *     unknown field): throws an Error that names ComfyUI. Never a half-configured entry.
 *   - Unknown provider keys (anything other than `comfyui`) throw, naming the key.
 *   - Valid `comfyui`: exactly one template, deepEqual to
 *     createAssetOperationWorkflowNodeTemplate(COMFYUI_IMAGE_GENERATE_OPERATION), and exactly one
 *     registration `{ operation, execute }` whose operation is that descriptor. Executed through
 *     createAssetOperationWorkflowExecutor it runs the #212 operation against the configured
 *     endpoint and returns a stored image/png AssetRef.
 *
 * ─── Seam 3: existing entries unchanged ─────────────────────────────────────────────────────────
 *
 *   test/fixtures/workflow-bridge-operations.baseline.json snapshots, on main 932e5ac, the bridge
 *   template hash of every operation descriptor exported through a package.json subpath. After
 *   #221 the same projection must equal that snapshot plus exactly `image.comfyui.generate@1`.
 *
 * Out of scope (#222-#225): provider choice/default against Diffusers, candidate/approval and
 * export, scoped cancellation, checkpoint acquisition.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { resolveAssetObject, storeAssetObject } from "asset-tooling/operations/store";
import * as workflowBridge from "asset-tooling/operations/workflow";
import { startFakeComfyUi, type FakeComfyUi } from "./fixtures/comfyui-fake-server.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBPATH = "./operations/image/comfyui";
const SPECIFIER = "asset-tooling/operations/image/comfyui";
const OPERATION_KEY = "image.comfyui.generate@1";
const WORKFLOW_PATH = path.join(REPO_ROOT, "test", "fixtures", "comfyui", "sd15-txt2img.api.json");
const BASELINE_PATH = path.join(REPO_ROOT, "test", "fixtures", "workflow-bridge-operations.baseline.json");
const CHECKPOINT_NAME = "sd15-fixture.safetensors";
const CHECKPOINT_BYTES = Buffer.from("fixture checkpoint bytes, never loaded by anything", "utf8");
const COMFYUI_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function packageJson(): Promise<{ exports: Record<string, string>; files: string[] }> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
}

interface ComfySubpath {
  COMFYUI_IMAGE_GENERATE_OPERATION: any;
  probeComfyUiServer(options: Record<string, unknown>): Promise<any>;
  createComfyUiImageGenerateRegistration(options: Record<string, unknown>): any;
}

async function comfySubpath(): Promise<ComfySubpath> {
  let module: Record<string, unknown>;
  try {
    // A variable specifier keeps this file loadable on the baseline, where the subpath is missing.
    const specifier: string = SPECIFIER;
    module = await import(specifier);
  } catch (error) {
    assert.fail(`${SPECIFIER} must be a package export (#221): ${(error as Error).message}`);
  }
  for (const name of ["COMFYUI_IMAGE_GENERATE_OPERATION", "probeComfyUiServer", "createComfyUiImageGenerateRegistration"]) {
    assert.ok(name in module, `${SPECIFIER} must export ${name} (#221)`);
  }
  return module as unknown as ComfySubpath;
}

type ProviderEntries = (config?: unknown) => { templates: any[]; registrations: any[] };

function providerEntries(): ProviderEntries {
  const factory = (workflowBridge as Record<string, unknown>).createAssetOperationWorkflowProviderEntries;
  assert.equal(
    typeof factory,
    "function",
    "asset-tooling/operations/workflow must export createAssetOperationWorkflowProviderEntries (#221)",
  );
  return factory as ProviderEntries;
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

// ─── 1. Consumer import through the subpath only ────────────────────────────────────────────────

test("#221: the ComfyUI operation is importable through asset-tooling/operations/image/comfyui", async () => {
  const pkg = await packageJson();
  const target = pkg.exports[SUBPATH];
  assert.equal(typeof target, "string", `package.json exports must list '${SUBPATH}' (#221)`);
  const api = await comfySubpath();
  // The subpath re-exports the merged #212 implementation; it is not a copy.
  const implementation = await import("../src/comfyui-operation.js");
  assert.equal(api.COMFYUI_IMAGE_GENERATE_OPERATION, implementation.COMFYUI_IMAGE_GENERATE_OPERATION);
  assert.equal(api.probeComfyUiServer, implementation.probeComfyUiServer);
  assert.equal(api.createComfyUiImageGenerateRegistration, implementation.createComfyUiImageGenerateRegistration);
  assert.equal(api.COMFYUI_IMAGE_GENERATE_OPERATION.id, "image.comfyui.generate");
  assert.equal(api.COMFYUI_IMAGE_GENERATE_OPERATION.version, "1");
});

// Strict consumer type-check. Mirrors test/operation-result-cache.test.ts (strict, Bundler
// resolution, skipLibCheck, allowImportingTsExtensions), but resolves `asset-tooling/...` the way a
// real consumer does: through node_modules/asset-tooling and package.json "exports", not `paths`.
async function strictConsumerTypecheck(source: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-consumer-tsc-"));
  try {
    await mkdir(path.join(directory, "node_modules"), { recursive: true });
    await symlink(REPO_ROOT, path.join(directory, "node_modules", "asset-tooling"), "dir");
    await writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["DOM", "DOM.Iterable", "ES2022"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
          typeRoots: [path.join(REPO_ROOT, "node_modules", "@types")],
          types: ["node"],
        },
        files: ["consumer.ts"],
      }),
    );
    await writeFile(path.join(directory, "consumer.ts"), source);
    const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    assert.ok(
      (await stat(tsc).catch(() => undefined))?.isFile(),
      "typescript must be installed (bun run typecheck installs it) for the consumer type-check",
    );
    const result = spawnSync(process.execPath, [tsc, "-p", path.join(directory, "tsconfig.json")], { encoding: "utf8" });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("#221: the ComfyUI subpath type-checks for a strict consumer resolving package exports", { timeout: 120_000 }, async () => {
  const { status, output } = await strictConsumerTypecheck(`
import type { AssetOperationResult, AssetRef } from "asset-tooling/operations";
import { runAssetOperation } from "asset-tooling/operations/store";
import {
  COMFYUI_IMAGE_GENERATE_OPERATION,
  createComfyUiImageGenerateRegistration,
  probeComfyUiServer,
  type ComfyUiImageGenerateRegistrationOptions,
  type ComfyUiServerIdentity,
} from "asset-tooling/operations/image/comfyui";

export async function consume(root: string, workflow: AssetRef, checkpointDirectory: string): Promise<AssetOperationResult> {
  const id: string = COMFYUI_IMAGE_GENERATE_OPERATION.id;
  void id;
  const server: ComfyUiServerIdentity = await probeComfyUiServer({ endpoint: "http://127.0.0.1:8188" });
  const options: ComfyUiImageGenerateRegistrationOptions = { endpoint: "http://127.0.0.1:8188", server, checkpointDirectory };
  // @ts-expect-error the endpoint is explicit; there is no default
  const missing: ComfyUiImageGenerateRegistrationOptions = { server, checkpointDirectory };
  void missing;
  const run = await runAssetOperation(root, createComfyUiImageGenerateRegistration(options), {
    parameters: { provider: "comfyui" },
    inputs: { workflow },
  });
  const status: "hit" | "miss" = run.status;
  void status;
  return run.result;
}
`);
  assert.equal(status, 0, `strict consumer tsc failed:\n${output}`);
});

// ─── 2. Package shape ───────────────────────────────────────────────────────────────────────────

function relativeImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) specifiers.add(match[1]!);
  return [...specifiers];
}

async function moduleClosure(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(path.join(REPO_ROOT, file), "utf8");
    for (const specifier of relativeImports(source)) {
      let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (resolved.endsWith(".js")) resolved = `${resolved.slice(0, -3)}.ts`;
      if (!resolved.endsWith(".ts")) continue;
      pending.push(resolved);
    }
  }
  return [...seen].sort();
}

test("#221: package shape lists the ComfyUI export and packs its files", { timeout: 120_000 }, async () => {
  const pkg = await packageJson();
  const target = pkg.exports[SUBPATH];
  assert.equal(typeof target, "string", `package.json exports must list '${SUBPATH}' (#221)`);
  assert.match(target!, /^\.\/src\/[a-z0-9-]+\.ts$/, "the export targets a TypeScript source module under src/");
  await stat(path.join(REPO_ROOT, target!));

  const checker = await readFile(path.join(REPO_ROOT, "scripts", "check-package-shape.ts"), "utf8");
  assert.ok(
    checker.includes(`"${SUBPATH}": "${target}"`),
    `scripts/check-package-shape.ts expectedSourceExports must pin "${SUBPATH}": "${target}" (#221)`,
  );
  const shape = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "check-package-shape.ts")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(shape.status, 0, `bun run package:check failed:\n${shape.stdout}${shape.stderr}`);

  const pack = spawnSync(process.execPath, ["pm", "pack", "--dry-run", "--ignore-scripts"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(pack.status, 0, `bun pm pack --dry-run failed:\n${pack.stdout}${pack.stderr}`);
  const packed = new Set([...`${pack.stdout}${pack.stderr}`.matchAll(/packed\s+\S+\s+(\S+)/g)].map((match) => match[1]!));
  assert.ok(packed.size > 0, "could not read the packed file list");
  for (const file of await moduleClosure(target!.slice(2))) {
    assert.ok(packed.has(file), `the packed package must contain ${file} (imported by ${SUBPATH})`);
  }
});

// ─── 3. Workflow bridge registration ────────────────────────────────────────────────────────────

interface BridgeHarness {
  root: string;
  fake: FakeComfyUi;
  spy: FetchSpy;
  config: Record<string, unknown>;
  workflow: any;
  parameters(): Record<string, unknown>;
}

async function withBridge(run: (h: BridgeHarness) => Promise<void>): Promise<void> {
  const api = await comfySubpath();
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-bridge-"));
  const fake = await startFakeComfyUi({ behaviour: "success", checkpoints: [CHECKPOINT_NAME] });
  const spy = spyOnFetch();
  try {
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
    const server = await api.probeComfyUiServer({ endpoint: fake.endpoint });
    fake.requests.length = 0;
    spy.calls.length = 0;
    await run({
      root,
      fake,
      spy,
      workflow,
      config: {
        endpoint: fake.endpoint,
        server,
        comfyuiCommit: COMFYUI_COMMIT,
        checkpointDirectory,
        timeoutMs: 10_000,
        pollIntervalMs: 5,
      },
      parameters: () => ({
        provider: "comfyui",
        checkpoint,
        injections: {
          checkpoint: { node: "4", input: "ckpt_name" },
          seed: { node: "3", input: "seed", value: 221 },
          positivePrompt: { node: "6", input: "text", value: "a small blue shield, game icon" },
          negativePrompt: { node: "7", input: "text", value: "blurry, text" },
          width: { node: "5", input: "width", value: 64 },
          height: { node: "5", input: "height", value: 48 },
        },
        output: { node: "9" },
      }),
    });
  } finally {
    spy.restore();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

function nodeFromTemplate(template: any, id: string, parameters: Record<string, unknown>) {
  return {
    id,
    label: template.label,
    kind: template.kind,
    x: 0,
    y: 0,
    ...(template.inputs ? { inputs: structuredClone(template.inputs) } : {}),
    ...(template.outputs ? { outputs: structuredClone(template.outputs) } : {}),
    data: { assetOperation: { ...template.data.assetOperation, parameters } },
  };
}

test("#221: a configured bridge lists image.comfyui.generate@1 with its workflow and image ports", async () => {
  const api = await comfySubpath();
  const entries = providerEntries();
  await withBridge(async (h) => {
    const listed = entries({ comfyui: h.config });
    assert.equal(h.spy.calls.length, 0, "creating bridge entries must not contact ComfyUI");
    assert.equal(h.fake.requests.length, 0, "creating bridge entries must not contact ComfyUI");

    assert.deepEqual(listed.templates.map((template) => template.id), [`asset-operation:${OPERATION_KEY}`]);
    const [template] = listed.templates;
    assert.deepEqual(template, workflowBridge.createAssetOperationWorkflowNodeTemplate(api.COMFYUI_IMAGE_GENERATE_OPERATION));
    assert.equal(template.kind, workflowBridge.ASSET_OPERATION_WORKFLOW_KIND);
    assert.deepEqual(template.data.assetOperation, { id: "image.comfyui.generate", version: "1", parameters: {} });
    assert.deepEqual(
      template.inputs.map((port: any) => [port.id, port.optional ?? false, port.metadata.assetOperationPort]),
      [["workflow", false, { schemaVersion: 1, assetKinds: ["workflow"], mediaTypes: ["application/json"], cardinality: "single" }]],
    );
    assert.deepEqual(
      template.outputs.map((port: any) => [port.id, port.metadata.assetOperationPort]),
      [["image", { schemaVersion: 1, assetKinds: ["image"], mediaTypes: ["image/png"], cardinality: "single" }]],
    );
    assert.deepEqual(template.outputs[0].type.properties.mediaType.type, { kind: "literal", value: "image/png" });

    assert.equal(listed.registrations.length, 1);
    const [registration] = listed.registrations;
    assert.deepEqual(Object.keys(registration).sort(), ["execute", "operation"]);
    assert.deepEqual(registration.operation, api.COMFYUI_IMAGE_GENERATE_OPERATION);
    assert.equal(typeof registration.execute, "function");
  });
});

test("#221: the registered operation runs end-to-end through the bridge executor against the fake server", async () => {
  const entries = providerEntries();
  await withBridge(async (h) => {
    const listed = entries({ comfyui: h.config });
    const evidence: any[] = [];
    const executor = workflowBridge.createAssetOperationWorkflowExecutor({
      root: h.root,
      registrations: listed.registrations,
      onOperationResult: (event: any) => {
        evidence.push(event);
      },
    });
    const node = nodeFromTemplate(listed.templates[0], "generate-icon", h.parameters());
    const result: any = await executor({ runId: "run-221", node, inputs: { workflow: h.workflow } });

    assert.deepEqual(Object.keys(result.outputs), ["image"]);
    const image = result.outputs.image;
    assert.equal(image.kind, "image");
    assert.equal(image.mediaType, "image/png");
    assert.equal(h.fake.servedImages.length, 1, "the output is fetched exactly once");
    const stored = await resolveAssetObject(h.root, image);
    assert.deepEqual(Buffer.from(stored), h.fake.servedImages[0], "the stored bytes are the served PNG");
    assert.equal(image.sha256, sha256(stored));
    assert.equal(h.fake.submissions.length, 1);
    assert.equal(h.fake.submissions[0]!.prompt["3"].inputs.seed, 221);

    for (const url of h.spy.calls) {
      assert.equal(new URL(url).origin, new URL(h.fake.endpoint).origin, `network outside the configured endpoint: ${url}`);
    }
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0].operation, { id: "image.comfyui.generate", version: "1" });
    assert.equal(evidence[0].result.observations.provider, "comfyui");
    assert.equal(evidence[0].result.observations.comfyui.commit, COMFYUI_COMMIT);
    assert.equal(evidence[0].result.observations.output.sha256, image.sha256);
  });
});

test("#221: a bridge entry still fails closed on a missing checkpoint, before submitting", async () => {
  const entries = providerEntries();
  await withBridge(async (h) => {
    const listed = entries({ comfyui: h.config });
    const executor = workflowBridge.createAssetOperationWorkflowExecutor({ root: h.root, registrations: listed.registrations });
    await unlink(path.join(h.config.checkpointDirectory as string, CHECKPOINT_NAME));
    const node = nodeFromTemplate(listed.templates[0], "generate-icon", h.parameters());
    await assert.rejects(
      executor({ runId: "run-221", node, inputs: { workflow: h.workflow } }),
      (error: unknown) => error instanceof Error && /checkpoint/i.test(error.message),
    );
    assert.equal(h.fake.submissions.length, 0, "nothing is submitted without the declared checkpoint");
  });
});

test("#221: without ComfyUI configuration the operation is not offered and never touches the network", async () => {
  const api = await comfySubpath();
  const entries = providerEntries();
  const spy = spyOnFetch();
  const previous = process.env.ASSET_TOOLING_COMFYUI_URL;
  // Ambient state must not configure the provider.
  process.env.ASSET_TOOLING_COMFYUI_URL = "http://127.0.0.1:8188";
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-unconfigured-"));
  try {
    for (const config of [undefined, {}, { comfyui: undefined }]) {
      const listed = entries(config);
      assert.deepEqual(listed, { templates: [], registrations: [] }, `config ${JSON.stringify(config)} offers nothing`);
    }
    const listed = entries({});
    const executor = workflowBridge.createAssetOperationWorkflowExecutor({ root, registrations: listed.registrations });
    const template = workflowBridge.createAssetOperationWorkflowNodeTemplate(api.COMFYUI_IMAGE_GENERATE_OPERATION);
    const workflow = (
      await storeAssetObject(root, {
        bytes: await readFile(WORKFLOW_PATH),
        kind: "workflow",
        mediaType: "application/json",
        metadata: { format: "comfyui-api-prompt" },
      })
    ).asset;
    await assert.rejects(
      executor({ runId: "run-221", node: nodeFromTemplate(template, "comfy", { provider: "comfyui" }), inputs: { workflow } }),
      /image\.comfyui\.generate@1.*not registered/,
    );
    assert.deepEqual(spy.calls, [], "an unconfigured provider performs no network access");
  } finally {
    if (previous === undefined) delete process.env.ASSET_TOOLING_COMFYUI_URL;
    else process.env.ASSET_TOOLING_COMFYUI_URL = previous;
    spy.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("#221: a partial or invalid ComfyUI configuration fails visibly instead of registering", async () => {
  const entries = providerEntries();
  const spy = spyOnFetch();
  try {
    const server = { comfyuiVersion: "0.3.66", pythonVersion: null, pytorchVersion: null, os: null, embeddedPython: null, devices: [] };
    const valid = { endpoint: "http://127.0.0.1:8188", server, checkpointDirectory: os.tmpdir() };
    const cases: [string, unknown, RegExp][] = [
      ["no endpoint", { comfyui: { server, checkpointDirectory: os.tmpdir() } }, /ComfyUI/],
      ["remote endpoint", { comfyui: { ...valid, endpoint: "http://comfy.example.com:8188" } }, /ComfyUI/],
      ["endpoint with credentials", { comfyui: { ...valid, endpoint: "http://user:pw@127.0.0.1:8188" } }, /ComfyUI/],
      ["no server identity", { comfyui: { endpoint: valid.endpoint, checkpointDirectory: os.tmpdir() } }, /ComfyUI/],
      ["unknown ComfyUI field", { comfyui: { ...valid, apiKey: "secret" } }, /apiKey/],
      ["comfyui not an object", { comfyui: "http://127.0.0.1:8188" }, /ComfyUI|comfyui/],
      ["unknown provider", { diffusers: {} }, /diffusers/],
    ];
    for (const [label, config, pattern] of cases) {
      assert.throws(() => entries(config), (error: unknown) => error instanceof Error && pattern.test(error.message), label);
    }
    assert.deepEqual(spy.calls, [], "configuration errors are detected without network access");
  } finally {
    spy.restore();
  }
});

// ─── 4. Existing operations and bridge entries unchanged ────────────────────────────────────────

async function exportedBridgeTemplates(): Promise<Record<string, string>> {
  const pkg = await packageJson();
  const templates: Record<string, string> = {};
  for (const subpath of Object.keys(pkg.exports).sort()) {
    if (subpath.includes("*")) continue;
    const specifier: string = subpath === "." ? "asset-tooling" : `asset-tooling/${subpath.slice(2)}`;
    const module = await import(specifier);
    for (const value of Object.values(module)) {
      const descriptor = value as any;
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) continue;
      if (descriptor.schemaVersion !== 1 || typeof descriptor.id !== "string" || typeof descriptor.version !== "string") continue;
      if (typeof descriptor.category !== "string" || !Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs)) continue;
      const hash = sha256(canonicalJson(workflowBridge.createAssetOperationWorkflowNodeTemplate(descriptor)));
      const key = `${descriptor.id}@${descriptor.version}`;
      assert.ok(templates[key] === undefined || templates[key] === hash, `${key} is exported with two different contracts`);
      templates[key] = hash;
    }
  }
  return templates;
}

test("#221: existing exported operations and bridge templates are unchanged; exactly ComfyUI, asset.bundle@3 (#223), asset.bundle@4 (#118/#110), image.generate@1 (#222), scene.compose.skinned.gltf@1, scene.subset.skinned.gltf@1, animation.retarget@1 and the glTF clip extract/embed operations (#110) and scene.place.gltf@1 (#118) are added", async () => {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as { templates: Record<string, string> };
  const current = await exportedBridgeTemplates();
  const added = Object.keys(current).filter((key) => !(key in baseline.templates)).sort();
  const removed = Object.keys(baseline.templates).filter((key) => !(key in current)).sort();
  const changed = Object.keys(baseline.templates)
    .filter((key) => key in current && current[key] !== baseline.templates[key])
    .sort();
  // #223 adds asset.bundle@3 (approved PNG bundle, Decision 4.1.3) to the bundle subpath.
  // #118/#110 add asset.bundle@4 (gltf-resources-v1 bundle profile, #118 owner decision Q4).
  // #222 adds image.generate@1 (provider plus pinned model profiles, Decision 5.1.4).
  // #110 adds scene.compose.skinned.gltf@1 (asset-tooling/operations/processing/gltf-compose).
  // #110 adds scene.subset.skinned.gltf@1 (asset-tooling/operations/processing/gltf-subset, owner option A).
  // #110 adds animation.retarget@1 (asset-tooling/operations/processing/animation, 3d-lab three-d-animation-retarget).
  // #110 adds scene.extract.animation.gltf@1 and scene.embed.animation.gltf@1 (asset-tooling/operations/processing/gltf-animation).
  // #118 adds scene.place.gltf@1 (asset-tooling/operations/processing/gltf-place, owner decision Q3).
  assert.deepEqual(
    { added, removed, changed },
    {
      added: [
        "animation.retarget@1", "asset.bundle@3", "asset.bundle@4", OPERATION_KEY, "image.generate@1", "scene.compose.skinned.gltf@1",
        "scene.embed.animation.gltf@1", "scene.extract.animation.gltf@1", "scene.place.gltf@1", "scene.subset.skinned.gltf@1",
      ],
      removed: [], changed: [],
    },
  );
});
