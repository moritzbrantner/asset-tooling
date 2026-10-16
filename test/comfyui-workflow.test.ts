import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { assetObjectPortablePath, storeAssetObject } from "../src/asset-store.js";
import { loadPreparedComfyUiApiWorkflow } from "../src/comfyui-workflow.js";
import { sha256Bytes } from "../src/hash.js";

const API_PROMPT = `{
  "1": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": { "ckpt_name": "pinned-model.safetensors" },
    "_meta": { "title": "Load prepared checkpoint" }
  },
  "2": {
    "class_type": "SaveImage",
    "inputs": { "images": ["1", 0], "filename_prefix": "asset-test" }
  }
}
`;

async function workspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-workflow-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function savePrompt(root: string, prompt: string | Uint8Array) {
  const bytes = typeof prompt === "string" ? Buffer.from(prompt, "utf8") : prompt;
  return storeAssetObject(root, {
    bytes,
    kind: "workflow",
    mediaType: "application/json",
    metadata: { format: "comfyui-api-prompt" },
  });
}

test("preflight preserves byte-pinned API-format JSON without normalizing native nodes", async () => {
  await workspace(async (root) => {
    const saved = await savePrompt(root, API_PROMPT);
    const prepared = await loadPreparedComfyUiApiWorkflow(root, saved.asset);

    assert.equal(prepared.asset.sha256, sha256Bytes(Buffer.from(API_PROMPT, "utf8")));
    assert.deepEqual(prepared.asset, saved.asset);
    assert.equal(prepared.promptJson, API_PROMPT);
    assert.equal(prepared.nodeCount, 2);
    assert.deepEqual(JSON.parse(prepared.promptJson)["2"].inputs.images, ["1", 0]);

    const reformatted = await savePrompt(root, JSON.stringify(JSON.parse(API_PROMPT)));
    const next = await loadPreparedComfyUiApiWorkflow(root, reformatted.asset);
    assert.notEqual(next.asset.sha256, prepared.asset.sha256);
    assert.deepEqual(JSON.parse(next.promptJson), JSON.parse(prepared.promptJson));

    // Reading a prepared workflow is idempotent, with no rewrite of stored bytes.
    const repeat = await loadPreparedComfyUiApiWorkflow(root, saved.asset);
    assert.deepEqual(repeat, prepared);
    const location = path.join(root, ...assetObjectPortablePath(saved.asset).split("/"));
    assert.deepEqual(await readFile(location), Buffer.from(API_PROMPT, "utf8"));
  });
});

test("preflight rejects UI-format graphs, invalid nodes and non-finite parsed numbers", async () => {
  await workspace(async (root) => {
    const invalid = [
      "{}",
      "[]",
      '{"nodes":[],"links":[]}',
      '{"1":{"class_type":"Test"}}',
      '{"1":{"inputs":{}}}',
      '{"1":{"class_type":"   ","inputs":{}}}',
      '{"1":{"class_type":"Test","inputs":[]}}',
      '{"1":{"class_type":"Test","inputs":{"steps":1e999}}}',
      "not json",
    ];
    for (const payload of invalid) {
      const saved = await savePrompt(root, payload);
      await assert.rejects(
        loadPreparedComfyUiApiWorkflow(root, saved.asset),
        /ComfyUI API workflow|non-finite number/,
        `incorrectly accepted: ${payload}`,
      );
    }
    const invalidUtf8 = await savePrompt(root, Uint8Array.from([0xc3, 0x28]));
    await assert.rejects(
      loadPreparedComfyUiApiWorkflow(root, invalidUtf8.asset),
      /valid UTF-8 JSON/,
    );
  });
});

test("preflight requires verified workflow bytes and never accepts a mislabeled asset", async () => {
  await workspace(async (root) => {
    const saved = await savePrompt(root, API_PROMPT);

    await assert.rejects(
      loadPreparedComfyUiApiWorkflow(root, { ...saved.asset, kind: "image" }),
      /workflow AssetRef/,
    );
    await assert.rejects(
      loadPreparedComfyUiApiWorkflow(root, { ...saved.asset, mediaType: "text/plain" }),
      /application\/json/,
    );
    await assert.rejects(
      loadPreparedComfyUiApiWorkflow(root, { ...saved.asset, sha256: "0".repeat(64) }),
      /missing/,
    );

    const location = path.join(root, ...assetObjectPortablePath(saved.asset).split("/"));
    await writeFile(location, Buffer.from(API_PROMPT.replace("SaveImage", "SaveImagf"), "utf8"));
    await assert.rejects(
      loadPreparedComfyUiApiWorkflow(root, saved.asset),
      /hash mismatch/,
    );
  });
});
