import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { generateAsset, verifyAsset } from "../src/core.js";
import { probeProcessAdapter, runProcessAdapter } from "../src/process-adapter.js";

function proceduralSpec() {
  return {
    schemaVersion: 1,
    assetId: "test.adapter-contract",
    generator: { id: "builtin.procedural.svg-scatter", version: "1" },
    randomness: { mode: "seeded", seed: "42" },
    inputs: {},
    models: {},
    parameters: {
      width: 96,
      height: 64,
      count: 8,
      minRadius: 2,
      maxRadius: 6,
      background: "#101418",
      palette: ["#ffcc00", "#3366ff", "#33aa66"],
    },
    output: { path: ".asset-tooling/scatter.svg" },
    reproducibility: { expected: "exact" },
  };
}

async function writeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-adapter-contract-"));
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(proceduralSpec(), null, 2)}\n`);
  return { root, specPath };
}

test("generation emits receipt v2 with explicit backend kind, parameters, and observations", async () => {
  const { specPath } = await writeWorkspace();
  const result = await generateAsset(specPath);
  assert.equal(result.receipt.schemaVersion, 2);
  assert.equal(result.receipt.generator.kind, "procedural");
  assert.deepEqual(result.receipt.parameters, proceduralSpec().parameters);
  assert.deepEqual(result.receipt.observations, {
    algorithm: "svg-scatter-v1",
    prng: "splitmix64-v1",
    generatedElementCount: 8,
  });
});

test("verification binds deterministic backend observations", async () => {
  const { specPath, root } = await writeWorkspace();
  const generated = await generateAsset(specPath);
  const receiptPath = path.join(root, generated.receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.observations.generatedElementCount = 999;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const report = await verifyAsset(specPath);
  assert.equal(report.status, "drift");
  assert.equal(report.checks.observationsMatchReceipt, false);
});

test("receipt v2 parameters hash is fail-closed", async () => {
  const { specPath, root } = await writeWorkspace();
  const generated = await generateAsset(specPath);
  const receiptPath = path.join(root, generated.receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.parameters.count = 9;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const report = await verifyAsset(specPath);
  assert.equal(report.status, "broken");
  assert.match(report.error, /parametersSha256 does not match receipt\.parameters/);
});

test("verification retains generation receipt v1 compatibility", async () => {
  const { specPath, root } = await writeWorkspace();
  const generated = await generateAsset(specPath);
  const receiptPath = path.join(root, generated.receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.schemaVersion = 1;
  receipt.generator = {
    id: receipt.generator.id,
    version: receipt.generator.version,
  };
  delete receipt.parameters;
  delete receipt.observations;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const report = await verifyAsset(specPath);
  assert.equal(report.status, "exact");
});

test("local process adapter protocol probes and generates without leaking temp paths", async () => {
  const scriptPath = fileURLToPath(new URL("./fixtures/process-adapter.js", import.meta.url));
  const components = await probeProcessAdapter({
    executable: process.execPath,
    scriptPath,
    cwd: process.cwd(),
  });
  assert.deepEqual(components, [
    {
      id: "fixture.runtime",
      version: "1",
      protocol: "asset-tooling-process-adapter-v1",
    },
  ]);

  const generated = await runProcessAdapter({
    executable: process.execPath,
    scriptPath,
    cwd: process.cwd(),
    request: { message: "hello" },
    outputName: "fixture.txt",
  });
  assert.equal(generated.bytes.toString("utf8"), "fixture:hello\n");
  assert.deepEqual(generated.observations, {
    protocol: "fixture-v1",
    messageLength: 5,
  });
});
