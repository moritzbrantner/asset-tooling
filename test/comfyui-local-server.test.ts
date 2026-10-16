/**
 * LOCAL real-server acceptance for moritzbrantner/asset-tooling#212 (ComfyUI execution slice).
 *
 * Skipped (reported as skipped, not passed) unless both variables are set:
 *
 *   ASSET_TOOLING_COMFYUI_URL         a running local ComfyUI server, for example
 *                                     http://127.0.0.1:8188, started from the managed install
 *                                     (`bun run tools:setup --profile comfyui --gpu cpu`, then
 *                                     `main.py --cpu --listen 127.0.0.1`)
 *   ASSET_TOOLING_COMFYUI_CHECKPOINT  path to the hash-verified Stable Diffusion 1.5 checkpoint
 *                                     inside that server's models/checkpoints directory; ComfyUI
 *                                     sees it under its file name
 *
 * Optional:
 *   ASSET_TOOLING_COMFYUI_CHECKPOINT_SHA256  the acquisition record's SHA-256; when set, the file
 *                                            must hash to it (otherwise the hash is measured and
 *                                            reported, not asserted against a pin)
 *   ASSET_TOOLING_COMFYUI_CHECKPOINT_LICENSE licence id (default "creativeml-openrail-m")
 *   ASSET_TOOLING_COMFYUI_SIZE               square output size (default 256, multiple of 8)
 *   ASSET_TOOLING_COMFYUI_TIMEOUT_MS         run budget (default 1 800 000; SD 1.5 on CPU is slow)
 *   ASSET_TOOLING_COMFYUI_EVIDENCE_DIR       writes `comfyui-output.png` and
 *                                            `comfyui-evidence.json` (probe, receipt, hashes)
 *
 * The ComfyUI commit is taken from the managed setup receipt
 * (.artifacts/toolchain/comfyui-install.json) when present and checked against the
 * scripts/toolchain.json pin; without a receipt, no commit is claimed.
 *
 * Run: ASSET_TOOLING_COMFYUI_URL=http://127.0.0.1:8188 \
 *      ASSET_TOOLING_COMFYUI_CHECKPOINT=.../ComfyUI/models/checkpoints/v1-5-pruned-emaonly.safetensors \
 *      bun test test/comfyui-local-server.test.ts
 *
 * Seams: probeComfyUiServer and createComfyUiImageGenerateRegistration from
 * src/comfyui-operation.ts with runAssetOperation; see test/comfyui-operation.test.ts.
 *
 * What it proves on a real server: one small, few-step txt2img through the prepared SD 1.5
 * API-format workflow (test/fixtures/comfyui/sd15-txt2img.api.json) yields a real PNG of the
 * requested size, stored as a verified AssetRef, with a receipt naming the workflow, server
 * version, checkpoint, prompt id and output hash; an identical invocation is then a cache hit
 * that does not contact the server. It does not judge image quality (#211).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveAssetObject, runAssetOperation, storeAssetObject } from "../src/asset-store.js";

const URL_ = process.env.ASSET_TOOLING_COMFYUI_URL;
const CHECKPOINT = process.env.ASSET_TOOLING_COMFYUI_CHECKPOINT;
const CHECKPOINT_SHA256 = process.env.ASSET_TOOLING_COMFYUI_CHECKPOINT_SHA256;
const LICENSE = process.env.ASSET_TOOLING_COMFYUI_CHECKPOINT_LICENSE ?? "creativeml-openrail-m";
const SIZE = Number(process.env.ASSET_TOOLING_COMFYUI_SIZE ?? "256");
const TIMEOUT_MS = Number(process.env.ASSET_TOOLING_COMFYUI_TIMEOUT_MS ?? "1800000");
const EVIDENCE_DIR = process.env.ASSET_TOOLING_COMFYUI_EVIDENCE_DIR;
const SKIP =
  (!URL_ || !CHECKPOINT) &&
  "local ComfyUI acceptance needs ASSET_TOOLING_COMFYUI_URL (running local server) and ASSET_TOOLING_COMFYUI_CHECKPOINT (hash-verified SD 1.5 checkpoint)";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = fileURLToPath(new URL("./fixtures/comfyui/sd15-txt2img.api.json", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function hashFile(file: string): Promise<{ sha256: string; byteLength: number }> {
  const digest = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(file)) {
    byteLength += (chunk as Buffer).byteLength;
    digest.update(chunk as Buffer);
  }
  return { sha256: digest.digest("hex"), byteLength };
}

async function managedComfyUiCommit(): Promise<string | undefined> {
  try {
    const receipt = JSON.parse(await readFile(path.join(REPO, ".artifacts/toolchain/comfyui-install.json"), "utf8"));
    const pins = JSON.parse(await readFile(path.join(REPO, "scripts/toolchain.json"), "utf8"));
    assert.equal(receipt.commit, pins.comfyui.commit, "the setup receipt must match the repository ComfyUI pin");
    return receipt.commit;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

test("real ComfyUI: one SD 1.5 txt2img through image.comfyui.generate@1 with a verified PNG and receipt", { skip: SKIP, timeout: TIMEOUT_MS + 120_000 }, async (t) => {
  const module = (await import("../src/comfyui-operation.js")) as Record<string, any>;
  assert.equal(typeof module.probeComfyUiServer, "function", "src/comfyui-operation.ts must export probeComfyUiServer (#212)");
  assert.equal(typeof module.createComfyUiImageGenerateRegistration, "function", "export createComfyUiImageGenerateRegistration (#212)");
  assert.ok(Number.isInteger(SIZE) && SIZE > 0 && SIZE % 8 === 0, "ASSET_TOOLING_COMFYUI_SIZE must be a positive multiple of 8");

  const checkpointFile = path.resolve(CHECKPOINT!);
  assert.ok((await stat(checkpointFile)).isFile(), "the checkpoint must be a file");
  const measured = await hashFile(checkpointFile);
  if (CHECKPOINT_SHA256) assert.equal(measured.sha256, CHECKPOINT_SHA256, "the checkpoint must match its acquisition hash");
  else t.diagnostic(`checkpoint sha256 measured, not pinned: ${measured.sha256}`);
  const checkpoint = { name: path.basename(checkpointFile), ...measured, license: LICENSE };

  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-local-"));
  try {
    const workflow = (
      await storeAssetObject(root, {
        bytes: await readFile(WORKFLOW_PATH),
        kind: "workflow",
        mediaType: "application/json",
        metadata: { format: "comfyui-api-prompt" },
      })
    ).asset;
    const server = await module.probeComfyUiServer({ endpoint: URL_ });
    assert.equal(typeof server.comfyuiVersion, "string");
    const comfyuiCommit = await managedComfyUiCommit();
    if (!comfyuiCommit) t.diagnostic("no managed ComfyUI setup receipt: commit not claimed");
    const registration = module.createComfyUiImageGenerateRegistration({
      endpoint: URL_,
      server,
      ...(comfyuiCommit ? { comfyuiCommit } : {}),
      checkpointDirectory: path.dirname(checkpointFile),
      timeoutMs: TIMEOUT_MS,
      pollIntervalMs: 1_000,
    });
    const parameters = {
      provider: "comfyui",
      checkpoint,
      injections: {
        checkpoint: { node: "4", input: "ckpt_name" },
        seed: { node: "3", input: "seed", value: 212 },
        positivePrompt: { node: "6", input: "text", value: "a painted fantasy game icon of a steel shield, centered, simple background" },
        negativePrompt: { node: "7", input: "text", value: "text, watermark, blurry" },
        width: { node: "5", input: "width", value: SIZE },
        height: { node: "5", input: "height", value: SIZE },
      },
      output: { node: "9" },
    };
    const invocation = { parameters, inputs: { workflow } };

    const started = Date.now();
    const run = await runAssetOperation(root, registration, invocation);
    const seconds = (Date.now() - started) / 1000;
    assert.equal(run.status, "miss");
    const image = run.result.outputs.image as any;
    const bytes = await resolveAssetObject(root, image);
    assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, "a real PNG");
    assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [SIZE, SIZE]);
    assert.ok(bytes.byteLength > 1_000, "a generated image, not a stub");

    const receipt = run.result.observations as any;
    assert.equal(receipt.provider, "comfyui");
    assert.equal(receipt.reproducibility, "approximate");
    assert.equal(typeof receipt.promptId, "string");
    assert.equal(typeof receipt.clientId, "string");
    assert.equal(receipt.workflow.sha256, workflow.sha256);
    assert.match(receipt.submittedPrompt.sha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.comfyui.version, server.comfyuiVersion);
    if (comfyuiCommit) assert.equal(receipt.comfyui.commit, comfyuiCommit);
    assert.deepEqual(receipt.checkpoint, checkpoint);
    assert.equal(receipt.output.node, "9");
    assert.equal(receipt.output.sha256, image.sha256);

    // Reuse: an identical invocation is a verified cache hit without touching the server.
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign((input: any, init?: any) => {
      calls += 1;
      return original(input, init);
    }, original) as typeof fetch;
    try {
      const again = await runAssetOperation(root, registration, invocation);
      assert.equal(again.status, "hit");
      assert.equal(again.result.outputs.image.sha256, image.sha256);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0, "a cache hit must not contact ComfyUI");

    t.diagnostic(`ComfyUI ${server.comfyuiVersion} prompt ${receipt.promptId}: ${SIZE}x${SIZE} PNG ${image.sha256} in ${seconds.toFixed(1)} s`);
    if (EVIDENCE_DIR) {
      await mkdir(EVIDENCE_DIR, { recursive: true });
      await writeFile(path.join(EVIDENCE_DIR, "comfyui-output.png"), bytes);
      await writeFile(
        path.join(EVIDENCE_DIR, "comfyui-evidence.json"),
        `${JSON.stringify(
          {
            issue: "moritzbrantner/asset-tooling#212",
            operation: run.buildIdentity.operation,
            cacheKey: run.cacheKey,
            implementation: run.buildIdentity.implementation,
            parameters: run.buildIdentity.parameters,
            workflowSha256: workflow.sha256,
            checkpointPinned: Boolean(CHECKPOINT_SHA256),
            server,
            receipt,
            output: image,
            seconds,
          },
          null,
          2,
        )}\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
