import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as publicApi from "../src/index.js";

const PUBLISHED_SCHEMA_BLOBS = {
  "asset-spec-v1.schema.json": "9e0cd63b4e5d83a02cbb3628e7e1e59aec024588",
  "generation-receipt-v1.schema.json": "472719e19daa3373de50cfd54ab52519bcbe60d5",
  "generation-receipt-v2.schema.json": "6503467dfdd69f05e32b3d9ec630939f442d80d1",
  "processing-handoff-v1.schema.json": "a3786363ec227307207e9331c3257701f01abbc2",
  "processing-receipt-v1.schema.json": "30bbc442c12fbf65f62073fbbec58247f79f6293",
  "processing-receipt-v2.schema.json": "417820551f5033140addac3684a4ed105ede6195",
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
  const cliPath = fileURLToPath(new URL("../src/entry.js", import.meta.url));
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
