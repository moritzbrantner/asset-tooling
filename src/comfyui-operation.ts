/**
 * `image.comfyui.generate@1`: run one prepared, byte-pinned ComfyUI API-format workflow on an
 * explicit local ComfyUI server and import its real PNG output (asset-tooling#212).
 *
 * ComfyUI stays the authority for the native graph, nodes, models, queue and execution. This
 * module owns only the project-facing contract: declared injections, a hash-verified local
 * checkpoint, a server identity, job-scoped transport, verified PNG import and a receipt.
 * See docs/prd-comfyui-provider.md and docs/comfyui-first.md.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AssetOperationRunRegistration } from "./asset-store.js";
import { canonicalJson } from "./canonical.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  assertKeys,
  assertServerIdentityUnchanged,
  assertPositiveInteger,
  assertRecord,
  assertString,
  awaitOutput,
  executionSignal,
  fetchOutput,
  isRecord,
  normalizeEndpoint,
  pinnedFileSignature,
  readServerIdentity,
  storeOutputUnlessCancelled,
  submitPrompt,
  throwIfCancelledBeforeSubmit,
  throwIfOutputCancelled,
  verifyPinnedFile,
  verifyPng,
  type ComfyUiServerIdentity,
} from "./comfyui-transport.js";
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
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

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

export type { ComfyUiServerIdentity } from "./comfyui-transport.js";

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

// ─── Probe ──────────────────────────────────────────────────────────────────────────────────────

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

const checkpointFile = (directory: string, checkpoint: ComfyUiCheckpointIdentity) => path.join(directory, ...checkpoint.name.split("/"));

/** Hash the declared checkpoint and return the verified file's signature. */
function verifyCheckpoint(directory: string, checkpoint: ComfyUiCheckpointIdentity): Promise<string> {
  return verifyPinnedFile(checkpointFile(directory, checkpoint), checkpoint, "ComfyUI checkpoint");
}

function checkpointSignature(directory: string, checkpoint: ComfyUiCheckpointIdentity): Promise<string | undefined> {
  return pinnedFileSignature(checkpointFile(directory, checkpoint), checkpoint.sha256);
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
    async execute(root, invocation, context): Promise<AssetOperationResult> {
      const signal = executionSignal(context);
      throwIfCancelledBeforeSubmit(signal);
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
      await assertServerIdentityUnchanged(endpoint, serverJson, timeoutMs, signal);
      throwIfCancelledBeforeSubmit(signal);

      // 4. Submit once; 5. await this prompt's history; fetch the declared output exactly once.
      const clientId = `asset-tooling-${randomUUID()}`;
      const promptId = await submitPrompt(endpoint, submitted, clientId, deadline - Date.now(), signal);
      const image = await awaitOutput(endpoint, promptId, parameters.output.node, deadline, pollIntervalMs, signal, clientId);
      const bytes = await fetchOutput(endpoint, promptId, image, deadline, signal);

      // 6. Verify and import the actual bytes.
      throwIfOutputCancelled(signal, promptId);
      verifyPng(bytes, promptId, width, height);
      const stored = await storeOutputUnlessCancelled(
        root,
        {
          bytes,
          kind: "image",
          mediaType: "image/png",
          metadata: { width, height },
        },
        signal,
        promptId,
      );

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
