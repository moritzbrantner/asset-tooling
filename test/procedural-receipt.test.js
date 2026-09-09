import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { generateAsset, verifyAsset } from "../src/core.js";

async function makeProceduralSpec() {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-procedural-receipt-"));
  const spec = {
    schemaVersion: 1,
    assetId: "test.procedural-receipt",
    generator: { id: "builtin.procedural.svg-scatter", version: "1" },
    randomness: { mode: "seeded", seed: "42" },
    inputs: {},
    models: {},
    parameters: {
      width: 128,
      height: 96,
      count: 8,
      minRadius: 2,
      maxRadius: 8,
      background: "#111111",
      palette: ["#ffffff", "#ff0000"],
    },
    output: { path: ".asset-tooling/scatter.svg" },
    reproducibility: { expected: "exact" },
  };
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return { spec, specPath };
}

test("procedural generation emits and replays generation receipt v2 evidence", async () => {
  const { spec, specPath } = await makeProceduralSpec();
  const generated = await generateAsset(specPath);

  assert.equal(generated.receipt.schemaVersion, 2);
  assert.deepEqual(generated.receipt.generator, {
    id: "builtin.procedural.svg-scatter",
    version: "1",
    kind: "procedural",
  });
  assert.deepEqual(generated.receipt.parameters, spec.parameters);
  assert.equal(generated.receipt.observations.algorithm, "svg-scatter-v1");
  assert.equal(generated.receipt.observations.prng, "splitmix64-v1");
  assert.equal(generated.receipt.observations.generatedElementCount, spec.parameters.count);

  const verified = await verifyAsset(specPath);
  assert.equal(verified.status, "exact");
  assert.equal(verified.checks.observationsMatchReceipt, true);
});
