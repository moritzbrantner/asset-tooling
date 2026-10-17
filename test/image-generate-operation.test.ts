/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#222: `image.generate@1`, a
 * provider-explicit, prompt-level image generation operation with pinned model profiles.
 *
 * Written by a separate acceptance context before any implementation exists. Spec sources: the
 * #222 issue and its owner answers, Atlas Decisions 4.1.4, 5.1.1, 5.1.2 and 5.1.4,
 * docs/comfyui-first.md, docs/prd-comfyui-provider.md, and the real model pins recorded in
 * review/warden-icons/candidates.json (`models`).
 *
 * No ComfyUI, torch or model is involved: a small in-process loopback fake of the documented
 * ComfyUI routes (/system_stats, /prompt, /history/{id}, /view) lives in this file. Unlike
 * test/fixtures/comfyui-fake-server.ts it reads the latent size from any `*Latent*` node and
 * follows links to `Primitive*` nodes, because the FLUX.2 / Z-Image graphs do not use
 * EmptyLatentImage.
 *
 * ─── Seams (src/image-generate-operation.ts, package subpath asset-tooling/operations/image/generate)
 *
 *   IMAGE_GENERATE_OPERATION         descriptor image.generate@1; no inputs; one output `image`
 *                                    (kind image, image/png); closed parameterSchema.
 *   IMAGE_GENERATE_MODEL_PROFILES    frozen record keyed `flux2-klein-4b`, `z-image-turbo`:
 *     { id, label, providers: ["comfyui"],
 *       files: { diffusionModel, textEncoder, vae }  each { name, directory, sha256, byteLength,
 *                                                     license, source: { provider, repository,
 *                                                     revision, path } }   (= candidates.json)
 *       template: { path, sha256 }   repository-owned, newly authored; sha256 of the file bytes
 *       defaults, supportedOverrides }
 *   resolveImageGenerateParameters(parameters) -> fully resolved parameters (profile defaults
 *     filled in). Callers pass the RESOLVED parameters to runAssetOperation, so build identity
 *     uses resolved values. Because the schema is closed, model pins and template sha are not
 *     parameters; they belong to the registration's implementation identity.
 *   createImageGenerateRegistration(options)
 *     { provider: "comfyui", endpoint, server, modelsDirectory, timeoutMs?, pollIntervalMs?,
 *       profiles? }  |  { provider: "diffusers", profiles? }
 *     `profiles` (defaults to IMAGE_GENERATE_MODEL_PROFILES) lets these tests substitute small
 *     fake model files; the test profiles are the real profiles with only `files[*].sha256` and
 *     `byteLength` replaced (names, directories, template, defaults unchanged).
 *
 * Parameters: required provider ("comfyui"|"diffusers"), model, prompt (non-empty), seed (safe
 * integer >= 0), width/height (positive, multiple of 8, <= 2048); optional steps (positive
 * integer), sampler/scheduler (^[a-z0-9_]+$), guidance (> 0), shift (> 0). Unknown fields,
 * negativePrompt (both profiles) and overrides outside a profile's supportedOverrides are
 * rejected.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, unlink, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { test } from "bun:test";

import { resolveAssetObject, runAssetOperation } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { COMFYUI_IMAGE_GENERATE_OPERATION, probeComfyUiServer } from "../src/comfyui-operation.js";
import { STABLE_DIFFUSION_IMAGE_OPERATION } from "../src/generation-operations.js";
import { createAssetOperationCacheKey } from "../src/operations.js";
import { createAssetOperationWorkflowNodeTemplate } from "../src/workflow-operations.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = "../src/image-generate-operation.js";
const SPECIFIER = "asset-tooling/operations/image/generate";
const FLUX = "flux2-klein-4b";
const ZIMAGE = "z-image-turbo";
const ROLES = ["diffusionModel", "textEncoder", "vae"] as const;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TIMEOUT = 30_000;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// ─── Module seams ───────────────────────────────────────────────────────────────────────────────

interface Seams {
  IMAGE_GENERATE_OPERATION: any;
  IMAGE_GENERATE_MODEL_PROFILES: Record<string, any>;
  resolveImageGenerateParameters(parameters: Record<string, unknown>): Record<string, any>;
  createImageGenerateRegistration(options: Record<string, unknown>): any;
}

async function seams(): Promise<Seams> {
  let module: Record<string, unknown>;
  try {
    const specifier: string = MODULE_PATH; // variable keeps this file loadable on the baseline
    module = await import(specifier);
  } catch (error) {
    assert.fail(`src/image-generate-operation.ts must exist and load (#222): ${(error as Error).message}`);
  }
  for (const name of [
    "IMAGE_GENERATE_OPERATION",
    "IMAGE_GENERATE_MODEL_PROFILES",
    "resolveImageGenerateParameters",
    "createImageGenerateRegistration",
  ]) {
    assert.ok(name in module, `src/image-generate-operation.ts must export ${name} (#222)`);
  }
  return module as unknown as Seams;
}

// ─── Fake ComfyUI ───────────────────────────────────────────────────────────────────────────────

type Behaviour = "success" | "wrong-size" | "execution-error";

interface Fake {
  endpoint: string;
  requests: { method: string; path: string }[];
  submissions: { prompt: Record<string, any>; [key: string]: unknown }[];
  servedImages: Buffer[];
  promptIds: string[];
  behaviour: Behaviour;
  comfyuiVersion: string;
  stop(): Promise<void>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width: number, height: number, salt: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      rows[pixel] = (x + salt) & 0xff;
      rows[pixel + 1] = (y + salt * 7) & 0xff;
      rows[pixel + 2] = (x ^ y ^ salt) & 0xff;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Follows `[nodeId, slot]` links into Primitive* nodes; returns undefined for computed links. */
function literal(prompt: Record<string, any>, value: unknown, depth = 0): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") {
    const node = prompt[value[0]];
    if (depth > 8 || !node || !String(node.class_type).startsWith("Primitive")) return undefined;
    return literal(prompt, node.inputs?.value, depth + 1);
  }
  return value;
}

function nodesOf(prompt: Record<string, any>, classType: string | RegExp): [string, any][] {
  return Object.entries(prompt).filter(([, node]) =>
    typeof classType === "string" ? node?.class_type === classType : classType.test(String(node?.class_type)),
  );
}

function fakeLatentSize(prompt: Record<string, any>): { width: number; height: number } {
  for (const [, node] of nodesOf(prompt, /Latent/)) {
    const width = Number(literal(prompt, node.inputs?.width));
    const height = Number(literal(prompt, node.inputs?.height));
    if (Number.isInteger(width) && Number.isInteger(height)) return { width, height };
  }
  return { width: 64, height: 64 };
}

function fakeSeed(prompt: Record<string, any>): number {
  for (const [, node] of Object.entries(prompt)) {
    const seed = literal(prompt, node?.inputs?.seed ?? node?.inputs?.noise_seed);
    if (typeof seed === "number") return seed % 251;
  }
  return 0;
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function startFake(): Promise<Fake> {
  const requests: Fake["requests"] = [];
  const submissions: Fake["submissions"] = [];
  const servedImages: Buffer[] = [];
  const promptIds: string[] = [];
  const jobs = new Map<string, { prompt: Record<string, any>; polls: number; filename: string }>();
  const state = { behaviour: "success" as Behaviour, comfyuiVersion: "0.3.66" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      if (request.method === "GET" && url.pathname === "/system_stats") {
        return jsonResponse({
          system: {
            os: "posix",
            python_version: "3.12.3",
            embedded_python: false,
            comfyui_version: state.comfyuiVersion,
            pytorch_version: "2.8.0+cpu",
            ram_total: 16_000_000_000,
            ram_free: 1_000_000,
          },
          devices: [{ name: "cpu", type: "cpu", index: null, vram_total: 1, vram_free: 1 }],
        });
      }
      if (request.method === "POST" && url.pathname === "/prompt") {
        const body = JSON.parse(await request.text());
        submissions.push(body);
        const promptId = `fake-${crypto.randomUUID()}`;
        promptIds.push(promptId);
        jobs.set(promptId, { prompt: body.prompt ?? {}, polls: 0, filename: `image-generate_${promptIds.length}_.png` });
        return jsonResponse({ prompt_id: promptId, number: promptIds.length - 1, node_errors: {} });
      }
      if (request.method === "GET" && url.pathname.startsWith("/history/")) {
        const promptId = decodeURIComponent(url.pathname.slice("/history/".length));
        const job = jobs.get(promptId);
        if (!job) return jsonResponse({});
        job.polls += 1;
        if (job.polls <= 1) return jsonResponse({});
        const saves = nodesOf(job.prompt, "SaveImage").map(([id]) => id);
        if (state.behaviour === "execution-error") {
          return jsonResponse({
            [promptId]: {
              prompt: [0, promptId, job.prompt, {}, saves],
              outputs: {},
              status: {
                status_str: "error",
                completed: false,
                messages: [["execution_error", { prompt_id: promptId, node_id: "1", node_type: "UNETLoader", exception_message: "fake loader exploded", exception_type: "RuntimeError", traceback: [] }]],
              },
            },
          });
        }
        return jsonResponse({
          [promptId]: {
            prompt: [0, promptId, job.prompt, {}, saves],
            outputs: Object.fromEntries(saves.map((id) => [id, { images: [{ filename: job.filename, subfolder: "", type: "output" }] }])),
            status: { status_str: "success", completed: true, messages: [["execution_success", { prompt_id: promptId }]] },
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/view") {
        const job = [...jobs.values()].find((candidate) => candidate.filename === url.searchParams.get("filename"));
        if (!job) return new Response("not found", { status: 404 });
        const size = fakeLatentSize(job.prompt);
        const bytes =
          state.behaviour === "wrong-size"
            ? encodePng(size.width + 8, size.height, fakeSeed(job.prompt))
            : encodePng(size.width, size.height, fakeSeed(job.prompt));
        servedImages.push(bytes);
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
      if (request.method === "POST" && url.pathname === "/queue") return jsonResponse({});
      return new Response("not found", { status: 404 });
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    submissions,
    servedImages,
    promptIds,
    get behaviour() {
      return state.behaviour;
    },
    set behaviour(value) {
      state.behaviour = value;
    },
    get comfyuiVersion() {
      return state.comfyuiVersion;
    },
    set comfyuiVersion(value) {
      state.comfyuiVersion = value;
    },
    async stop() {
      await server.stop(true);
    },
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────────────────────────

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

const fakeModelBytes = (name: string) => Buffer.from(`asset-tooling#222 fake model bytes for ${name}`, "utf8");

/** Real profiles with only each file's sha256/byteLength replaced by the fake bytes' values. */
function testProfiles(real: Record<string, any>): Record<string, any> {
  const profiles: Record<string, any> = {};
  for (const [id, profile] of Object.entries(real)) {
    const clone = structuredClone(profile);
    for (const role of ROLES) {
      const bytes = fakeModelBytes(clone.files[role].name);
      clone.files[role].sha256 = sha256(bytes);
      clone.files[role].byteLength = bytes.byteLength;
    }
    profiles[id] = clone;
  }
  return profiles;
}

interface Harness {
  api: Seams;
  root: string;
  modelsDirectory: string;
  fake: Fake;
  spy: FetchSpy;
  server: any;
  profiles: Record<string, any>;
  registration: any;
  register(extra?: Record<string, unknown>): any;
  modelFile(model: string, role: (typeof ROLES)[number]): string;
  objects(): Promise<string[]>;
  cacheEntries(): Promise<string[]>;
  promptPosts(): number;
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const api = await seams();
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-generate-"));
  const fake = await startFake();
  const spy = spyOnFetch();
  try {
    const modelsDirectory = path.join(root, "comfyui-models");
    const profiles = testProfiles(api.IMAGE_GENERATE_MODEL_PROFILES);
    for (const profile of Object.values(profiles)) {
      for (const role of ROLES) {
        const file = profile.files[role];
        await mkdir(path.join(modelsDirectory, file.directory), { recursive: true });
        await writeFile(path.join(modelsDirectory, file.directory, file.name), fakeModelBytes(file.name));
      }
    }
    const server = await probeComfyUiServer({ endpoint: fake.endpoint });
    const register = (extra: Record<string, unknown> = {}) =>
      api.createImageGenerateRegistration({
        provider: "comfyui",
        endpoint: fake.endpoint,
        server,
        modelsDirectory,
        timeoutMs: 10_000,
        pollIntervalMs: 5,
        profiles,
        ...extra,
      });
    const registration = register();
    fake.requests.length = 0;
    spy.calls.length = 0;
    await run({
      api,
      root,
      modelsDirectory,
      fake,
      spy,
      server,
      profiles,
      registration,
      register,
      modelFile: (model, role) => path.join(modelsDirectory, profiles[model].files[role].directory, profiles[model].files[role].name),
      objects: () => listFiles(path.join(root, ".asset-tooling", "objects")),
      cacheEntries: () => listFiles(path.join(root, ".asset-tooling", "cache")),
      promptPosts: () => fake.requests.filter((request) => request.method === "POST" && request.path === "/prompt").length,
    });
  } finally {
    spy.restore();
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

function baseParameters(model: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "comfyui",
    model,
    prompt: `a warden shield icon, flat game art (${model})`,
    seed: 1234,
    width: 64,
    height: 48,
    ...overrides,
  };
}

async function rejectsVisibly(promise: Promise<unknown>, pattern: RegExp, label: string): Promise<Error> {
  let caught: unknown;
  await promise.then(
    () => assert.fail(`${label}: expected a visible failure`),
    (error: unknown) => {
      caught = error;
    },
  );
  assert.ok(caught instanceof Error, `${label}: failure must be an Error`);
  assert.match(caught.message, pattern, label);
  return caught;
}

/** Resolves when the implementation accepts the parameters; otherwise passes them through raw. */
function resolveOrRaw(api: Seams, parameters: Record<string, unknown>): Record<string, unknown> {
  try {
    return api.resolveImageGenerateParameters(parameters);
  } catch {
    return parameters;
  }
}

/** Every node of a class carries `expected` at `input` (after following Primitive links). */
function assertNodeValue(prompt: Record<string, any>, classTypes: string[], input: string, expected: unknown, label: string): void {
  const nodes = classTypes.flatMap((classType) => nodesOf(prompt, classType)).filter(([, node]) => input in (node.inputs ?? {}));
  assert.ok(nodes.length > 0, `${label}: the submitted graph has no ${classTypes.join("/")} node with input ${input}`);
  for (const [id, node] of nodes) {
    assert.deepEqual(literal(prompt, node.inputs[input]), expected, `${label}: node ${id} (${node.class_type}).${input}`);
  }
}

function assertGraphCarries(prompt: Record<string, any>, profile: any, resolved: Record<string, any>): void {
  // Loaders name the pinned files.
  assertNodeValue(prompt, ["UNETLoader"], "unet_name", profile.files.diffusionModel.name, "diffusion model loader");
  assertNodeValue(prompt, ["CLIPLoader"], "clip_name", profile.files.textEncoder.name, "text encoder loader");
  assertNodeValue(prompt, ["VAELoader"], "vae_name", profile.files.vae.name, "VAE loader");
  assert.equal(nodesOf(prompt, "CheckpointLoaderSimple").length, 0, "profiles load split files, not a checkpoint");
  // Positive prompt text.
  const encoders = nodesOf(prompt, /TextEncode/).filter(([, node]) => typeof literal(prompt, node.inputs?.text) === "string");
  assert.ok(encoders.length > 0, "a text encoder node carries the prompt");
  assert.ok(
    encoders.some(([, node]) => literal(prompt, node.inputs.text) === resolved.prompt),
    "the prompt text is injected into a text encoder node",
  );
  // Seed.
  const seeds = [
    ...nodesOf(prompt, "KSampler").map(([, node]) => literal(prompt, node.inputs.seed)),
    ...nodesOf(prompt, "RandomNoise").map(([, node]) => literal(prompt, node.inputs.noise_seed)),
  ];
  assert.ok(seeds.length > 0, "the graph has a seeded sampler/noise node");
  for (const seed of seeds) assert.equal(seed, resolved.seed, "seed injected");
  // Size.
  const latents = nodesOf(prompt, /Latent/).filter(([, node]) => "width" in (node.inputs ?? {}));
  assert.ok(latents.length > 0, "the graph has a sized latent node");
  for (const [, node] of latents) {
    assert.equal(literal(prompt, node.inputs.width), resolved.width, "latent width injected");
    assert.equal(literal(prompt, node.inputs.height), resolved.height, "latent height injected");
  }
  // Sampler knobs.
  assertNodeValue(prompt, ["Flux2Scheduler", "KSampler", "BasicScheduler"], "steps", resolved.steps, "steps");
  assertNodeValue(prompt, ["KSamplerSelect", "KSampler"], "sampler_name", resolved.sampler, "sampler");
  if ("scheduler" in resolved) assertNodeValue(prompt, ["KSampler", "BasicScheduler"], "scheduler", resolved.scheduler, "scheduler");
  if ("shift" in resolved) assertNodeValue(prompt, ["ModelSamplingAuraFlow"], "shift", resolved.shift, "shift");
  assertNodeValue(prompt, ["CFGGuider", "KSampler"], "cfg", resolved.guidance, "guidance (cfg)");
  assert.equal(nodesOf(prompt, "SaveImage").length, 1, "exactly one SaveImage output");
}

// ─── 1. Descriptor, profiles, templates, export ─────────────────────────────────────────────────

test("#222: image.generate@1 has no inputs, one PNG image output and a closed parameter schema", async () => {
  const { IMAGE_GENERATE_OPERATION: operation } = await seams();
  assert.equal(operation.id, "image.generate");
  assert.equal(operation.version, "1");
  assert.deepEqual(operation.inputs, []);
  assert.deepEqual(
    operation.outputs.map((port: any) => [port.id, port.assetKinds, port.mediaTypes, port.cardinality]),
    [["image", ["image"], ["image/png"], "single"]],
  );
  const schema = operation.parameterSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ["height", "model", "prompt", "provider", "seed", "width"]);
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ["guidance", "height", "model", "prompt", "provider", "sampler", "scheduler", "seed", "shift", "steps", "width"],
  );
  assert.deepEqual([...schema.properties.provider.enum].sort(), ["comfyui", "diffusers"]);
  assert.equal("negativePrompt" in schema.properties, false);
  assert.equal(createAssetOperationWorkflowNodeTemplate(operation).id, "asset-operation:image.generate@1");
});

test("#222: model profiles pin exactly the files recorded in review/warden-icons/candidates.json", async () => {
  const { IMAGE_GENERATE_MODEL_PROFILES: profiles } = await seams();
  assert.ok(Object.isFrozen(profiles), "the profile record is frozen");
  assert.deepEqual(Object.keys(profiles).sort(), [FLUX, ZIMAGE]);
  const candidates = JSON.parse(await readFile(path.join(REPO_ROOT, "review", "warden-icons", "candidates.json"), "utf8"));
  for (const id of [FLUX, ZIMAGE]) {
    const profile = profiles[id];
    const recorded = candidates.models.find((model: any) => model.id === id);
    assert.ok(recorded, `${id} is recorded in candidates.json`);
    assert.equal(profile.id, id);
    assert.equal(typeof profile.label, "string");
    assert.deepEqual(profile.providers, ["comfyui"], `${id}: ComfyUI is the only provider for now (Decision 5.1.4)`);
    assert.deepEqual(Object.keys(profile.files).sort(), [...ROLES].sort());
    for (const role of ROLES) {
      const pin = profile.files[role];
      const expected = recorded.files[role];
      for (const field of ["name", "directory", "sha256", "byteLength", "license"]) {
        assert.equal(pin[field], expected[field], `${id}.${role}.${field}`);
      }
      assert.deepEqual(pin.source, expected.source, `${id}.${role}.source`);
      assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    }
  }
});

test("#222: profile defaults and supported overrides match the owner-approved sampling settings", async () => {
  const { IMAGE_GENERATE_MODEL_PROFILES: profiles } = await seams();
  assert.deepEqual(profiles[FLUX].defaults, { steps: 4, sampler: "euler", guidance: 1 });
  assert.deepEqual([...profiles[FLUX].supportedOverrides].sort(), ["guidance", "sampler", "steps"]);
  assert.deepEqual(profiles[ZIMAGE].defaults, { steps: 8, sampler: "res_multistep", scheduler: "simple", guidance: 1, shift: 3 });
  assert.deepEqual([...profiles[ZIMAGE].supportedOverrides].sort(), ["guidance", "sampler", "scheduler", "shift", "steps"]);
});

test("#222: each profile's template is a new, repository-owned, hash-pinned API-format workflow", async () => {
  const { IMAGE_GENERATE_MODEL_PROFILES: profiles } = await seams();
  const reviewBytes = await Promise.all(
    ["workflow.flux2-klein-4b-icon.api.json", "workflow.z-image-turbo-icon.api.json"].map((name) =>
      readFile(path.join(REPO_ROOT, "review", "warden-icons", name)),
    ),
  );
  const shas = new Set<string>();
  for (const id of [FLUX, ZIMAGE]) {
    const template = profiles[id].template;
    assert.equal(typeof template.path, "string");
    const file = path.resolve(REPO_ROOT, template.path);
    assert.ok(file.startsWith(REPO_ROOT + path.sep), `${id}: template lives in the repository`);
    assert.ok(!file.startsWith(path.join(REPO_ROOT, "review") + path.sep), `${id}: the #211 review workflows stay review provenance`);
    const bytes = await readFile(file);
    assert.equal(template.sha256, sha256(bytes), `${id}: template.sha256 pins the file bytes`);
    for (const review of reviewBytes) assert.notDeepEqual(bytes, review, `${id}: newly authored, not a copy of a review workflow`);
    const graph = JSON.parse(bytes.toString("utf8"));
    for (const [nodeId, node] of Object.entries<any>(graph)) {
      assert.equal(typeof node.class_type, "string", `${id}: node ${nodeId} has a class_type (API format)`);
      assert.equal(typeof node.inputs, "object", `${id}: node ${nodeId} has inputs`);
    }
    assert.equal(nodesOf(graph, "SaveImage").length, 1, `${id}: one SaveImage output`);
    shas.add(template.sha256);
  }
  assert.equal(shas.size, 2, "each model has its own template");
});

test("#222: image.generate is exported as asset-tooling/operations/image/generate", async () => {
  const api = await seams();
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.exports["./operations/image/generate"], "./src/image-generate-operation.ts");
  const shape = await readFile(path.join(REPO_ROOT, "scripts", "check-package-shape.ts"), "utf8");
  assert.ok(shape.includes('"./operations/image/generate"'), "check-package-shape lists the subpath");
  const specifier: string = SPECIFIER;
  const exported = await import(specifier);
  for (const name of ["IMAGE_GENERATE_OPERATION", "IMAGE_GENERATE_MODEL_PROFILES", "resolveImageGenerateParameters", "createImageGenerateRegistration"]) {
    assert.equal(exported[name], (api as any)[name], `${SPECIFIER} exports the same ${name}`);
  }
});

test("#222: image.stable-diffusion.generate@1 and image.comfyui.generate@1 are unchanged", () => {
  // Hashes of canonicalJson(descriptor) taken on origin/main 86b262d before #222.
  const hash = (descriptor: unknown) => sha256(canonicalJson(descriptor as any));
  assert.equal(hash(STABLE_DIFFUSION_IMAGE_OPERATION), "21678c35fd4c8d7be662f2744871ac3da751cef82a29041b3a88d4d7ce232f44");
  assert.equal(hash(COMFYUI_IMAGE_GENERATE_OPERATION), "a6e488d28ceb248c00ec836af83f01fd7605eb7b48a6645e09ea97534823cd09");
});

// ─── 2. Parameters and resolution ───────────────────────────────────────────────────────────────

test("#222: resolution fills profile defaults and only the knobs the profile supports", async () => {
  const api = await seams();
  const flux = baseParameters(FLUX);
  const fluxInput = structuredClone(flux);
  assert.deepEqual(api.resolveImageGenerateParameters(flux), { ...flux, steps: 4, sampler: "euler", guidance: 1 });
  assert.deepEqual(flux, fluxInput, "resolution does not mutate its input");
  const zimage = baseParameters(ZIMAGE);
  assert.deepEqual(api.resolveImageGenerateParameters(zimage), {
    ...zimage,
    steps: 8,
    sampler: "res_multistep",
    scheduler: "simple",
    guidance: 1,
    shift: 3,
  });
  assert.deepEqual(api.resolveImageGenerateParameters(baseParameters(ZIMAGE, { steps: 10, sampler: "euler", scheduler: "beta", guidance: 1.5, shift: 2 })), {
    ...zimage,
    steps: 10,
    sampler: "euler",
    scheduler: "beta",
    guidance: 1.5,
    shift: 2,
  });
  const resolved = api.resolveImageGenerateParameters(flux);
  assert.deepEqual(api.resolveImageGenerateParameters(resolved), resolved, "resolution is idempotent");
  assert.doesNotThrow(() => canonicalJson(resolved as any));
});

test("#222: invalid, unknown and unsupported parameters are rejected", async () => {
  const api = await seams();
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["missing provider", (({ provider: _p, ...rest }) => rest)(baseParameters(FLUX)), /provider/],
    ["unknown provider", baseParameters(FLUX, { provider: "openai" }), /provider/],
    ["missing model", (({ model: _m, ...rest }) => rest)(baseParameters(FLUX)), /model/],
    ["unknown model", baseParameters("sd15"), /model|sd15/],
    ["missing prompt", (({ prompt: _p, ...rest }) => rest)(baseParameters(FLUX)), /prompt/],
    ["empty prompt", baseParameters(FLUX, { prompt: "" }), /prompt/],
    ["missing seed", (({ seed: _s, ...rest }) => rest)(baseParameters(FLUX)), /seed/],
    ["negative seed", baseParameters(FLUX, { seed: -1 }), /seed/],
    ["fractional seed", baseParameters(FLUX, { seed: 1.5 }), /seed/],
    ["unsafe seed", baseParameters(FLUX, { seed: 2 ** 53 }), /seed/],
    ["zero width", baseParameters(FLUX, { width: 0 }), /width/],
    ["width not multiple of 8", baseParameters(FLUX, { width: 63 }), /width/],
    ["width over 2048", baseParameters(FLUX, { width: 2056 }), /width/],
    ["string height", baseParameters(FLUX, { height: "64" }), /height/],
    ["missing height", (({ height: _h, ...rest }) => rest)(baseParameters(FLUX)), /height/],
    ["zero steps", baseParameters(FLUX, { steps: 0 }), /steps/],
    ["fractional steps", baseParameters(FLUX, { steps: 2.5 }), /steps/],
    ["bad sampler", baseParameters(FLUX, { sampler: "Euler A" }), /sampler/],
    ["bad scheduler", baseParameters(ZIMAGE, { scheduler: "very-simple" }), /scheduler/],
    ["zero guidance", baseParameters(FLUX, { guidance: 0 }), /guidance/],
    ["negative guidance", baseParameters(FLUX, { guidance: -1 }), /guidance/],
    ["non-finite guidance", baseParameters(FLUX, { guidance: Number.POSITIVE_INFINITY }), /guidance/],
    ["zero shift", baseParameters(ZIMAGE, { shift: 0 }), /shift/],
    ["unknown field", baseParameters(FLUX, { cfg: 2 }), /cfg/],
    ["scheduler on flux2-klein-4b", baseParameters(FLUX, { scheduler: "simple" }), /scheduler/],
    ["shift on flux2-klein-4b", baseParameters(FLUX, { shift: 3 }), /shift/],
  ];
  for (const [label, parameters, pattern] of cases) {
    assert.throws(
      () => api.resolveImageGenerateParameters(parameters),
      (error: unknown) => error instanceof Error && pattern.test(error.message),
      label,
    );
  }
  for (const model of [FLUX, ZIMAGE]) {
    assert.throws(
      () => api.resolveImageGenerateParameters(baseParameters(model, { negativePrompt: "blurry" })),
      (error: unknown) =>
        error instanceof Error && /negativePrompt/.test(error.message) && error.message.includes(model),
      `negativePrompt is rejected for ${model} and the message names the model`,
    );
  }
});

// ─── 3. Build identity ──────────────────────────────────────────────────────────────────────────

test("#222: build identity uses resolved values; every knob, the model and the provider change it", async () => {
  const api = await seams();
  const server = {
    comfyuiVersion: "0.3.66",
    pythonVersion: "3.12.3",
    pytorchVersion: "2.8.0+cpu",
    os: "posix",
    embeddedPython: false,
    devices: [{ name: "cpu", type: "cpu", index: null }],
  };
  const comfy = api.createImageGenerateRegistration({
    provider: "comfyui",
    endpoint: "http://127.0.0.1:8188",
    server,
    modelsDirectory: path.join(os.tmpdir(), "asset-tooling-222-nonexistent-models"),
  });
  const key = (registration: any, parameters: Record<string, unknown>) =>
    createAssetOperationCacheKey({
      operation: registration.descriptor,
      implementation: registration.implementation,
      parameters: api.resolveImageGenerateParameters(parameters) as any,
      inputs: {},
    });

  const flux = baseParameters(FLUX);
  const zimage = baseParameters(ZIMAGE);
  assert.equal(key(comfy, flux), key(comfy, { ...flux, steps: 4, sampler: "euler", guidance: 1 }), "explicit defaults = omitted");
  assert.equal(
    key(comfy, zimage),
    key(comfy, { ...zimage, steps: 8, sampler: "res_multistep", scheduler: "simple", guidance: 1, shift: 3 }),
    "explicit defaults = omitted (z-image-turbo)",
  );

  const variants: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["steps", flux, { steps: 5 }],
    ["sampler", flux, { sampler: "dpmpp_2m" }],
    ["guidance", flux, { guidance: 2.5 }],
    ["prompt", flux, { prompt: "a different icon" }],
    ["seed", flux, { seed: 1235 }],
    ["width", flux, { width: 72 }],
    ["height", flux, { height: 56 }],
    ["model", flux, { model: ZIMAGE }],
    ["scheduler", zimage, { scheduler: "beta" }],
    ["shift", zimage, { shift: 2 }],
    ["z steps", zimage, { steps: 9 }],
  ];
  for (const [label, base, change] of variants) {
    assert.notEqual(key(comfy, base), key(comfy, { ...base, ...change }), `${label} changes identity`);
  }

  // Provider: a Diffusers registration never shares identity with a ComfyUI registration.
  const diffusers = api.createImageGenerateRegistration({ provider: "diffusers" });
  assert.notEqual(canonicalJson(diffusers.implementation), canonicalJson(comfy.implementation), "provider is in implementation identity");
  assert.match(JSON.stringify(comfy.implementation), /comfyui/);
  assert.match(JSON.stringify(diffusers.implementation), /diffusers/);
  let diffusersResolved: Record<string, unknown> | undefined;
  try {
    diffusersResolved = api.resolveImageGenerateParameters({ ...flux, provider: "diffusers" });
  } catch {
    diffusersResolved = undefined; // rejecting diffusers at resolution is also a visible failure
  }
  if (diffusersResolved !== undefined) {
    assert.notEqual(key(comfy, flux), key(comfy, { ...flux, provider: "diffusers" }), "provider parameter changes identity");
  }

  // Server identity, template sha and model file pins are part of the implementation identity.
  const otherServer = api.createImageGenerateRegistration({
    provider: "comfyui",
    endpoint: "http://127.0.0.1:8188",
    server: { ...server, comfyuiVersion: "0.3.67" },
    modelsDirectory: path.join(os.tmpdir(), "asset-tooling-222-nonexistent-models"),
  });
  assert.notEqual(key(comfy, flux), key(otherServer, flux), "server identity changes identity");
  assert.match(JSON.stringify(comfy.implementation), /0\.3\.66/);
  const real = api.IMAGE_GENERATE_MODEL_PROFILES;
  const withProfiles = (mutate: (profiles: Record<string, any>) => void) => {
    const profiles = structuredClone(real) as Record<string, any>;
    mutate(profiles);
    return api.createImageGenerateRegistration({
      provider: "comfyui",
      endpoint: "http://127.0.0.1:8188",
      server,
      modelsDirectory: path.join(os.tmpdir(), "asset-tooling-222-nonexistent-models"),
      profiles,
    });
  };
  assert.equal(key(withProfiles(() => {}), flux), key(comfy, flux), "an identical profile set gives the same identity");
  assert.notEqual(
    key(withProfiles((p) => (p[FLUX].template.sha256 = "0".repeat(64))), flux),
    key(comfy, flux),
    "template sha changes identity",
  );
  for (const role of ROLES) {
    assert.notEqual(
      key(withProfiles((p) => (p[FLUX].files[role].sha256 = "1".repeat(64))), flux),
      key(comfy, flux),
      `${role} pin changes identity`,
    );
  }
});

// ─── 4. ComfyUI execution ───────────────────────────────────────────────────────────────────────

test("#222: flux2-klein-4b submits its template with the injected values and imports the verified PNG", async () => {
  await withHarness(async (h) => {
    const profile = h.profiles[FLUX];
    const parameters = h.api.resolveImageGenerateParameters(baseParameters(FLUX, { steps: 6, sampler: "dpmpp_2m", guidance: 2.5 }));
    const run = await runAssetOperation(h.root, h.registration, { parameters, inputs: {} });
    assert.equal(run.status, "miss");

    assert.equal(h.promptPosts(), 1, "exactly one POST /prompt");
    const submitted = h.fake.submissions[0]!.prompt;
    assertGraphCarries(submitted, profile, parameters);
    // Apart from injected values, the submitted graph is the pinned template.
    const template = JSON.parse(await readFile(path.resolve(REPO_ROOT, profile.template.path), "utf8"));
    assert.deepEqual(Object.keys(submitted).sort(), Object.keys(template).sort(), "same nodes as the template");
    for (const [id, node] of Object.entries<any>(template)) assert.equal(submitted[id].class_type, node.class_type, `node ${id}`);

    const image = run.result.outputs.image as any;
    assert.equal(image.kind, "image");
    assert.equal(image.mediaType, "image/png");
    assert.equal(h.fake.servedImages.length, 1);
    const stored = await resolveAssetObject(h.root, image);
    assert.deepEqual(stored, h.fake.servedImages[0]);
    assert.equal(image.sha256, sha256(stored));
    assert.deepEqual(stored.subarray(0, 8), PNG_SIGNATURE);
    assert.deepEqual(pngSize(stored), { width: 64, height: 48 });

    const receipt = run.result.observations as any;
    assert.equal(receipt.provider, "comfyui");
    assert.equal(receipt.model, FLUX);
    assert.deepEqual(receipt.parameters ?? receipt.resolvedParameters, parameters, "resolved parameters are recorded");
    assert.equal(receipt.promptId, h.fake.promptIds[0]);
    assert.equal(receipt.reproducibility, "approximate");
    assert.equal(receipt.submittedPrompt?.sha256, sha256(canonicalJson(submitted as any)));
    assert.equal(receipt.output?.sha256, image.sha256);
    const text = JSON.stringify(receipt);
    assert.ok(text.includes(profile.template.sha256), "receipt records the template sha256");
    for (const role of ROLES) {
      assert.ok(text.includes(profile.files[role].sha256), `receipt records the ${role} pin`);
      assert.ok(text.includes(profile.files[role].name), `receipt records the ${role} name`);
    }

    const origin = new URL(h.fake.endpoint).origin;
    for (const url of h.spy.calls) assert.equal(new URL(url).origin, origin, `no network outside the endpoint: ${url}`);
    assert.equal(h.fake.requests.some((request) => request.path === "/interrupt"), false);
  });
}, TIMEOUT);

test("#222: z-image-turbo uses its profile defaults when no knob is set", async () => {
  await withHarness(async (h) => {
    const parameters = h.api.resolveImageGenerateParameters(baseParameters(ZIMAGE, { width: 72, height: 40, seed: 77 }));
    const run = await runAssetOperation(h.root, h.registration, { parameters, inputs: {} });
    assert.equal(h.promptPosts(), 1);
    const submitted = h.fake.submissions[0]!.prompt;
    assertGraphCarries(submitted, h.profiles[ZIMAGE], parameters);
    assertNodeValue(submitted, ["KSampler"], "steps", 8, "default steps");
    assertNodeValue(submitted, ["KSampler", "KSamplerSelect"], "sampler_name", "res_multistep", "default sampler");
    assertNodeValue(submitted, ["KSampler", "BasicScheduler"], "scheduler", "simple", "default scheduler");
    assertNodeValue(submitted, ["ModelSamplingAuraFlow"], "shift", 3, "default shift");
    const stored = await resolveAssetObject(h.root, run.result.outputs.image as any);
    assert.deepEqual(pngSize(stored), { width: 72, height: 40 });
    assert.equal((run.result.observations as any).model, ZIMAGE);
  });
}, TIMEOUT);

test("#222: z-image-turbo overrides reach the submitted graph", async () => {
  await withHarness(async (h) => {
    const parameters = h.api.resolveImageGenerateParameters(
      baseParameters(ZIMAGE, { steps: 10, sampler: "euler", scheduler: "beta", guidance: 1.5, shift: 2 }),
    );
    await runAssetOperation(h.root, h.registration, { parameters, inputs: {} });
    assertGraphCarries(h.fake.submissions[0]!.prompt, h.profiles[ZIMAGE], parameters);
  });
}, TIMEOUT);

test("#222: explicit defaults and omitted defaults share one cache entry", async () => {
  await withHarness(async (h) => {
    const first = await runAssetOperation(h.root, h.registration, {
      parameters: h.api.resolveImageGenerateParameters(baseParameters(FLUX)),
      inputs: {},
    });
    const second = await runAssetOperation(h.root, h.registration, {
      parameters: h.api.resolveImageGenerateParameters(baseParameters(FLUX, { steps: 4, sampler: "euler", guidance: 1 })),
      inputs: {},
    });
    assert.equal(first.status, "miss");
    assert.equal(second.status, "hit");
    assert.equal(second.cacheKey, first.cacheKey);
    assert.equal(h.promptPosts(), 1, "the hit does not contact ComfyUI's /prompt");
  });
}, TIMEOUT);

// ─── 5. Fail closed: model files, template, provider ────────────────────────────────────────────

test("#222: a missing, resized or altered pinned model file fails before any /prompt", async () => {
  await withHarness(async (h) => {
    const parameters = h.api.resolveImageGenerateParameters(baseParameters(FLUX));
    const mutations: [string, (file: string) => Promise<void>][] = [
      ["missing", (file) => unlink(file)],
      ["resized", (file) => appendFile(file, "x")],
      [
        "altered",
        async (file) => {
          const bytes = await readFile(file);
          bytes[0] = bytes[0]! ^ 0xff;
          await writeFile(file, bytes);
        },
      ],
    ];
    for (const role of ROLES) {
      for (const [label, mutate] of mutations) {
        const file = h.modelFile(FLUX, role);
        const original = await readFile(file);
        await mutate(file);
        try {
          const error = await rejectsVisibly(
            runAssetOperation(h.root, h.registration, { parameters, inputs: {} }),
            new RegExp(h.profiles[FLUX].files[role].name.replace(/[.]/g, "\\.")),
            `${label} ${role}`,
          );
          assert.ok(error.message.length > 0);
          assert.equal(h.promptPosts(), 0, `${label} ${role}: no POST /prompt`);
          assert.deepEqual(await h.objects(), [], `${label} ${role}: nothing stored`);
          assert.deepEqual(await h.cacheEntries(), [], `${label} ${role}: nothing cached`);
        } finally {
          await writeFile(file, original);
        }
      }
    }
  });
}, TIMEOUT);

test("#222: the real profile pins are verified on disk; absent real model files fail before any /prompt", async () => {
  await withHarness(async (h) => {
    const registration = h.register({ profiles: undefined }); // real IMAGE_GENERATE_MODEL_PROFILES
    for (const model of [FLUX, ZIMAGE]) {
      await rejectsVisibly(
        runAssetOperation(h.root, registration, { parameters: h.api.resolveImageGenerateParameters(baseParameters(model)), inputs: {} }),
        /safetensors/,
        `${model} with the fake bytes on disk`,
      );
    }
    assert.equal(h.promptPosts(), 0);
  });
}, TIMEOUT);

test("#222: a cache hit still re-verifies the pinned model files", async () => {
  await withHarness(async (h) => {
    const parameters = h.api.resolveImageGenerateParameters(baseParameters(FLUX));
    await runAssetOperation(h.root, h.registration, { parameters, inputs: {} });
    await appendFile(h.modelFile(FLUX, "vae"), "drift");
    await rejectsVisibly(
      runAssetOperation(h.root, h.registration, { parameters, inputs: {} }),
      /flux2-vae\.safetensors/,
      "drifted VAE on a would-be hit",
    );
    assert.equal(h.promptPosts(), 1);
  });
}, TIMEOUT);

test("#222: a template whose bytes do not match its pin fails before any /prompt", async () => {
  await withHarness(async (h) => {
    const profiles = structuredClone(h.profiles);
    profiles[FLUX].template.sha256 = "0".repeat(64);
    const registration = h.register({ profiles });
    await rejectsVisibly(
      runAssetOperation(h.root, registration, { parameters: h.api.resolveImageGenerateParameters(baseParameters(FLUX)), inputs: {} }),
      /template/i,
      "tampered template pin",
    );
    assert.equal(h.promptPosts(), 0);
    assert.deepEqual(await h.objects(), []);
  });
}, TIMEOUT);

test("#222: provider mismatch between registration and parameters fails visibly, never falls back", async () => {
  await withHarness(async (h) => {
    const diffusersParameters = resolveOrRaw(h.api, baseParameters(FLUX, { provider: "diffusers" }));
    await rejectsVisibly(
      runAssetOperation(h.root, h.registration, { parameters: diffusersParameters, inputs: {} }),
      /diffusers|provider/i,
      "comfyui registration with diffusers parameters",
    );
    const diffusers = h.api.createImageGenerateRegistration({ provider: "diffusers" });
    await rejectsVisibly(
      runAssetOperation(h.root, diffusers, { parameters: h.api.resolveImageGenerateParameters(baseParameters(FLUX)), inputs: {} }),
      /comfyui|provider/i,
      "diffusers registration with comfyui parameters",
    );
    assert.equal(h.fake.requests.length, 0, "no ComfyUI request at all");
    assert.deepEqual(await h.objects(), []);
    assert.deepEqual(await h.cacheEntries(), []);
  });
}, TIMEOUT);

test("#222: provider diffusers fails visibly for both models, naming the model, before any network or model access", async () => {
  const api = await seams();
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-generate-diffusers-"));
  const spy = spyOnFetch();
  try {
    const registration = api.createImageGenerateRegistration({ provider: "diffusers" });
    for (const model of [FLUX, ZIMAGE]) {
      const parameters = baseParameters(model, { provider: "diffusers" });
      let resolved: Record<string, unknown>;
      try {
        resolved = api.resolveImageGenerateParameters(parameters);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.match(error.message, /diffusers/i);
        assert.ok(error.message.includes(model), `resolution failure names ${model}`);
        resolved = parameters;
      }
      const error = await rejectsVisibly(runAssetOperation(root, registration, { parameters: resolved, inputs: {} }), /diffusers/i, model);
      assert.ok(error.message.includes(model), `the failure names ${model}`);
      assert.match(error.message, /not supported|unsupported/i);
    }
    assert.deepEqual(spy.calls, [], "no network access");
    assert.deepEqual(await listFiles(path.join(root, ".asset-tooling")), [], "nothing stored or cached");
  } finally {
    spy.restore();
    await rm(root, { recursive: true, force: true });
  }
}, TIMEOUT);

test("#222: invalid parameters passed straight to runAssetOperation fail before any /prompt", async () => {
  await withHarness(async (h) => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["negativePrompt", { ...h.api.resolveImageGenerateParameters(baseParameters(FLUX)), negativePrompt: "blurry" }, /negativePrompt/],
      ["shift on flux", { ...h.api.resolveImageGenerateParameters(baseParameters(FLUX)), shift: 3 }, /shift/],
      ["unknown field", { ...h.api.resolveImageGenerateParameters(baseParameters(ZIMAGE)), denoise: 0.5 }, /denoise/],
      ["bad width", { ...h.api.resolveImageGenerateParameters(baseParameters(ZIMAGE)), width: 60 }, /width/],
      ["unknown model", { ...h.api.resolveImageGenerateParameters(baseParameters(ZIMAGE)), model: "sd15" }, /model|sd15/],
    ];
    for (const [label, parameters, pattern] of cases) {
      await rejectsVisibly(runAssetOperation(h.root, h.registration, { parameters, inputs: {} }), pattern, label);
    }
    assert.equal(h.promptPosts(), 0);
    assert.deepEqual(await h.objects(), []);
  });
}, TIMEOUT);

test("#222: an output with the wrong size or a failed execution stores nothing", async () => {
  await withHarness(async (h) => {
    const parameters = h.api.resolveImageGenerateParameters(baseParameters(FLUX));
    h.fake.behaviour = "wrong-size";
    await rejectsVisibly(runAssetOperation(h.root, h.registration, { parameters, inputs: {} }), /ComfyUI/, "wrong size");
    h.fake.behaviour = "execution-error";
    await rejectsVisibly(
      runAssetOperation(h.root, h.registration, { parameters, inputs: {} }),
      /fake loader exploded|ComfyUI/,
      "execution error",
    );
    assert.deepEqual(await h.objects(), []);
    assert.deepEqual(await h.cacheEntries(), []);
  });
}, TIMEOUT);

test("#222: a ComfyUI server that drifted from the probed identity fails closed before /prompt", async () => {
  await withHarness(async (h) => {
    h.fake.comfyuiVersion = "0.4.0";
    await rejectsVisibly(
      runAssetOperation(h.root, h.registration, { parameters: h.api.resolveImageGenerateParameters(baseParameters(FLUX)), inputs: {} }),
      /ComfyUI/,
      "server drift",
    );
    assert.equal(h.promptPosts(), 0);
  });
}, TIMEOUT);

test("#222: creating a registration performs no network or file access and rejects incomplete options", async () => {
  await withHarness(async (h) => {
    const registration = h.register({ modelsDirectory: path.join(h.root, "does-not-exist") });
    assert.equal(typeof registration.execute, "function");
    assert.equal(registration.descriptor.id, "image.generate");
    assert.equal(h.fake.requests.length, 0);
    assert.equal(h.spy.calls.length, 0);
    for (const [label, extra] of [
      ["no endpoint", { endpoint: undefined }],
      ["remote endpoint", { endpoint: "http://example.com:8188" }],
      ["no server identity", { server: undefined }],
      ["no models directory", { modelsDirectory: undefined }],
      ["unknown provider", { provider: "openai" }],
    ] as [string, Record<string, unknown>][]) {
      assert.throws(() => h.register(extra), Error, label);
    }
  });
}, TIMEOUT);
