/**
 * `image.comfyui.generate@1`: run one prepared, byte-pinned ComfyUI API-format workflow on an
 * explicit local ComfyUI server and import its real PNG output (asset-tooling#212).
 *
 * ComfyUI stays the authority for the native graph, nodes, models, queue and execution. This
 * module owns only the project-facing contract: declared injections, a hash-verified local
 * checkpoint, a server identity, job-scoped transport, verified PNG import and a receipt.
 * See docs/prd-comfyui-provider.md and docs/comfyui-first.md.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { storeAssetObject, type AssetOperationRunRegistration } from "./asset-store.js";
import { canonicalJson, type CanonicalJsonValue } from "./canonical.js";
import { loadPreparedComfyUiApiWorkflow } from "./comfyui-workflow.js";
import { sha256Bytes, sha256Text } from "./hash.js";
import {
  createAssetOperationRegistry,
  type AssetOperationResult,
  type CanonicalJsonObject,
  type ReadonlyAssetOperationDescriptor,
} from "./operations.js";

const OPERATION_ID = "image.comfyui.generate";
const OPERATION_VERSION = "1";
const IMPLEMENTATION_ID = "asset-tooling.comfyui-image-generate";
const IMPLEMENTATION_VERSION = "1";
const PROVIDER = "comfyui";
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MIN_VIEW_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const VALUE_INJECTIONS = ["seed", "positivePrompt", "negativePrompt", "width", "height"] as const;
const REQUIRED_INJECTIONS = new Set(["checkpoint", "seed", "positivePrompt", "width", "height"]);
type ValueInjectionName = (typeof VALUE_INJECTIONS)[number];

const BINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["node", "input"],
  properties: { node: { type: "string", minLength: 1 }, input: { type: "string", minLength: 1 } },
};

function valueBindingSchema(value: CanonicalJsonObject): CanonicalJsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["node", "input", "value"],
    properties: { ...BINDING_SCHEMA.properties, value },
  };
}

const DIMENSION_SCHEMA = { type: "integer", minimum: 8, multipleOf: 8 };

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "ComfyUI image generation",
    description:
      "Run one prepared ComfyUI API-format workflow on an explicit local ComfyUI server with declared injections and a hash-verified local checkpoint, and import the verified PNG output.",
    category: "image.generate",
    inputs: [
      {
        id: "workflow",
        label: "Prepared ComfyUI API-format workflow",
        assetKinds: ["workflow"],
        mediaTypes: ["application/json"],
        cardinality: "single",
        required: true,
      },
    ],
    outputs: [
      {
        id: "image",
        label: "Generated PNG",
        assetKinds: ["image"],
        mediaTypes: ["image/png"],
        cardinality: "single",
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "checkpoint", "injections", "output"],
      properties: {
        provider: { type: "string", enum: [PROVIDER] },
        checkpoint: {
          type: "object",
          additionalProperties: false,
          required: ["name", "sha256", "byteLength", "license"],
          properties: {
            name: { type: "string", minLength: 1 },
            sha256: { type: "string", pattern: SHA256_PATTERN.source },
            byteLength: { type: "integer", minimum: 0 },
            license: { type: "string", minLength: 1 },
          },
        },
        injections: {
          type: "object",
          additionalProperties: false,
          required: ["checkpoint", "seed", "positivePrompt", "width", "height"],
          properties: {
            checkpoint: BINDING_SCHEMA,
            seed: valueBindingSchema({ type: "integer", minimum: 0 }),
            positivePrompt: valueBindingSchema({ type: "string" }),
            negativePrompt: valueBindingSchema({ type: "string" }),
            width: valueBindingSchema(DIMENSION_SCHEMA),
            height: valueBindingSchema(DIMENSION_SCHEMA),
          },
        },
        output: {
          type: "object",
          additionalProperties: false,
          required: ["node"],
          properties: { node: { type: "string", minLength: 1 } },
        },
      },
    },
  },
]);

export const COMFYUI_IMAGE_GENERATE_OPERATION: ReadonlyAssetOperationDescriptor = OPERATION_REGISTRY.get(
  OPERATION_ID,
  OPERATION_VERSION,
)!;

/** Stable, canonical identity of a ComfyUI server as reported by `GET /system_stats`. */
export interface ComfyUiServerIdentity {
  comfyuiVersion: string;
  pythonVersion: string | null;
  pytorchVersion: string | null;
  os: string | null;
  embeddedPython: boolean | null;
  devices: { name: string | null; type: string | null; index: number | null }[];
  [key: string]: CanonicalJsonValue;
}

export interface ProbeComfyUiServerOptions {
  endpoint: string;
  timeoutMs?: number;
}

export interface ComfyUiImageGenerateRegistrationOptions {
  /** Explicit loopback http URL of the ComfyUI server; there is no default. */
  endpoint: string;
  /** Identity from `probeComfyUiServer`; execution fails closed if the server drifted from it. */
  server: ComfyUiServerIdentity;
  /** 40-hex ComfyUI commit from the managed setup receipt, when known. */
  comfyuiCommit?: string;
  /** Directory the server loads checkpoints from; the declared checkpoint is hashed there. */
  checkpointDirectory: string;
  /** Total budget for submission plus completion. */
  timeoutMs?: number;
  /** `/history/{prompt_id}` polling interval. */
  pollIntervalMs?: number;
}

export interface ComfyUiCheckpointIdentity {
  name: string;
  sha256: string;
  byteLength: number;
  license: string;
}

interface Binding {
  node: string;
  input: string;
}

interface ValueBinding extends Binding {
  value: string | number;
}

interface ComfyUiImageGenerateParameters {
  provider: typeof PROVIDER;
  checkpoint: ComfyUiCheckpointIdentity;
  injections: { checkpoint: Binding } & Partial<Record<ValueInjectionName, ValueBinding>>;
  output: { node: string };
}

// ─── Small helpers ──────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], location: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function assertPositiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ConnectionRefused" || code === "ECONNREFUSED";
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A 3xx answer; never followed, so no request or response leaves the validated loopback origin. */
class ComfyUiRedirectError extends Error {}

/**
 * Every request goes through the current `globalThis.fetch`, only to the configured endpoint.
 * Redirects are not followed: any 3xx answer rejects with a ComfyUiRedirectError.
 */
async function comfyFetch(endpoint: string, route: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const response = await globalThis.fetch(`${endpoint}${route}`, {
    ...rest,
    redirect: "manual",
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    throw new ComfyUiRedirectError(
      `ComfyUI server at ${endpoint} answered ${rest.method ?? "GET"} ${route.split("?")[0]} with a redirect (HTTP ${response.status}${location ? ` to ${location}` : ""}); redirects are never followed`,
    );
  }
  return response;
}

function normalizeEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("ComfyUI endpoint must be an explicit local http URL, for example http://127.0.0.1:8188");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ComfyUI endpoint '${value}' is not a URL`);
  }
  if (url.protocol !== "http:") throw new Error(`ComfyUI endpoint '${value}' must use http on a loopback address`);
  if (url.username || url.password) throw new Error("ComfyUI endpoint must not contain credentials");
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`ComfyUI endpoint host '${url.hostname}' is not a loopback address (127.0.0.1, localhost or [::1])`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`ComfyUI endpoint '${value}' must not contain a path, query or fragment`);
  }
  return url.origin;
}

// ─── Probe ──────────────────────────────────────────────────────────────────────────────────────

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function serverIdentityFromStats(stats: unknown): ComfyUiServerIdentity {
  const body = assertRecord(stats, "ComfyUI /system_stats response");
  const system = assertRecord(body.system, "ComfyUI /system_stats system");
  const comfyuiVersion = system.comfyui_version;
  if (typeof comfyuiVersion !== "string" || comfyuiVersion.length === 0) {
    throw new Error("ComfyUI /system_stats does not report system.comfyui_version");
  }
  const devices = Array.isArray(body.devices) ? body.devices : [];
  // Volatile figures (ram_free, vram_free, torch_vram_free, ...) and argv are deliberately excluded.
  const identity: ComfyUiServerIdentity = {
    comfyuiVersion,
    pythonVersion: nullableString(system.python_version),
    pytorchVersion: nullableString(system.pytorch_version),
    os: nullableString(system.os),
    embeddedPython: typeof system.embedded_python === "boolean" ? system.embedded_python : null,
    devices: devices.map((device) => {
      const record = isRecord(device) ? device : {};
      return {
        name: nullableString(record.name),
        type: nullableString(record.type),
        index: typeof record.index === "number" && Number.isSafeInteger(record.index) ? record.index : null,
      };
    }),
  };
  return JSON.parse(canonicalJson(identity)) as ComfyUiServerIdentity;
}

async function readServerIdentity(endpoint: string, timeoutMs: number): Promise<ComfyUiServerIdentity> {
  let response: Response;
  try {
    response = await comfyFetch(endpoint, "/system_stats", { method: "GET", timeoutMs });
  } catch (error) {
    if (error instanceof ComfyUiRedirectError) throw error;
    throw new Error(`ComfyUI server at ${endpoint} is unavailable: ${errorText(error)}`);
  }
  if (!response.ok) {
    throw new Error(`ComfyUI server at ${endpoint} is unavailable: GET /system_stats answered HTTP ${response.status}`);
  }
  let stats: unknown;
  try {
    stats = await response.json();
  } catch {
    throw new Error(`ComfyUI server at ${endpoint} answered /system_stats with invalid JSON`);
  }
  return serverIdentityFromStats(stats);
}

/**
 * Read the server's identity from `GET /system_stats` only. Two probes of an unchanged server
 * are deepEqual; an unreachable server rejects as unavailable.
 */
export async function probeComfyUiServer({ endpoint, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }: ProbeComfyUiServerOptions): Promise<ComfyUiServerIdentity> {
  return readServerIdentity(normalizeEndpoint(endpoint), assertPositiveInteger(timeoutMs, "ComfyUI probe timeoutMs"));
}

// ─── Parameters and injections ──────────────────────────────────────────────────────────────────

function parseCheckpoint(value: unknown): ComfyUiCheckpointIdentity {
  const checkpoint = assertRecord(value, "ComfyUI parameters.checkpoint");
  assertKeys(checkpoint, ["name", "sha256", "byteLength", "license"], "ComfyUI parameters.checkpoint");
  const name = assertString(checkpoint.name, "checkpoint name");
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`checkpoint name '${name}' must be a relative path inside the checkpoint directory`);
  }
  if (typeof checkpoint.sha256 !== "string" || !SHA256_PATTERN.test(checkpoint.sha256)) {
    throw new Error("checkpoint sha256 must be a lowercase 64-character SHA-256 digest");
  }
  const byteLength = checkpoint.byteLength;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("checkpoint byteLength must be a non-negative safe integer");
  }
  const license = assertString(checkpoint.license, "checkpoint license");
  return { name, sha256: checkpoint.sha256, byteLength, license };
}

function parseBinding(value: unknown, name: string, withValue: boolean): ValueBinding | Binding {
  const binding = assertRecord(value, `ComfyUI injection '${name}'`);
  if (!withValue && Object.hasOwn(binding, "value")) {
    throw new Error(`ComfyUI injection 'checkpoint' takes no value; it always receives checkpoint.name`);
  }
  assertKeys(binding, withValue ? ["node", "input", "value"] : ["node", "input"], `ComfyUI injection '${name}'`);
  const node = assertString(binding.node, `ComfyUI injection '${name}' node`);
  const input = assertString(binding.input, `ComfyUI injection '${name}' input`);
  if (!withValue) return { node, input };
  const injected = binding.value;
  if (name === "seed") {
    if (typeof injected !== "number" || !Number.isSafeInteger(injected) || injected < 0) {
      throw new Error("ComfyUI injection 'seed' value must be a non-negative safe integer");
    }
  } else if (name === "positivePrompt" || name === "negativePrompt") {
    if (typeof injected !== "string") throw new Error(`ComfyUI injection '${name}' value must be a string`);
  } else if (typeof injected !== "number" || !Number.isSafeInteger(injected) || injected <= 0 || injected % 8 !== 0) {
    throw new Error(`ComfyUI injection '${name}' value must be a positive integer multiple of 8`);
  }
  return { node, input, value: injected as string | number };
}

function parseParameters(value: unknown, prompt: Record<string, any>): ComfyUiImageGenerateParameters {
  const parameters = assertRecord(value, "ComfyUI parameters");
  assertKeys(parameters, ["provider", "checkpoint", "injections", "output"], "ComfyUI parameters");
  if (parameters.provider !== PROVIDER) {
    throw new Error(`ComfyUI parameters.provider must explicitly select "${PROVIDER}"`);
  }
  const checkpoint = parseCheckpoint(parameters.checkpoint);

  const rawInjections = assertRecord(parameters.injections, "ComfyUI parameters.injections");
  assertKeys(rawInjections, ["checkpoint", ...VALUE_INJECTIONS], "ComfyUI parameters.injections (declared injection names)");
  for (const name of REQUIRED_INJECTIONS) {
    if (!Object.hasOwn(rawInjections, name)) throw new Error(`ComfyUI injection '${name}' is required`);
  }
  const injections: ComfyUiImageGenerateParameters["injections"] = {
    checkpoint: parseBinding(rawInjections.checkpoint, "checkpoint", false),
  };
  for (const name of VALUE_INJECTIONS) {
    if (Object.hasOwn(rawInjections, name)) injections[name] = parseBinding(rawInjections[name], name, true) as ValueBinding;
  }

  const targets = new Set<string>();
  for (const [name, binding] of Object.entries(injections) as [string, Binding][]) {
    const node = prompt[binding.node];
    if (!isRecord(node)) throw new Error(`ComfyUI injection '${name}' targets missing workflow node '${binding.node}'`);
    const inputs = node.inputs as Record<string, unknown>;
    if (!Object.hasOwn(inputs, binding.input)) {
      throw new Error(`ComfyUI injection '${name}' targets missing input '${binding.input}' of node '${binding.node}'`);
    }
    if (Array.isArray(inputs[binding.input])) {
      throw new Error(`ComfyUI injection '${name}' targets input '${binding.input}' of node '${binding.node}', which is a link, not a literal value`);
    }
    const target = `${binding.node}\0${binding.input}`;
    if (targets.has(target)) throw new Error(`ComfyUI injection '${name}' targets an input another injection already binds`);
    targets.add(target);
  }

  const output = assertRecord(parameters.output, "ComfyUI parameters.output");
  assertKeys(output, ["node"], "ComfyUI parameters.output");
  const outputNode = assertString(output.node, "ComfyUI parameters.output.node");
  if (!isRecord(prompt[outputNode])) throw new Error(`ComfyUI output node '${outputNode}' does not exist in the workflow`);

  return { provider: PROVIDER, checkpoint, injections, output: { node: outputNode } };
}

function applyInjections(prompt: Record<string, any>, parameters: ComfyUiImageGenerateParameters): Record<string, any> {
  const { checkpoint, ...values } = parameters.injections;
  prompt[checkpoint.node].inputs[checkpoint.input] = parameters.checkpoint.name;
  for (const binding of Object.values(values) as ValueBinding[]) {
    prompt[binding.node].inputs[binding.input] = binding.value;
  }
  return prompt;
}

// ─── Checkpoint ─────────────────────────────────────────────────────────────────────────────────

/** Identity of the verified file on disk; any replacement or rewrite changes it (inode, size, times). */
function fileSignature(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, sha256: string): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, sha256].join(":");
}

/** Hash the declared checkpoint and return the verified file's signature. */
async function verifyCheckpoint(directory: string, checkpoint: ComfyUiCheckpointIdentity): Promise<string> {
  const file = path.join(directory, ...checkpoint.name.split("/"));
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    throw new Error(`ComfyUI checkpoint '${checkpoint.name}' is missing at ${file}: ${errorText(error)} (acquire it separately; nothing is downloaded)`);
  }
  if (!info.isFile()) throw new Error(`ComfyUI checkpoint '${checkpoint.name}' at ${file} is not a file`);
  if (info.size !== checkpoint.byteLength) {
    throw new Error(`ComfyUI checkpoint '${checkpoint.name}' has ${info.size} bytes, declared ${checkpoint.byteLength}`);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  const actual = digest.digest("hex");
  if (actual !== checkpoint.sha256) {
    throw new Error(`ComfyUI checkpoint '${checkpoint.name}' sha256 ${actual} does not match declared ${checkpoint.sha256}`);
  }
  return fileSignature(info, actual);
}

async function checkpointSignature(directory: string, checkpoint: ComfyUiCheckpointIdentity): Promise<string | undefined> {
  try {
    return fileSignature(await stat(path.join(directory, ...checkpoint.name.split("/"))), checkpoint.sha256);
  } catch {
    return undefined;
  }
}

// ─── Transport ──────────────────────────────────────────────────────────────────────────────────

function describeNodeErrors(nodeErrors: unknown): string {
  if (!isRecord(nodeErrors)) return "";
  return Object.entries(nodeErrors)
    .map(([id, entry]) => {
      const record = isRecord(entry) ? entry : {};
      const errors = Array.isArray(record.errors) ? record.errors : [];
      const reasons = errors
        .map((error) => (isRecord(error) ? [error.type, error.message, error.details].filter((part) => typeof part === "string" && part).join(": ") : ""))
        .filter(Boolean)
        .join("; ");
      return `node ${id}${typeof record.class_type === "string" ? ` (${record.class_type})` : ""}: ${reasons || "rejected"}`;
    })
    .join("; ");
}

function describePromptError(body: unknown): string {
  if (!isRecord(body)) return "";
  const error = body.error;
  const head = isRecord(error)
    ? [error.type, error.message, error.details].filter((part) => typeof part === "string" && part).join(": ")
    : typeof error === "string"
      ? error
      : "";
  const nodes = describeNodeErrors(body.node_errors);
  return [head, nodes].filter(Boolean).join("; ");
}

async function submitPrompt(
  endpoint: string,
  prompt: Record<string, any>,
  clientId: string,
  timeoutMs: number,
): Promise<string> {
  let response: Response;
  try {
    response = await comfyFetch(endpoint, "/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, client_id: clientId }),
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof ComfyUiRedirectError) throw error;
    if (isConnectionRefused(error)) throw new Error(`ComfyUI server at ${endpoint} is unavailable: ${errorText(error)}`);
    throw new Error(
      `ComfyUI submission is ambiguous: the POST /prompt response was lost (${isTimeout(error) ? "timed out" : errorText(error)}); the job may have been accepted and was not resubmitted (client_id ${clientId})`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) {
      throw new Error(`ComfyUI submission is ambiguous: POST /prompt answered HTTP ${response.status} without a readable prompt_id (client_id ${clientId})`);
    }
    body = undefined;
  }
  if (!response.ok) {
    const reason = describePromptError(body);
    throw new Error(`ComfyUI rejected the workflow (HTTP ${response.status})${reason ? `: ${reason}` : ""}`);
  }
  const record = isRecord(body) ? body : {};
  const promptId = record.prompt_id;
  if (typeof promptId !== "string" || promptId.length === 0) {
    throw new Error(`ComfyUI submission is ambiguous: POST /prompt answered without a prompt_id (client_id ${clientId})`);
  }
  if (isRecord(record.node_errors) && Object.keys(record.node_errors).length > 0) {
    throw new Error(`ComfyUI accepted prompt ${promptId} with node errors: ${describeNodeErrors(record.node_errors)}`);
  }
  return promptId;
}

interface OutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

function failureMessageKind(status: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  for (const message of messages) {
    if (Array.isArray(message) && (message[0] === "execution_error" || message[0] === "execution_interrupted")) return message[0];
  }
  return undefined;
}

function executionErrorText(promptId: string, status: Record<string, unknown>): string {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    const [kind, data] = message;
    if ((kind === "execution_error" || kind === "execution_interrupted") && isRecord(data)) {
      const where = typeof data.node_id === "string" ? ` at node ${data.node_id}${typeof data.node_type === "string" ? ` (${data.node_type})` : ""}` : "";
      const what = [data.exception_type, data.exception_message].filter((part) => typeof part === "string" && part).join(": ");
      return `ComfyUI execution of prompt ${promptId} failed${where}: ${kind === "execution_interrupted" ? "interrupted" : what || "execution_error"}`;
    }
  }
  return `ComfyUI execution of prompt ${promptId} failed with status '${String(status.status_str)}'`;
}

/** Poll `/history/{prompt_id}` until that prompt's record completes; returns the declared output image. */
async function awaitOutput(
  endpoint: string,
  promptId: string,
  outputNode: string,
  deadline: number,
  pollIntervalMs: number,
): Promise<OutputImage> {
  let lastTransient = "";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `ComfyUI run is ambiguous: prompt ${promptId} was accepted but did not complete within the timeout${lastTransient ? ` (last error: ${lastTransient})` : ""}; it was not resubmitted or interrupted and may still run on the server`,
      );
    }
    let body: unknown;
    try {
      const response = await comfyFetch(endpoint, `/history/${encodeURIComponent(promptId)}`, { method: "GET", timeoutMs: remaining });
      if (!response.ok) {
        lastTransient = `GET /history answered HTTP ${response.status}`;
        body = undefined;
      } else {
        try {
          body = await response.json();
        } catch {
          throw new Error(`ComfyUI history for prompt ${promptId} is not valid JSON`);
        }
      }
    } catch (error) {
      if (error instanceof ComfyUiRedirectError) throw error;
      if (error instanceof Error && error.message.startsWith("ComfyUI history")) throw error;
      lastTransient = errorText(error);
      body = undefined;
    }

    if (body !== undefined) {
      if (!isRecord(body)) throw new Error(`ComfyUI history for prompt ${promptId} is malformed`);
      const keys = Object.keys(body);
      if (keys.length > 0) {
        if (!Object.hasOwn(body, promptId)) {
          throw new Error(`ComfyUI history for prompt ${promptId} is malformed: it answered with a record for another prompt id (${keys.join(", ")})`);
        }
        const record = assertRecord(body[promptId], `ComfyUI history record for prompt ${promptId}`);
        // ComfyUI writes a history record only once the prompt has finished, so a present record
        // must be an unambiguous success; anything else fails visibly instead of being imported.
        const status = isRecord(record.status) ? record.status : {};
        if (status.status_str === "error" || failureMessageKind(status) !== undefined) {
          throw new Error(executionErrorText(promptId, status));
        }
        if (status.completed !== true || status.status_str !== "success") {
          throw new Error(
            `ComfyUI history for prompt ${promptId} has no successful completion (status_str ${JSON.stringify(status.status_str ?? null)}, completed ${JSON.stringify(status.completed ?? null)}); the output is not imported`,
          );
        }
        const outputs = isRecord(record.outputs) ? record.outputs : {};
        const output = isRecord(outputs[outputNode]) ? outputs[outputNode] : {};
        const images = Array.isArray(output.images) ? output.images : [];
        const image = images[0];
        if (
          images.length !== 1 ||
          !isRecord(image) ||
          typeof image.filename !== "string" ||
          image.filename.length === 0 ||
          typeof image.subfolder !== "string" ||
          typeof image.type !== "string"
        ) {
          throw new Error(
            `ComfyUI history for prompt ${promptId} is malformed: expected exactly one image for declared output node '${outputNode}', found ${images.length}`,
          );
        }
        return { filename: image.filename, subfolder: image.subfolder, type: image.type };
      }
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

async function fetchOutput(endpoint: string, promptId: string, image: OutputImage, deadline: number): Promise<Buffer> {
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
  let response: Response;
  try {
    response = await comfyFetch(endpoint, `/view?${query}`, {
      method: "GET",
      timeoutMs: Math.max(MIN_VIEW_TIMEOUT_MS, deadline - Date.now()),
    });
  } catch (error) {
    if (error instanceof ComfyUiRedirectError) throw error;
    throw new Error(`ComfyUI output for prompt ${promptId} could not be fetched: ${errorText(error)}`);
  }
  if (!response.ok) throw new Error(`ComfyUI output for prompt ${promptId} could not be fetched: GET /view answered HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function verifyPng(bytes: Buffer, promptId: string, width: number, height: number): void {
  if (bytes.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`ComfyUI output for prompt ${promptId} is not a PNG`);
  }
  const actualWidth = bytes.readUInt32BE(16);
  const actualHeight = bytes.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`ComfyUI output for prompt ${promptId} has size ${actualWidth}x${actualHeight}, expected the injected ${width}x${height}`);
  }
}

// ─── Registration ───────────────────────────────────────────────────────────────────────────────

/**
 * Create the `runAssetOperation` registration for `image.comfyui.generate@1`. Performs no I/O.
 */
export function createComfyUiImageGenerateRegistration(options: ComfyUiImageGenerateRegistrationOptions): AssetOperationRunRegistration {
  const config = assertRecord(options, "ComfyUI registration options");
  assertKeys(config, ["endpoint", "server", "comfyuiCommit", "checkpointDirectory", "timeoutMs", "pollIntervalMs"], "ComfyUI registration options");
  const endpoint = normalizeEndpoint(config.endpoint);
  const serverValue = assertRecord(config.server, "ComfyUI registration server identity");
  assertString(serverValue.comfyuiVersion, "ComfyUI registration server.comfyuiVersion");
  const serverJson = canonicalJson(serverValue);
  const server = JSON.parse(serverJson) as CanonicalJsonObject;
  const comfyuiCommit = config.comfyuiCommit;
  if (comfyuiCommit !== undefined && (typeof comfyuiCommit !== "string" || !COMMIT_PATTERN.test(comfyuiCommit))) {
    throw new Error("ComfyUI registration comfyuiCommit must be a lowercase 40-character commit");
  }
  const checkpointDirectory = path.resolve(assertString(config.checkpointDirectory, "ComfyUI registration checkpointDirectory"));
  const timeoutMs = assertPositiveInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "ComfyUI registration timeoutMs");
  const pollIntervalMs = assertPositiveInteger(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "ComfyUI registration pollIntervalMs");

  const implementation: CanonicalJsonObject = {
    id: IMPLEMENTATION_ID,
    version: IMPLEMENTATION_VERSION,
    provider: PROVIDER,
    server,
    ...(comfyuiCommit !== undefined ? { comfyuiCommit } : {}),
    reproducibility: "approximate",
  };

  // The signature `verifyDependencies` just verified, consumed by the next `execute` so a miss does
  // not hash a multi-GB checkpoint twice. `execute` re-hashes whenever the file changed since.
  let preverified: string | undefined;

  return {
    descriptor: COMFYUI_IMAGE_GENERATE_OPERATION,
    implementation,
    // Runs before every cache lookup (hits included): the declared checkpoint must still be there.
    async verifyDependencies(_root, invocation): Promise<void> {
      preverified = undefined;
      const parameters = assertRecord(invocation?.parameters, "ComfyUI parameters");
      preverified = await verifyCheckpoint(checkpointDirectory, parseCheckpoint(parameters.checkpoint));
    },
    async execute(root, invocation): Promise<AssetOperationResult> {
      // 1. Local preflight: verified workflow bytes, closed parameters, declared injections.
      const inputs = assertRecord(invocation?.inputs, "ComfyUI operation inputs");
      const workflow = await loadPreparedComfyUiApiWorkflow(root, inputs.workflow);
      const prompt = JSON.parse(workflow.promptJson) as Record<string, any>;
      const parameters = parseParameters(invocation?.parameters, prompt);
      const submitted = applyInjections(prompt, parameters);
      const width = parameters.injections.width!.value as number;
      const height = parameters.injections.height!.value as number;

      // 2. The declared checkpoint must be present locally with the declared bytes.
      const verified = preverified;
      preverified = undefined;
      if (verified === undefined || verified !== (await checkpointSignature(checkpointDirectory, parameters.checkpoint))) {
        await verifyCheckpoint(checkpointDirectory, parameters.checkpoint);
      }

      // 3. The server must still be the one this registration was created for.
      const deadline = Date.now() + timeoutMs;
      const current = await readServerIdentity(endpoint, Math.min(DEFAULT_PROBE_TIMEOUT_MS, timeoutMs));
      if (canonicalJson(current) !== serverJson) {
        throw new Error(
          `ComfyUI server identity drifted since the probe (expected ${serverJson}, now ${canonicalJson(current)}); re-probe and re-register before running`,
        );
      }

      // 4. Submit once; 5. await this prompt's history; fetch the declared output exactly once.
      const clientId = `asset-tooling-${randomUUID()}`;
      const promptId = await submitPrompt(endpoint, submitted, clientId, deadline - Date.now());
      const image = await awaitOutput(endpoint, promptId, parameters.output.node, deadline, pollIntervalMs);
      const bytes = await fetchOutput(endpoint, promptId, image, deadline);

      // 6. Verify and import the actual bytes.
      verifyPng(bytes, promptId, width, height);
      const stored = await storeAssetObject(root, {
        bytes,
        kind: "image",
        mediaType: "image/png",
        metadata: { width, height },
      });

      const comfyui: CanonicalJsonObject = { version: (server.comfyuiVersion as string) };
      if (comfyuiCommit !== undefined) comfyui.commit = comfyuiCommit;
      return {
        outputs: { image: stored.asset },
        observations: {
          provider: PROVIDER,
          reproducibility: "approximate",
          promptId,
          clientId,
          workflow: { sha256: workflow.asset.sha256 },
          submittedPrompt: { sha256: sha256Text(canonicalJson(submitted)) },
          comfyui,
          checkpoint: { ...parameters.checkpoint },
          output: {
            node: parameters.output.node,
            filename: image.filename,
            subfolder: image.subfolder,
            type: image.type,
            sha256: sha256Bytes(bytes),
          },
        },
      };
    },
  };
}
