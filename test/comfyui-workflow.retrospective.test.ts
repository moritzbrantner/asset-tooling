// Retrospective acceptance (#215).
//
// These tests were derived independently, after the fact, from the PR #215 body and
// docs/prd-comfyui-provider.md ("First small offline PR slice") against the pre-implementation
// baseline f0463d90ec931f896f7a339981e8663bfa44eede, without reading src/comfyui-workflow.ts.
// They are NOT pre-implementation authorship: the implementation (a76b1d3) was committed before
// its original tests (6e61942). They add cases the original test file does not cover.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { assetObjectPortablePath, storeAssetObject } from "../src/asset-store.js";
import { loadPreparedComfyUiApiWorkflow } from "../src/comfyui-workflow.js";
import { sha256Bytes } from "../src/hash.js";

// Native API-format prompt with features a canonicalizing reader would rewrite: CRLF line
// endings, tab indentation, non-ASCII text, escaped unicode, a seed above 2^53, `1.0`/`1e2`
// number spellings, non-sorted keys and an opaque non-numeric node id.
const NATIVE_PROMPT =
  '{\r\n\t"9": {"inputs": {"seed": 18446744073709551615, "cfg": 7.0, "steps": 2e1, ' +
  '"text": "Schild \\u00fc ⚔ \\"quoted\\""}, "class_type": "KSampler"},\r\n' +
  '\t"save-node": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "ä"}}\r\n}';

const MINIMAL_PROMPT = '{"1":{"class_type":"SaveImage","inputs":{}}}';

async function workspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-retro-"));
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

function objectLocation(root: string, asset: unknown): string {
  return path.join(root, ...assetObjectPortablePath(asset).split("/"));
}

async function listTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

test("retrospective acceptance (#215): native graph text and exact bytes are returned unmodified", async () => {
  await workspace(async (root) => {
    const bytes = Buffer.from(NATIVE_PROMPT, "utf8");
    const saved = await savePrompt(root, bytes);
    const prepared = await loadPreparedComfyUiApiWorkflow(root, saved.asset);

    // Exact-byte identity: the returned AssetRef names exactly the stored bytes.
    assert.deepEqual(prepared.asset, saved.asset);
    assert.equal(prepared.asset.sha256, sha256Bytes(bytes));
    assert.equal(prepared.asset.byteLength, bytes.byteLength);
    assert.equal(prepared.asset.kind, "workflow");
    assert.equal(prepared.asset.mediaType, "application/json");

    // No rewrite: same text, re-encodes to the same bytes, big seed digits survive verbatim.
    assert.equal(prepared.promptJson, NATIVE_PROMPT);
    assert.deepEqual(Buffer.from(prepared.promptJson, "utf8"), bytes);
    assert.match(prepared.promptJson, /"seed": 18446744073709551615,/);
    assert.match(prepared.promptJson, /"cfg": 7\.0,/);
    assert.equal(prepared.nodeCount, 2);
    assert.deepEqual(await readFile(objectLocation(root, saved.asset)), bytes);
  });
});

test("retrospective acceptance (#215): caller AssetRef is not mutated and metadata is kept", async () => {
  await workspace(async (root) => {
    const saved = await savePrompt(root, MINIMAL_PROMPT);
    const input = structuredClone(saved.asset);
    const frozen = Object.freeze(structuredClone(saved.asset));
    const prepared = await loadPreparedComfyUiApiWorkflow(root, input);
    assert.deepEqual(input, saved.asset);
    assert.deepEqual(prepared.asset.metadata, { format: "comfyui-api-prompt" });
    // A frozen ref must also be accepted (reading cannot require mutating the caller's value).
    const again = await loadPreparedComfyUiApiWorkflow(root, frozen);
    assert.deepEqual(again, prepared);
  });
});

test("retrospective acceptance (#215): non-object JSON, empty and trailing-garbage payloads are rejected", async () => {
  await workspace(async (root) => {
    const invalid = [
      "",
      "   \n",
      "null",
      "true",
      "42",
      '"{\\"1\\":{}}"',
      `${MINIMAL_PROMPT} x`,
      `${MINIMAL_PROMPT}${MINIMAL_PROMPT}`,
      "{'1':{'class_type':'SaveImage','inputs':{}}}",
      '{"1":{"class_type":"SaveImage","inputs":{},}}',
    ];
    for (const payload of invalid) {
      const saved = await savePrompt(root, payload);
      await assert.rejects(
        loadPreparedComfyUiApiWorkflow(root, saved.asset),
        Error,
        `incorrectly accepted: ${JSON.stringify(payload)}`,
      );
    }
  });
});

test("retrospective acceptance (#215): malformed node envelopes and UI exports are rejected", async () => {
  await workspace(async (root) => {
    const invalid = [
      '{"1":null}',
      '{"1":[]}',
      '{"1":"SaveImage"}',
      '{"1":7}',
      '{"1":{"class_type":7,"inputs":{}}}',
      '{"1":{"class_type":null,"inputs":{}}}',
      '{"1":{"class_type":"","inputs":{}}}',
      '{"1":{"class_type":"SaveImage","inputs":null}}',
      '{"1":{"class_type":"SaveImage","inputs":"x"}}',
      // A valid node next to an invalid one must still fail: the whole envelope is checked.
      `{"1":{"class_type":"SaveImage","inputs":{}},"2":{"class_type":"KSampler"}}`,
      // Realistic ComfyUI UI ("workflow") export shape rather than an API prompt.
      JSON.stringify({
        last_node_id: 2,
        last_link_id: 1,
        nodes: [{ id: 1, type: "CheckpointLoaderSimple", inputs: [], outputs: [], widgets_values: ["m.safetensors"] }],
        links: [[1, 1, 0, 2, 0, "MODEL"]],
        groups: [],
        config: {},
        extra: {},
        version: 0.4,
      }),
      // API prompt wrapped in a POST /prompt request body is not the prepared prompt graph itself.
      JSON.stringify({ prompt: JSON.parse(MINIMAL_PROMPT), client_id: "x" }),
      // Non-finite numbers anywhere in the graph, including nested arrays/objects.
      '{"1":{"class_type":"T","inputs":{"v":[1,-1e999]}}}',
      '{"1":{"class_type":"T","inputs":{"deep":{"x":{"y":1e400}}}}}',
    ];
    for (const payload of invalid) {
      const saved = await savePrompt(root, payload);
      await assert.rejects(
        loadPreparedComfyUiApiWorkflow(root, saved.asset),
        Error,
        `incorrectly accepted: ${payload}`,
      );
    }
  });
});

test("retrospective acceptance (#215): invalid UTF-8 variants are rejected, a BOM is never silently dropped", async () => {
  await workspace(async (root) => {
    const ascii = (text: string) => [...Buffer.from(text, "utf8")];
    const invalid = [
      // Overlong encoding of "/" inside a string value.
      Uint8Array.from([...ascii('{"1":{"class_type":"'), 0xc0, 0xaf, ...ascii('","inputs":{}}}')]),
      // UTF-8 encoded surrogate (CESU-8 style).
      Uint8Array.from([...ascii('{"1":{"class_type":"'), 0xed, 0xa0, 0x80, ...ascii('","inputs":{}}}')]),
      // Truncated multi-byte sequence.
      Uint8Array.from([...ascii('{"1":{"class_type":"'), 0xe2, 0x82, ...ascii('","inputs":{}}}')]),
      // Latin-1 encoded "ä" (would be replaced by U+FFFD by a lenient decoder).
      Uint8Array.from([...ascii('{"1":{"class_type":"'), 0xe4, ...ascii('","inputs":{}}}')]),
    ];
    for (const bytes of invalid) {
      const saved = await savePrompt(root, bytes);
      await assert.rejects(
        loadPreparedComfyUiApiWorkflow(root, saved.asset),
        Error,
        `incorrectly accepted bytes ${Buffer.from(bytes).toString("hex")}`,
      );
    }

    // A UTF-8 BOM may be rejected, but if accepted it must not be stripped from the returned text.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MINIMAL_PROMPT, "utf8")]);
    const saved = await savePrompt(root, withBom);
    let prepared: Awaited<ReturnType<typeof loadPreparedComfyUiApiWorkflow>> | undefined;
    try {
      prepared = await loadPreparedComfyUiApiWorkflow(root, saved.asset);
    } catch {
      prepared = undefined;
    }
    if (prepared) {
      assert.deepEqual(Buffer.from(prepared.promptJson, "utf8"), withBom);
    }
  });
});

test("retrospective acceptance (#215): missing, truncated, extended and symlinked bytes fail closed", async () => {
  await workspace(async (root) => {
    const bytes = Buffer.from(MINIMAL_PROMPT, "utf8");
    const saved = await savePrompt(root, bytes);
    const location = objectLocation(root, saved.asset);

    // Truncated to still-parseable-looking content.
    await writeFile(location, bytes.subarray(0, bytes.byteLength - 1));
    await assert.rejects(loadPreparedComfyUiApiWorkflow(root, saved.asset), Error);

    // Extended with whitespace (still valid JSON with identical meaning).
    await writeFile(location, Buffer.concat([bytes, Buffer.from("\n")]));
    await assert.rejects(loadPreparedComfyUiApiWorkflow(root, saved.asset), Error);

    // Byte length in the ref disagrees with the stored object.
    await writeFile(location, bytes);
    await assert.rejects(
      loadPreparedComfyUiApiWorkflow(root, { ...saved.asset, byteLength: bytes.byteLength + 1 }),
      Error,
    );

    // Real object deleted after a successful store.
    await unlink(location);
    await assert.rejects(loadPreparedComfyUiApiWorkflow(root, saved.asset), Error);

    // Object path replaced by a symlink to matching bytes elsewhere.
    const outside = path.join(root, "outside.json");
    await writeFile(outside, bytes);
    await symlink(outside, location);
    await assert.rejects(loadPreparedComfyUiApiWorkflow(root, saved.asset), Error);
  });
});

test("retrospective acceptance (#215): non-AssetRef values are rejected", async () => {
  await workspace(async (root) => {
    const saved = await savePrompt(root, MINIMAL_PROMPT);
    const { sha256: _sha256, ...withoutHash } = saved.asset;
    for (const value of [undefined, null, "workflow", saved.asset.sha256, {}, withoutHash, { ...saved.asset, kind: "Workflow" }]) {
      await assert.rejects(
        loadPreparedComfyUiApiWorkflow(root, value as never),
        Error,
        `incorrectly accepted ${JSON.stringify(value)}`,
      );
    }
  });
});

test("retrospective acceptance (#215): preflight performs no network access and no writes", async () => {
  await workspace(async (root) => {
    const good = await savePrompt(root, NATIVE_PROMPT);
    const bad = await savePrompt(root, '{"nodes":[],"links":[]}');
    const before = await listTree(root);
    const originalFetch = globalThis.fetch;
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network access is forbidden in preflight");
    }) as unknown as typeof fetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = function forbidden() {
      networkCalls += 1;
      throw new Error("network access is forbidden in preflight");
    };
    try {
      await loadPreparedComfyUiApiWorkflow(root, good.asset);
      await assert.rejects(loadPreparedComfyUiApiWorkflow(root, bad.asset), Error);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
    assert.equal(networkCalls, 0);
    assert.deepEqual(await listTree(root), before);
    assert.deepEqual(await readFile(objectLocation(root, good.asset)), Buffer.from(NATIVE_PROMPT, "utf8"));
  });
});
