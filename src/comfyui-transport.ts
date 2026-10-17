/**
 * Shared, internal ComfyUI transport for the ComfyUI-backed image operations
 * (`image.comfyui.generate@1`, `image.generate@1`). Not a package export.
 *
 * Every request goes only to an explicit loopback endpoint, never follows redirects, submits a
 * prompt at most once, and treats a lost submission or an unfinished run as ambiguous instead of
 * retrying. Pinned local files (checkpoints, model files) are hashed before use.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

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

export async function readServerIdentity(endpoint: string, timeoutMs: number): Promise<ComfyUiServerIdentity> {
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

/** Fail closed when the server no longer reports the identity a registration was created for. */
export async function assertServerIdentityUnchanged(endpoint: string, expectedJson: string, timeoutMs: number): Promise<void> {
  const current = await readServerIdentity(endpoint, Math.min(DEFAULT_PROBE_TIMEOUT_MS, timeoutMs));
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

export async function submitPrompt(
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

export async function fetchOutput(endpoint: string, promptId: string, image: OutputImage, deadline: number): Promise<Buffer> {
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
