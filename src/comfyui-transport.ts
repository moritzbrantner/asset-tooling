/**
 * Shared, internal ComfyUI transport for the ComfyUI-backed image operations
 * (`image.comfyui.generate@1`, `image.generate@1`). Not a package export.
 *
 * Every request goes only to an explicit loopback endpoint, never follows redirects, submits a
 * prompt at most once, and treats a lost submission or an unfinished run as ambiguous instead of
 * retrying. Pinned local files (checkpoints, model files) are hashed before use.
 *
 * Cancellation (Atlas Decision 5.1.5): every request and poll delay observes an optional
 * AbortSignal. A cancel deletes only this operation's own queued prompt (`POST /queue {delete}`),
 * reports a running prompt as ambiguous and never calls `/interrupt`. Cancellation errors have
 * `name === "AbortError"` and a message starting with "cancelled".
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { assetObjectPortablePath, storeAssetObject, type StoreAssetObjectOptions, type StoreAssetObjectResult } from "./asset-store.js";

import { canonicalJson, type CanonicalJsonValue } from "./canonical.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MIN_VIEW_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];


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

// ─── Small helpers ──────────────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  return value;
}

export function assertKeys(value: Record<string, unknown>, allowed: readonly string[], location: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

export function assertString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${location} must be a non-empty string`);
  return value;
}

export function assertPositiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value;
}

export function errorText(error: unknown): string {
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

/** An error reporting a cancellation: `name` is "AbortError", the message starts with "cancelled". */
export function cancellationError(message: string): Error {
  const error = new Error(message.startsWith("cancelled") ? message : `cancelled: ${message}`);
  error.name = "AbortError";
  return error;
}

export function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError" && error.message.startsWith("cancelled");
}

/** Waits `ms`, or resolves early (returning false) once `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The AbortSignal of an execution context (`{ signal }`), or undefined when there is none. */
export function executionSignal(context: unknown): AbortSignal | undefined {
  const signal = isRecord(context) ? context.signal : undefined;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** Rejects with a cancellation error when `signal` aborted before anything was submitted. */
export function throwIfCancelledBeforeSubmit(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError("cancelled before the ComfyUI prompt was submitted; nothing was sent to the queue");
}

/** Short bound for the queue requests a cancel makes; they never use the (already aborted) caller signal. */
const CANCEL_REQUEST_TIMEOUT_MS = 5_000;

/** A 3xx answer; never followed, so no request or response leaves the validated loopback origin. */
class ComfyUiRedirectError extends Error {}

/**
 * Every request goes through the current `globalThis.fetch`, only to the configured endpoint.
 * Redirects are not followed: any 3xx answer rejects with a ComfyUiRedirectError.
 */
async function comfyFetch(
  endpoint: string,
  route: string,
  init: Omit<RequestInit, "signal"> & { timeoutMs: number; cancel?: AbortSignal | undefined },
): Promise<Response> {
  const { timeoutMs, cancel, ...rest } = init;
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  const response = await globalThis.fetch(`${endpoint}${route}`, {
    ...rest,
    redirect: "manual",
    signal: cancel === undefined ? timeout : AbortSignal.any([cancel, timeout]),
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

export function normalizeEndpoint(value: unknown): string {
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

export async function readServerIdentity(endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<ComfyUiServerIdentity> {
  let response: Response;
  try {
    response = await comfyFetch(endpoint, "/system_stats", { method: "GET", timeoutMs, cancel: signal });
  } catch (error) {
    if (error instanceof ComfyUiRedirectError) throw error;
    if (signal?.aborted) throw cancellationError("cancelled before the ComfyUI prompt was submitted; nothing was sent to the queue");
    throw new Error(`ComfyUI server at ${endpoint} is unavailable: ${errorText(error)}`);
  }
  if (!response.ok) {
    throw new Error(`ComfyUI server at ${endpoint} is unavailable: GET /system_stats answered HTTP ${response.status}`);
  }
  let stats: unknown;
  try {
    stats = await response.json();
  } catch {
    if (signal?.aborted) throw cancellationError("cancelled before the ComfyUI prompt was submitted; nothing was sent to the queue");
    throw new Error(`ComfyUI server at ${endpoint} answered /system_stats with invalid JSON`);
  }
  return serverIdentityFromStats(stats);
}

/** Fail closed when the server no longer reports the identity a registration was created for. */
export async function assertServerIdentityUnchanged(
  endpoint: string,
  expectedJson: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const current = await readServerIdentity(endpoint, Math.min(DEFAULT_PROBE_TIMEOUT_MS, timeoutMs), signal);
  if (canonicalJson(current) !== expectedJson) {
    throw new Error(
      `ComfyUI server identity drifted since the probe (expected ${expectedJson}, now ${canonicalJson(current)}); re-probe and re-register before running`,
    );
  }
}

// ─── Pinned files ───────────────────────────────────────────────────────────────────────────────

/** Identity of the verified file on disk; any replacement or rewrite changes it (inode, size, times). */
function fileSignature(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, sha256: string): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, sha256].join(":");
}



/** A local file pinned by name, byte length and SHA-256. */
export interface PinnedFile {
  name: string;
  sha256: string;
  byteLength: number;
}

/** Hash the pinned file at `file` and return the verified file's signature. `label` names it in errors. */
export async function verifyPinnedFile(file: string, pin: PinnedFile, label: string): Promise<string> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    throw new Error(`${label} '${pin.name}' is missing at ${file}: ${errorText(error)} (acquire it separately; nothing is downloaded)`);
  }
  if (!info.isFile()) throw new Error(`${label} '${pin.name}' at ${file} is not a file`);
  if (info.size !== pin.byteLength) {
    throw new Error(`${label} '${pin.name}' has ${info.size} bytes, declared ${pin.byteLength}`);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  const actual = digest.digest("hex");
  if (actual !== pin.sha256) {
    throw new Error(`${label} '${pin.name}' sha256 ${actual} does not match declared ${pin.sha256}`);
  }
  return fileSignature(info, actual);
}

/** The current signature of `file` assuming the pinned digest, or undefined when it cannot be read. */
export async function pinnedFileSignature(file: string, sha256: string): Promise<string | undefined> {
  try {
    return fileSignature(await stat(file), sha256);
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

// ─── Cancellation ───────────────────────────────────────────────────────────────────────────────

interface QueueLocation {
  state: "pending" | "running";
  promptId: string;
  /** The entry's `extra_data.client_id`, when it reports one. */
  clientId: string | undefined;
}

/** Finds the own prompt in `GET /queue`, by prompt id or by the submission's client_id. */
async function locateInQueue(endpoint: string, match: { promptId?: string; clientId?: string }): Promise<QueueLocation | undefined> {
  const response = await comfyFetch(endpoint, "/queue", { method: "GET", timeoutMs: CANCEL_REQUEST_TIMEOUT_MS });
  if (!response.ok) throw new Error(`GET /queue answered HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("GET /queue answered invalid JSON");
  }
  const queue = isRecord(body) ? body : {};
  for (const [key, state] of [
    ["queue_running", "running"],
    ["queue_pending", "pending"],
  ] as const) {
    const entries = Array.isArray(queue[key]) ? (queue[key] as unknown[]) : [];
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[1] !== "string") continue;
      const extra = isRecord(entry[3]) ? entry[3] : {};
      if (
        (match.promptId !== undefined && entry[1] === match.promptId) ||
        (match.promptId === undefined && match.clientId !== undefined && extra.client_id === match.clientId)
      ) {
        return { state, promptId: entry[1], clientId: typeof extra.client_id === "string" ? extra.client_id : undefined };
      }
    }
  }
  return undefined;
}

/** Deletes exactly this pending prompt (never `/interrupt`), then re-reads the queue to report the outcome. */
async function deleteOwnPending(endpoint: string, promptId: string, clientId: string): Promise<never> {
  const response = await comfyFetch(endpoint, "/queue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
    timeoutMs: CANCEL_REQUEST_TIMEOUT_MS,
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`POST /queue {delete} answered HTTP ${response.status}`);
  const after = await locateInQueue(endpoint, { promptId });
  if (after?.state === "running") {
    throw cancellationError(
      `cancelled: ComfyUI run is ambiguous: prompt ${promptId} (client_id ${clientId}) started before it could be deleted from the queue and may still finish on the server; it was not interrupted and nothing was stored`,
    );
  }
  throw cancellationError(`cancelled: ComfyUI prompt ${promptId} (client_id ${clientId}) was deleted from the queue before it ran; nothing was stored`);
}

/**
 * Settles a cancelled, accepted prompt: a pending one is deleted from the queue, a running one is
 * reported as ambiguous, a finished one is not imported. Always rejects with a cancellation error.
 */
export async function cancelPrompt(endpoint: string, promptId: string, clientId: string): Promise<never> {
  let location: QueueLocation | undefined;
  try {
    location = await locateInQueue(endpoint, { promptId });
    // Ownership is the prompt id AND the submitted client_id: an entry this run cannot prove it
    // owns (for example a stale or reused prompt id answered by POST /prompt) is never deleted.
    if (location !== undefined && location.clientId !== clientId) {
      throw cancellationError(
        `cancelled: ComfyUI run is ambiguous: the queue entry for prompt ${promptId} carries client_id ${location.clientId ?? "(none)"}, not this run's client_id ${clientId}; it was not deleted or interrupted, this run's prompt may still finish on the server and nothing was stored`,
      );
    }
    if (location?.state === "pending") return await deleteOwnPending(endpoint, promptId, clientId);
  } catch (error) {
    if (isCancellationError(error)) throw error;
    throw cancellationError(
      `cancelled: ComfyUI run is ambiguous: the queue state of prompt ${promptId} (client_id ${clientId}) could not be settled (${errorText(error)}); it was not interrupted, may still finish on the server and nothing was stored`,
    );
  }
  if (location?.state === "running") {
    throw cancellationError(
      `cancelled: ComfyUI run is ambiguous: prompt ${promptId} (client_id ${clientId}) is already running and may still finish on the server; it was not interrupted and nothing was stored`,
    );
  }
  throw cancellationError(
    `cancelled: ComfyUI prompt ${promptId} (client_id ${clientId}) is no longer queued or running (it may have finished on the server); its output was not imported and nothing was stored`,
  );
}

/**
 * Settles a cancel that interrupted `POST /prompt`: the own client_id is looked up in the queue;
 * a pending prompt is deleted, anything else is an ambiguous submission. Never resubmits.
 */
async function cancelSubmission(endpoint: string, clientId: string): Promise<never> {
  let location: QueueLocation | undefined;
  try {
    location = await locateInQueue(endpoint, { clientId });
    if (location?.state === "pending") return await deleteOwnPending(endpoint, location.promptId, clientId);
  } catch (error) {
    if (isCancellationError(error)) throw error;
    throw cancellationError(
      `cancelled: ComfyUI submission is ambiguous: cancelled during POST /prompt and the queue could not be read (${errorText(error)}); a prompt with client_id ${clientId} may still run on the server and was not resubmitted`,
    );
  }
  if (location?.state === "running") {
    throw cancellationError(
      `cancelled: ComfyUI submission is ambiguous: cancelled during POST /prompt, and prompt ${location.promptId} (client_id ${clientId}) is already running and may still finish on the server; it was not interrupted or resubmitted`,
    );
  }
  throw cancellationError(
    `cancelled: ComfyUI submission is ambiguous: cancelled during POST /prompt and no prompt with client_id ${clientId} is queued; the server may still accept and run it, and it was not resubmitted`,
  );
}

// ─── Submit, poll, fetch ────────────────────────────────────────────────────────────────────────

export async function submitPrompt(
  endpoint: string,
  prompt: Record<string, any>,
  clientId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw cancellationError("cancelled before the ComfyUI prompt was submitted; nothing was sent to the queue");
  let response: Response;
  try {
    response = await comfyFetch(endpoint, "/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, client_id: clientId }),
      timeoutMs,
      cancel: signal,
    });
  } catch (error) {
    if (error instanceof ComfyUiRedirectError) throw error;
    if (signal?.aborted) return cancelSubmission(endpoint, clientId);
    if (isConnectionRefused(error)) throw new Error(`ComfyUI server at ${endpoint} is unavailable: ${errorText(error)}`);
    throw new Error(
      `ComfyUI submission is ambiguous: the POST /prompt response was lost (${isTimeout(error) ? "timed out" : errorText(error)}); the job may have been accepted and was not resubmitted (client_id ${clientId})`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (signal?.aborted) return cancelSubmission(endpoint, clientId);
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

export interface OutputImage {
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
export async function awaitOutput(
  endpoint: string,
  promptId: string,
  outputNode: string,
  deadline: number,
  pollIntervalMs: number,
  signal?: AbortSignal,
  clientId = "",
): Promise<OutputImage> {
  let lastTransient = "";
  for (;;) {
    if (signal?.aborted) return cancelPrompt(endpoint, promptId, clientId);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `ComfyUI run is ambiguous: prompt ${promptId} was accepted but did not complete within the timeout${lastTransient ? ` (last error: ${lastTransient})` : ""}; it was not resubmitted or interrupted and may still run on the server`,
      );
    }
    let body: unknown;
    try {
      const response = await comfyFetch(endpoint, `/history/${encodeURIComponent(promptId)}`, {
        method: "GET",
        timeoutMs: remaining,
        cancel: signal,
      });
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
      if (signal?.aborted) return cancelPrompt(endpoint, promptId, clientId);
      if (error instanceof ComfyUiRedirectError) throw error;
      if (error instanceof Error && error.message.startsWith("ComfyUI history")) throw error;
      lastTransient = errorText(error);
      body = undefined;
    }

    // The cancel wins any completion race: a record that arrived after the abort is not used.
    if (signal?.aborted) return cancelPrompt(endpoint, promptId, clientId);
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
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/** Rejects with a cancellation error once `signal` aborted after the prompt finished: its output is never imported. */
export function throwIfOutputCancelled(signal: AbortSignal | undefined, promptId: string): void {
  if (signal?.aborted) {
    throw cancellationError(`cancelled: ComfyUI prompt ${promptId} finished, but the run was cancelled before its output was imported; nothing was stored`);
  }
}

/**
 * Imports the verified output bytes unless the run was cancelled. When the signal aborted by the
 * time the store settles, an object this call newly created is removed again (an object that
 * already existed before is never touched) and the run rejects with a cancellation error.
 */
export async function storeOutputUnlessCancelled(
  root: string,
  options: StoreAssetObjectOptions,
  signal: AbortSignal | undefined,
  promptId: string,
): Promise<StoreAssetObjectResult> {
  throwIfOutputCancelled(signal, promptId);
  const stored = await storeAssetObject(root, options);
  if (signal?.aborted) {
    if (stored.status === "changed") {
      await rm(path.join(root, ...assetObjectPortablePath(stored.asset).split("/")), { force: true });
    }
    throwIfOutputCancelled(signal, promptId);
  }
  return stored;
}

export async function fetchOutput(
  endpoint: string,
  promptId: string,
  image: OutputImage,
  deadline: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfOutputCancelled(signal, promptId);
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
  let response: Response;
  try {
    response = await comfyFetch(endpoint, `/view?${query}`, {
      method: "GET",
      timeoutMs: Math.max(MIN_VIEW_TIMEOUT_MS, deadline - Date.now()),
      cancel: signal,
    });
  } catch (error) {
    throwIfOutputCancelled(signal, promptId);
    if (error instanceof ComfyUiRedirectError) throw error;
    throw new Error(`ComfyUI output for prompt ${promptId} could not be fetched: ${errorText(error)}`);
  }
  if (!response.ok) throw new Error(`ComfyUI output for prompt ${promptId} could not be fetched: GET /view answered HTTP ${response.status}`);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throwIfOutputCancelled(signal, promptId);
    throw error;
  }
  throwIfOutputCancelled(signal, promptId);
  return bytes;
}

export function verifyPng(bytes: Buffer, promptId: string, width: number, height: number): void {
  if (bytes.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`ComfyUI output for prompt ${promptId} is not a PNG`);
  }
  const actualWidth = bytes.readUInt32BE(16);
  const actualHeight = bytes.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`ComfyUI output for prompt ${promptId} has size ${actualWidth}x${actualHeight}, expected the injected ${width}x${height}`);
  }
}
