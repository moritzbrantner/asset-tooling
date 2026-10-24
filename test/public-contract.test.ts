import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as publicApi from "../src/index.js";

const PUBLISHED_SCHEMA_BLOBS = {
  "asset-bundle-v1.schema.json": "2de513d0ca3733eae9d4f5e3c95de87a3db4ac5f",
  "asset-bundle-v2.schema.json": "7dd87542fb9e4d0a03ba2bf1be7f4312ef3eebaa",
  "asset-bundle-v3.schema.json": "caf63ba526ad50fbae3a74e1725e0e1536b1a36f",
  "asset-bundle-v4.schema.json": "66c12b7bbab9dd4b49aad129ac8e86929f144dfa",
  "asset-spec-v1.schema.json": "9e0cd63b4e5d83a02cbb3628e7e1e59aec024588",
  "audio-asset-v1.schema.json": "193934f6128ff2ad94152018d60713b5e0e03b4b",
  "crypt-kit-descriptor-v1.schema.json": "c81fb47595a9b94c4db764c151ac7248d122fb7e",
  "farm-structures-descriptor-v1.schema.json": "7e081372081659fed650dd4210026a1a38bba383",
  "generation-receipt-v1.schema.json": "472719e19daa3373de50cfd54ab52519bcbe60d5",
  "generation-receipt-v2.schema.json": "6503467dfdd69f05e32b3d9ec630939f442d80d1",
  "humanoid-item-v1.schema.json": "64f762e846376ceb1d2dad51b73887abf618adb2",
  "humanoid-sockets-v1.schema.json": "4524e391215aabc02bc535e8fc13a9b1f9d63ed5",
  "humanoid-sockets-v2.schema.json": "dd179362a11a5faefea353f557441cb03a768662",
  "model-acquisition-receipt-v1.schema.json": "acf30491a7e44c665b02e773492ee56407751759",
  "processing-handoff-v1.schema.json": "a3786363ec227307207e9331c3257701f01abbc2",
  "processing-receipt-v1.schema.json": "30bbc442c12fbf65f62073fbbec58247f79f6293",
  "processing-receipt-v2.schema.json": "417820551f5033140addac3684a4ed105ede6195",
  "shrine-kit-descriptor-v1.schema.json": "45b2c3f319d8e6b7b8b85b9c74ccdb1415dbf727",
};

function repositoryTextBytes(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function gitBlobSha(bytes) {
  const repositoryBytes = repositoryTextBytes(bytes);
  const header = Buffer.from(`blob ${repositoryBytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(repositoryBytes).digest("hex");
}

for (const [name, expectedSha] of Object.entries(PUBLISHED_SCHEMA_BLOBS)) {
  test(`published schema ${name} remains byte-for-byte immutable`, async () => {
    const bytes = await readFile(new URL(`../schemas/${name}`, import.meta.url));
    assert.equal(gitBlobSha(bytes), expectedSha);
  });
}

test("root package export remains deliberately small", () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    "generateAsset",
    "prepareProcessingHandoff",
    "validateSpec",
    "verifyAsset",
  ]);
});

async function runCli(args) {
  const cliPath = fileURLToPath(new URL("../src/entry.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("CLI usage errors exit with code 2", async () => {
  const missingCommand = await runCli([]);
  assert.equal(missingCommand.exitCode, 2);
  assert.match(missingCommand.stderr, /Usage:/);

  const unknownCommand = await runCli(["unknown", "missing.json"]);
  assert.equal(unknownCommand.exitCode, 2);
  assert.match(unknownCommand.stderr, /Usage:/);
});

test("CLI execution failures exit with code 1", async () => {
  const result = await runCli(["fingerprint", "unexpected"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /fingerprint does not accept arguments/);
});
