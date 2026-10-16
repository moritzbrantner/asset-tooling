/**
 * LOCAL real-server acceptance for moritzbrantner/asset-tooling#223: candidate -> approve -> export
 * on a real ComfyUI, with the export verified independently.
 *
 * Skipped (reported as skipped, not passed) unless both variables are set, exactly as
 * test/comfyui-local-server.test.ts:
 *
 *   ASSET_TOOLING_COMFYUI_URL         a running local ComfyUI server, e.g. http://127.0.0.1:8188
 *   ASSET_TOOLING_COMFYUI_CHECKPOINT  path to the hash-verified SD 1.5 checkpoint inside that
 *                                     server's models/checkpoints directory
 *
 * Optional: ASSET_TOOLING_COMFYUI_CHECKPOINT_SHA256, ASSET_TOOLING_COMFYUI_CHECKPOINT_LICENSE,
 * ASSET_TOOLING_COMFYUI_SIZE (default 256), ASSET_TOOLING_COMFYUI_TIMEOUT_MS (per run, default
 * 1 800 000), ASSET_TOOLING_COMFYUI_APPROVED_SEED (which of the two candidates to approve; default
 * the first) and ASSET_TOOLING_COMFYUI_EVIDENCE_DIR (copies the verified export and writes
 * `comfyui-approval-evidence.json`).
 *
 * Run: ASSET_TOOLING_COMFYUI_URL=http://127.0.0.1:8188 \
 *      ASSET_TOOLING_COMFYUI_CHECKPOINT=.../ComfyUI/models/checkpoints/v1-5-pruned-emaonly.safetensors \
 *      bun test test/comfyui-approval-local-server.test.ts
 *
 * Two real candidates are generated with different seeds. The test then exports one of them
 * through the approved PNG bundle profile (asset.bundle@3, seams in test/comfyui-approval-export.test.ts),
 * re-hashes the exported files from disk, verifies the package with the source store deleted, and
 * shows that the other candidate is neither exported nor accepted under the first one's approval.
 * The test does not judge image quality; owner visual approval is #211 (Decision 4.1.2).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runAssetOperation, storeAssetObject } from "../src/asset-store.js";

const URL_ = process.env.ASSET_TOOLING_COMFYUI_URL;
const CHECKPOINT = process.env.ASSET_TOOLING_COMFYUI_CHECKPOINT;
const CHECKPOINT_SHA256 = process.env.ASSET_TOOLING_COMFYUI_CHECKPOINT_SHA256;
const LICENSE = process.env.ASSET_TOOLING_COMFYUI_CHECKPOINT_LICENSE ?? "creativeml-openrail-m";
const SIZE = Number(process.env.ASSET_TOOLING_COMFYUI_SIZE ?? "256");
const TIMEOUT_MS = Number(process.env.ASSET_TOOLING_COMFYUI_TIMEOUT_MS ?? "1800000");
const EVIDENCE_DIR = process.env.ASSET_TOOLING_COMFYUI_EVIDENCE_DIR;
const SEEDS = [2231, 2232] as const;
const APPROVED_SEED = Number(process.env.ASSET_TOOLING_COMFYUI_APPROVED_SEED ?? String(SEEDS[0]));
const SKIP =
  (!URL_ || !CHECKPOINT) &&
  "local ComfyUI approval acceptance needs ASSET_TOOLING_COMFYUI_URL (running local server) and ASSET_TOOLING_COMFYUI_CHECKPOINT (hash-verified SD 1.5 checkpoint)";

const WORKFLOW_PATH = fileURLToPath(new URL("./fixtures/comfyui/sd15-txt2img.api.json", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROFILE = "approved-png-v1";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function hashFile(file: string): Promise<{ sha256: string; byteLength: number }> {
  const digest = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(file)) {
    byteLength += (chunk as Buffer).byteLength;
    digest.update(chunk as Buffer);
  }
  return { sha256: digest.digest("hex"), byteLength };
}

async function tree(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) Object.assign(result, await tree(path.join(directory, child.name), relative));
    else result[relative] = sha256(await readFile(path.join(directory, child.name)));
  }
  return result;
}

test("real ComfyUI: two candidates, one approved by exact sha, exported and independently verified", { skip: SKIP, timeout: 2 * TIMEOUT_MS + 120_000 }, async (t) => {
  assert.ok((SEEDS as readonly number[]).includes(APPROVED_SEED), `ASSET_TOOLING_COMFYUI_APPROVED_SEED must be one of ${SEEDS.join(", ")}`);
  assert.ok(Number.isInteger(SIZE) && SIZE > 0 && SIZE % 8 === 0, "ASSET_TOOLING_COMFYUI_SIZE must be a positive multiple of 8");
  const comfy = (await import("../src/comfyui-operation.js")) as Record<string, any>;
  const bundle = (await import("../src/asset-bundle.js")) as Record<string, any>;
  assert.equal(bundle.APPROVED_IMAGE_BUNDLE_PROFILE, PROFILE, "src/asset-bundle.ts must export APPROVED_IMAGE_BUNDLE_PROFILE (#223)");

  const checkpointFile = path.resolve(CHECKPOINT!);
  assert.ok((await stat(checkpointFile)).isFile(), "the checkpoint must be a file");
  const measured = await hashFile(checkpointFile);
  if (CHECKPOINT_SHA256) assert.equal(measured.sha256, CHECKPOINT_SHA256, "the checkpoint must match its acquisition hash");
  else t.diagnostic(`checkpoint sha256 measured, not pinned: ${measured.sha256}`);
  const checkpoint = { name: path.basename(checkpointFile), ...measured, license: LICENSE };

  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-approval-local-"));
  try {
    const workflow = (
      await storeAssetObject(root, { bytes: await readFile(WORKFLOW_PATH), kind: "workflow", mediaType: "application/json", metadata: { format: "comfyui-api-prompt" } })
    ).asset;
    const server = await comfy.probeComfyUiServer({ endpoint: URL_ });
    const registration = comfy.createComfyUiImageGenerateRegistration({
      endpoint: URL_,
      server,
      checkpointDirectory: path.dirname(checkpointFile),
      timeoutMs: TIMEOUT_MS,
      pollIntervalMs: 1_000,
    });
    const candidates: { seed: number; image: any; receipt: any }[] = [];
    for (const seed of SEEDS) {
      const run = await runAssetOperation(root, registration, {
        parameters: {
          provider: "comfyui",
          checkpoint,
          injections: {
            checkpoint: { node: "4", input: "ckpt_name" },
            seed: { node: "3", input: "seed", value: seed },
            positivePrompt: { node: "6", input: "text", value: "a painted fantasy game ability icon of a sword strike, centered, simple background" },
            negativePrompt: { node: "7", input: "text", value: "text, watermark, blurry" },
            width: { node: "5", input: "width", value: SIZE },
            height: { node: "5", input: "height", value: SIZE },
          },
          output: { node: "9" },
        },
        inputs: { workflow },
      });
      candidates.push({ seed, image: run.result.outputs.image, receipt: run.result.observations });
    }
    const [first, second] = candidates as [(typeof candidates)[0], (typeof candidates)[0]];
    assert.notEqual(first.image.sha256, second.image.sha256, "two seeds should give two different candidates");
    const approved = candidates.find((c) => c.seed === APPROVED_SEED)!;
    const other = candidates.find((c) => c !== approved)!;

    const out = path.join(root, "export");
    const select = (image: any, approvedSha: string) => ({
      parameters: { profile: PROFILE, assets: [{ key: "warden.ability.1", variant: "master", approved: { sha256: approvedSha } }] },
      inputs: { assets: [image] },
    });
    // The other candidate is not accepted under this approval.
    await assert.rejects(bundle.exportAssetBundle(root, out, select(other.image, approved.image.sha256)), /approved/i);
    const result = await bundle.exportAssetBundle(root, out, select(approved.image, approved.image.sha256));

    const files = await tree(out);
    assert.deepEqual(Object.keys(files).sort(), [`assets/${approved.image.sha256}.png`, "manifest.json"]);
    assert.equal(files[`assets/${approved.image.sha256}.png`], approved.image.sha256, "exported bytes re-hash to the approved sha");
    assert.ok(!Object.values(files).includes(other.image.sha256), "the unselected candidate is not exported");
    const payload = await readFile(path.join(out, "assets", `${approved.image.sha256}.png`));
    assert.deepEqual(payload.subarray(0, 8), PNG_SIGNATURE);
    assert.deepEqual([payload.readUInt32BE(16), payload.readUInt32BE(20)], [SIZE, SIZE]);

    await rm(path.join(root, ".asset-tooling"), { recursive: true, force: true });
    const verified = await bundle.verifyAssetBundle(out, result.manifest, { profile: PROFILE });
    assert.equal(verified.assetsVerified, 1);

    t.diagnostic(`approved seed ${approved.seed}: ${approved.image.sha256}; unselected seed ${other.seed}: ${other.image.sha256}`);
    if (EVIDENCE_DIR) {
      await mkdir(EVIDENCE_DIR, { recursive: true });
      await cp(out, path.join(EVIDENCE_DIR, "approved-export"), { recursive: true });
      await writeFile(
        path.join(EVIDENCE_DIR, "comfyui-approval-evidence.json"),
        `${JSON.stringify({ issue: "moritzbrantner/asset-tooling#223", server, candidates, approvedSeed: approved.seed, manifest: result.manifest, files }, null, 2)}\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
