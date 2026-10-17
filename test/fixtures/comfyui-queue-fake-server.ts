/**
 * In-process fake of the ComfyUI local server that models the prompt QUEUE, for the #224
 * cancellation acceptance tests (test/comfyui-cancellation.test.ts). It does not replace
 * test/fixtures/comfyui-fake-server.ts.
 *
 * Routes, with ComfyUI's documented shapes:
 *   GET  /system_stats                -> { system: {...}, devices: [...] }
 *   POST /prompt {prompt, client_id}  -> 200 { prompt_id, number, node_errors: {} }
 *                                        (or held: the body is received, the answer is delayed)
 *   GET  /queue                       -> { queue_running: [[number, prompt_id, prompt, extra_data, outputs]],
 *                                          queue_pending: [...] }   extra_data = { client_id }
 *   POST /queue {delete: [prompt_id]} -> removes those PENDING prompts (running ones are untouched)
 *   GET  /history/<prompt_id>         -> {} until the job is "done", then the completed record
 *   GET  /view?filename&subfolder&type -> a valid PNG sized from the submitted latent node
 *   POST /interrupt                   -> recorded (the tests assert it is never called)
 *
 * Every job's state is test-controlled: "pending" | "running" | "done" | "deleted". Foreign jobs
 * (other client ids) can be seeded to prove a cancel only touches its own prompt.
 */
import { deflateSync } from "node:zlib";

export type QueueJobState = "pending" | "running" | "done" | "deleted";

export interface QueueJob {
  promptId: string;
  clientId: string;
  number: number;
  prompt: Record<string, any>;
  filename: string;
  state: QueueJobState;
  foreign: boolean;
}

export interface QueueRecordedRequest {
  method: string;
  path: string;
  search: string;
  body?: unknown;
}

/**
 * What POST /prompt does with an accepted body:
 * - "answer":            enqueue in `initialState` and answer with the prompt_id at once
 * - "hold-enqueued":     enqueue as pending, then hold the answer (response lost/slow)
 * - "hold-running":      enqueue as running, then hold the answer
 * - "hold-not-enqueued": do not enqueue anything, hold the answer
 */
export type SubmitMode = "answer" | "hold-enqueued" | "hold-running" | "hold-not-enqueued";

export interface QueueFake {
  readonly endpoint: string;
  readonly requests: QueueRecordedRequest[];
  readonly submissions: { prompt: Record<string, any>; client_id?: unknown; [key: string]: unknown }[];
  readonly servedImages: Buffer[];
  readonly jobs: Map<string, QueueJob>;
  submitMode: SubmitMode;
  /** State a prompt accepted in "answer" mode starts in. */
  initialState: "pending" | "running" | "done";
  /** Called (and awaited) just before a completed history record is answered. */
  onCompletedHistory?: (job: QueueJob) => void | Promise<void>;
  /** Called (and awaited) just before /view answers with bytes. */
  onView?: (job: QueueJob) => void | Promise<void>;
  /** Jobs submitted through POST /prompt (not foreign), in submission order. */
  ownJobs(): QueueJob[];
  addForeignJob(state: "pending" | "running", clientId?: string): QueueJob;
  setState(promptId: string, state: QueueJobState): void;
  queueDeletes(): unknown[];
  interrupts(): number;
  promptPosts(): number;
  views(): number;
  historyPolls(promptId: string): number;
  /** Poll `predicate` every 5 ms until true; reject with `label` after `timeoutMs`. */
  waitFor(predicate: () => boolean, label: string, timeoutMs?: number): Promise<void>;
  /** Release every held POST /prompt answer. */
  releaseHeld(): void;
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
      rows[pixel + 1] = (y * 3 + salt * 7) & 0xff;
      rows[pixel + 2] = (x ^ y ^ salt) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Follows `[nodeId, slot]` links into Primitive* nodes. */
function literal(prompt: Record<string, any>, value: unknown, depth = 0): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") {
    const node = prompt[value[0]];
    if (depth > 8 || !node || !String(node.class_type).startsWith("Primitive")) return undefined;
    return literal(prompt, node.inputs?.value, depth + 1);
  }
  return value;
}

function latentSize(prompt: Record<string, any>): { width: number; height: number } {
  for (const node of Object.values(prompt)) {
    if (!/Latent/.test(String(node?.class_type))) continue;
    const width = Number(literal(prompt, node.inputs?.width));
    const height = Number(literal(prompt, node.inputs?.height));
    if (Number.isInteger(width) && Number.isInteger(height)) return { width, height };
  }
  return { width: 64, height: 64 };
}

function seedOf(prompt: Record<string, any>): number {
  for (const node of Object.values(prompt)) {
    const seed = literal(prompt, node?.inputs?.seed ?? node?.inputs?.noise_seed);
    if (typeof seed === "number") return seed % 251;
  }
  return 0;
}

function saveNodes(prompt: Record<string, any>): string[] {
  return Object.entries(prompt)
    .filter(([, node]) => node?.class_type === "SaveImage")
    .map(([id]) => id);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export async function startQueueFakeComfyUi(): Promise<QueueFake> {
  const requests: QueueRecordedRequest[] = [];
  const submissions: QueueFake["submissions"] = [];
  const servedImages: Buffer[] = [];
  const jobs = new Map<string, QueueJob>();
  const held = new Set<() => void>();
  let counter = 0;
  let stopped = false;

  const fake: Partial<QueueFake> & { submitMode: SubmitMode; initialState: QueueFake["initialState"] } = {
    submitMode: "answer",
    initialState: "pending",
  };

  const newJob = (prompt: Record<string, any>, clientId: string, state: QueueJobState, foreign: boolean): QueueJob => {
    counter += 1;
    const job: QueueJob = {
      promptId: `fake-${crypto.randomUUID()}`,
      clientId,
      number: counter,
      prompt,
      filename: `asset-tooling-224_${String(counter).padStart(5, "0")}_.png`,
      state,
      foreign,
    };
    jobs.set(job.promptId, job);
    return job;
  };

  const queueEntry = (job: QueueJob) => [job.number, job.promptId, job.prompt, { client_id: job.clientId }, saveNodes(job.prompt)];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: QueueRecordedRequest = { method: request.method, path: url.pathname, search: url.search };
      requests.push(record);
      if (request.method === "POST") {
        const text = await request.text();
        try {
          record.body = text ? JSON.parse(text) : undefined;
        } catch {
          record.body = text;
        }
      }

      if (request.method === "GET" && url.pathname === "/system_stats") {
        return json({
          system: {
            os: "posix",
            python_version: "3.12.3 (main) [GCC 13.2.0]",
            embedded_python: false,
            comfyui_version: "0.3.66",
            pytorch_version: "2.8.0+cpu",
            argv: ["main.py", "--cpu"],
            ram_total: 16_000_000_000,
            ram_free: 1_000_000,
          },
          devices: [{ name: "cpu", type: "cpu", index: null, vram_total: 1, vram_free: 1 }],
        });
      }

      if (request.method === "POST" && url.pathname === "/prompt") {
        const body = (record.body ?? {}) as any;
        submissions.push(body);
        const prompt = body.prompt ?? {};
        const clientId = String(body.client_id ?? "");
        const mode = fake.submitMode;
        if (mode === "answer") {
          const job = newJob(prompt, clientId, fake.initialState, false);
          return json({ prompt_id: job.promptId, number: job.number, node_errors: {} });
        }
        const job =
          mode === "hold-not-enqueued" ? undefined : newJob(prompt, clientId, mode === "hold-running" ? "running" : "pending", false);
        await new Promise<void>((resolve) => held.add(resolve));
        if (stopped || !job) return json({ error: "fake server stopped" }, 503);
        return json({ prompt_id: job.promptId, number: job.number, node_errors: {} });
      }

      if (request.method === "GET" && url.pathname === "/queue") {
        const all = [...jobs.values()];
        return json({
          queue_running: all.filter((job) => job.state === "running").map(queueEntry),
          queue_pending: all.filter((job) => job.state === "pending").map(queueEntry),
        });
      }

      if (request.method === "POST" && url.pathname === "/queue") {
        const body = (record.body ?? {}) as any;
        if (Array.isArray(body.delete)) {
          for (const id of body.delete) {
            const job = jobs.get(String(id));
            if (job && job.state === "pending") job.state = "deleted";
          }
        }
        return new Response(null, { status: 200 });
      }

      if (request.method === "POST" && url.pathname === "/interrupt") return new Response(null, { status: 200 });

      if (request.method === "GET" && url.pathname.startsWith("/history/")) {
        const promptId = decodeURIComponent(url.pathname.slice("/history/".length));
        const job = jobs.get(promptId);
        if (!job || job.state !== "done") return json({});
        if (fake.onCompletedHistory) await fake.onCompletedHistory(job);
        const saves = saveNodes(job.prompt);
        return json({
          [promptId]: {
            prompt: [job.number, promptId, job.prompt, { client_id: job.clientId }, saves],
            outputs: Object.fromEntries(saves.map((id) => [id, { images: [{ filename: job.filename, subfolder: "", type: "output" }] }])),
            status: {
              status_str: "success",
              completed: true,
              messages: [
                ["execution_start", { prompt_id: promptId, timestamp: 1 }],
                ["execution_success", { prompt_id: promptId, timestamp: 2 }],
              ],
            },
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/view") {
        const job = [...jobs.values()].find((candidate) => candidate.filename === url.searchParams.get("filename"));
        if (!job || url.searchParams.get("type") !== "output") return new Response("not found", { status: 404 });
        if (fake.onView) await fake.onView(job);
        const size = latentSize(job.prompt);
        const bytes = encodePng(size.width, size.height, seedOf(job.prompt));
        servedImages.push(bytes);
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const posts = (route: string) => requests.filter((request) => request.method === "POST" && request.path === route);

  return Object.assign(fake, {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    submissions,
    servedImages,
    jobs,
    ownJobs: () => [...jobs.values()].filter((job) => !job.foreign),
    addForeignJob(state: "pending" | "running", clientId = `someone-else-${crypto.randomUUID()}`) {
      return newJob({ "1": { class_type: "SaveImage", inputs: {} } }, clientId, state, true);
    },
    setState(promptId: string, state: QueueJobState) {
      const job = jobs.get(promptId);
      if (!job) throw new Error(`fake ComfyUI has no job ${promptId}`);
      job.state = state;
    },
    queueDeletes: () => posts("/queue").map((request) => request.body),
    interrupts: () => posts("/interrupt").length,
    promptPosts: () => posts("/prompt").length,
    views: () => requests.filter((request) => request.path === "/view").length,
    historyPolls: (promptId: string) => requests.filter((request) => request.path === `/history/${promptId}`).length,
    async waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`fake ComfyUI: timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    releaseHeld() {
      for (const resolve of held) resolve();
      held.clear();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const resolve of held) resolve();
      held.clear();
      await server.stop(true);
    },
  }) as QueueFake;
}
