/**
 * In-process fake of the ComfyUI local server HTTP API for the #212 acceptance tests.
 *
 * It implements only the documented routes the operation needs, with ComfyUI's response shapes:
 *   GET  /system_stats             -> { system: { comfyui_version, python_version, pytorch_version,
 *                                       ram_total, ram_free, ... }, devices: [...] }
 *   POST /prompt  {prompt, client_id} -> 200 { prompt_id, number, node_errors: {} }
 *                                       400 { error: {...}, node_errors: { <id>: {...} } }
 *   GET  /history/<prompt_id>      -> {} while pending, { <prompt_id>: { prompt, outputs, status } }
 *   GET  /view?filename&subfolder&type -> image bytes
 *   POST /queue, POST /interrupt   -> recorded (the tests assert how they are used)
 *
 * No ComfyUI, torch or model is involved. Images are small, valid, generated PNGs whose size is
 * read from the submitted EmptyLatentImage node and whose pixels depend on the submitted seed.
 */
import { deflateSync } from "node:zlib";

export type FakeComfyUiBehaviour =
  | "success"
  | "node-errors" // /prompt rejects the graph with node_errors (400)
  | "execution-error" // accepted, history reports status_str "error" with an execution_error message
  | "never-completes" // accepted, history stays {} forever
  | "submit-hangs" // records the /prompt body, never answers it
  | "non-png" // /view returns bytes that are not a PNG
  | "wrong-size" // /view returns a valid PNG whose IHDR size differs from the submitted latent size
  | "unstable-view" // /view returns a different valid PNG on every request
  | "unknown-prompt-id" // history answers with a completed record keyed by a different prompt id
  | "malformed-history"; // history is "success" but has no images for any output node

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body?: unknown;
}

export interface FakeComfyUi {
  readonly endpoint: string;
  readonly requests: RecordedRequest[];
  /** Parsed JSON bodies of every POST /prompt, in order. */
  readonly submissions: { prompt: Record<string, any>; client_id?: unknown; [key: string]: unknown }[];
  /** Every byte payload served by /view, in order. */
  readonly servedImages: Buffer[];
  /** Every prompt id handed out by /prompt, in order. */
  readonly promptIds: string[];
  behaviour: FakeComfyUiBehaviour;
  comfyuiVersion: string;
  ramFree: number;
  stop(): Promise<void>;
}

export interface FakeComfyUiOptions {
  behaviour?: FakeComfyUiBehaviour;
  comfyuiVersion?: string;
  pytorchVersion?: string;
  /** Checkpoint names the fake "has"; a CheckpointLoaderSimple naming another fails validation. */
  checkpoints?: string[];
  /** Number of pending ({}) history answers before a completed one. */
  pendingPolls?: number;
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

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A valid 8-bit RGB PNG whose pixels depend on `salt`. */
export function encodeTestPng(width: number, height: number, salt: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      rows[pixel] = (x + salt) & 0xff;
      rows[pixel + 1] = (y * 3 + salt * 7) & 0xff;
      rows[pixel + 2] = (x ^ y ^ salt) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function readPngSize(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function latentSize(prompt: Record<string, any>): { width: number; height: number } {
  for (const node of Object.values(prompt)) {
    if (node?.class_type === "EmptyLatentImage") {
      return { width: Number(node.inputs.width), height: Number(node.inputs.height) };
    }
  }
  return { width: 64, height: 64 };
}

function seedOf(prompt: Record<string, any>): number {
  for (const node of Object.values(prompt)) {
    if (node?.class_type === "KSampler") return Number(node.inputs.seed) % 251;
  }
  return 0;
}

function saveNodes(prompt: Record<string, any>): string[] {
  return Object.entries(prompt)
    .filter(([, node]) => node?.class_type === "SaveImage")
    .map(([id]) => id);
}

export async function startFakeComfyUi(options: FakeComfyUiOptions = {}): Promise<FakeComfyUi> {
  const checkpoints = options.checkpoints ?? [];
  const pendingPolls = options.pendingPolls ?? 1;
  const requests: RecordedRequest[] = [];
  const submissions: FakeComfyUi["submissions"] = [];
  const servedImages: Buffer[] = [];
  const promptIds: string[] = [];
  const jobs = new Map<string, { prompt: Record<string, any>; polls: number; filename: string }>();
  const hanging = new Set<() => void>();
  let viewCount = 0;
  let stopped = false;

  const state = {
    behaviour: options.behaviour ?? ("success" as FakeComfyUiBehaviour),
    comfyuiVersion: options.comfyuiVersion ?? "0.3.66",
    ramFree: 1_000_000,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: RecordedRequest = { method: request.method, path: url.pathname, search: url.search };
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
            comfyui_version: state.comfyuiVersion,
            pytorch_version: options.pytorchVersion ?? "2.8.0+cpu",
            argv: ["main.py", "--cpu", "--listen", "127.0.0.1"],
            ram_total: 16_000_000_000,
            ram_free: state.ramFree,
          },
          devices: [{ name: "cpu", type: "cpu", index: null, vram_total: 16_000_000_000, vram_free: state.ramFree }],
        });
      }

      if (request.method === "POST" && url.pathname === "/prompt") {
        const body = record.body as any;
        submissions.push(body);
        if (state.behaviour === "submit-hangs") {
          // The body was received (the job may be "accepted"), but the response is lost.
          await new Promise<void>((resolve) => hanging.add(resolve));
          return json({ error: "fake server stopped" }, 503);
        }
        const prompt = body?.prompt ?? {};
        const missingCheckpoint = Object.entries(prompt).find(
          ([, node]: [string, any]) =>
            node?.class_type === "CheckpointLoaderSimple" && !checkpoints.includes(node.inputs?.ckpt_name),
        );
        if (state.behaviour === "node-errors" || missingCheckpoint) {
          const [id, node] = (missingCheckpoint ?? ["4", prompt["4"]]) as [string, any];
          return json(
            {
              error: {
                type: "prompt_outputs_failed_validation",
                message: "Prompt outputs failed validation",
                details: "",
                extra_info: {},
              },
              node_errors: {
                [id]: {
                  errors: [
                    {
                      type: "value_not_in_list",
                      message: "Value not in list",
                      details: `ckpt_name: '${node?.inputs?.ckpt_name}' not in ${JSON.stringify(checkpoints)}`,
                      extra_info: {},
                    },
                  ],
                  dependent_outputs: saveNodes(prompt),
                  class_type: node?.class_type ?? "CheckpointLoaderSimple",
                },
              },
            },
            400,
          );
        }
        const promptId = `fake-${crypto.randomUUID()}`;
        promptIds.push(promptId);
        jobs.set(promptId, { prompt, polls: 0, filename: `asset-tooling-212_${String(promptIds.length).padStart(5, "0")}_.png` });
        return json({ prompt_id: promptId, number: promptIds.length - 1, node_errors: {} });
      }

      if (request.method === "GET" && url.pathname.startsWith("/history/")) {
        const promptId = decodeURIComponent(url.pathname.slice("/history/".length));
        const job = jobs.get(promptId);
        if (!job) return json({});
        job.polls += 1;
        if (state.behaviour === "never-completes" || job.polls <= pendingPolls) return json({});
        const outputs = Object.fromEntries(
          saveNodes(job.prompt).map((id) => [id, { images: [{ filename: job.filename, subfolder: "", type: "output" }] }]),
        );
        if (state.behaviour === "execution-error") {
          return json({
            [promptId]: {
              prompt: [0, promptId, job.prompt, {}, saveNodes(job.prompt)],
              outputs: {},
              status: {
                status_str: "error",
                completed: false,
                messages: [
                  ["execution_start", { prompt_id: promptId, timestamp: 1 }],
                  [
                    "execution_error",
                    {
                      prompt_id: promptId,
                      node_id: "3",
                      node_type: "KSampler",
                      exception_message: "fake sampler exploded",
                      exception_type: "RuntimeError",
                      traceback: [],
                    },
                  ],
                ],
              },
            },
          });
        }
        const key = state.behaviour === "unknown-prompt-id" ? `other-${promptId}` : promptId;
        return json({
          [key]: {
            prompt: [0, promptId, job.prompt, {}, saveNodes(job.prompt)],
            outputs: state.behaviour === "malformed-history" ? {} : outputs,
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
        viewCount += 1;
        const filename = url.searchParams.get("filename");
        const job = [...jobs.values()].find((candidate) => candidate.filename === filename);
        if (!job || url.searchParams.get("type") !== "output") return new Response("not found", { status: 404 });
        const size = latentSize(job.prompt);
        let bytes: Buffer;
        if (state.behaviour === "non-png") bytes = Buffer.from("<html>definitely not a png</html>", "utf8");
        else if (state.behaviour === "wrong-size") bytes = encodeTestPng(size.width + 8, size.height, seedOf(job.prompt));
        else if (state.behaviour === "unstable-view") bytes = encodeTestPng(size.width, size.height, seedOf(job.prompt) + viewCount);
        else bytes = encodeTestPng(size.width, size.height, seedOf(job.prompt));
        servedImages.push(bytes);
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }

      if (request.method === "POST" && (url.pathname === "/queue" || url.pathname === "/interrupt")) {
        return json({});
      }
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
    get ramFree() {
      return state.ramFree;
    },
    set ramFree(value) {
      state.ramFree = value;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const resolve of hanging) resolve();
      hanging.clear();
      await server.stop(true);
    },
  };
}
