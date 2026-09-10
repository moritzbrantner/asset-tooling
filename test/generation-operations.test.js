import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolveAssetObject } from "../src/asset-store.js";
import { generateAsset } from "../src/core.js";
import {
  PROCEDURAL_SVG_SCATTER_OPERATION,
  createProceduralSvgScatterOperationBuildIdentity,
  executeProceduralSvgScatterOperation,
} from "../src/generation-operations.js";

const EXPECTED_SHA256 = "59160909e6eac80d18bb58cd8a72a308df2c52c4ed866288bc73f48996f912a5";
const PARAMETERS = {
  seed: "42",
  width: 96,
  height: 64,
  count: 8,
  minRadius: 2,
  maxRadius: 6,
  background: "#101418",
  palette: ["#ffcc00", "#3366ff", "#33aa66"],
};

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-generation-operation-"));
}

function legacySpec(outputPath) {
  const { seed, ...parameters } = PARAMETERS;
  return {
    schemaVersion: 1,
    assetId: "test.procedural-svg-operation-parity",
    generator: { id: "builtin.procedural.svg-scatter", version: "1" },
    randomness: { mode: "seeded", seed },
    inputs: {},
    models: {},
    parameters,
    output: { path: outputPath },
    reproducibility: { expected: "exact" },
  };
}

test("procedural SVG operation describes a typed storage-neutral output", () => {
  assert.equal(PROCEDURAL_SVG_SCATTER_OPERATION.id, "procedural.svg.scatter");
  assert.equal(PROCEDURAL_SVG_SCATTER_OPERATION.version, "1");
  assert.deepEqual(PROCEDURAL_SVG_SCATTER_OPERATION.inputs, []);
  assert.deepEqual(PROCEDURAL_SVG_SCATTER_OPERATION.outputs[0].assetKinds, ["vector-image"]);
  assert.deepEqual(PROCEDURAL_SVG_SCATTER_OPERATION.outputs[0].mediaTypes, ["image/svg+xml"]);
  assert.equal(PROCEDURAL_SVG_SCATTER_OPERATION.parameterSchema.properties.seed.type, "string");
});

test("procedural SVG operation build identity includes seed and concrete backend/tool identity", async () => {
  const identity = await createProceduralSvgScatterOperationBuildIdentity({ parameters: PARAMETERS });
  assert.deepEqual(identity.operation, { id: "procedural.svg.scatter", version: "1" });
  assert.equal(identity.parameters.seed, "42");
  assert.equal(identity.implementation.id, "builtin.procedural.svg-scatter");
  assert.equal(identity.implementation.version, "1");
  assert.equal(identity.implementation.kind, "procedural");
  assert.equal(identity.implementation.tool.name, "asset-tooling");
  assert.match(identity.implementation.tool.sourceFingerprint.sha256, /^[0-9a-f]{64}$/);

  const otherSeed = await createProceduralSvgScatterOperationBuildIdentity({
    parameters: { ...PARAMETERS, seed: "43" },
  });
  assert.notDeepEqual(identity, otherSeed);
});

test("procedural SVG operation reuses the authoritative backend and matches legacy generation bytes", async () => {
  const root = await workspace();
  const operationResult = await executeProceduralSvgScatterOperation(root, { parameters: PARAMETERS });
  const operationAsset = operationResult.outputs.output;
  const operationBytes = await resolveAssetObject(root, operationAsset);

  assert.equal(operationAsset.sha256, EXPECTED_SHA256);
  assert.equal(operationAsset.kind, "vector-image");
  assert.equal(operationAsset.mediaType, "image/svg+xml");
  assert.deepEqual(operationAsset.metadata, { height: 64, width: 96 });

  const outputPath = ".asset-tooling/legacy-scatter.svg";
  const specPath = path.join(root, "legacy-asset.json");
  await writeFile(specPath, `${JSON.stringify(legacySpec(outputPath), null, 2)}\n`);
  const legacy = await generateAsset(specPath);
  const legacyBytes = await readFile(path.join(root, ".asset-tooling", "legacy-scatter.svg"));

  assert.equal(legacy.outputSha256, EXPECTED_SHA256);
  assert.deepEqual(operationBytes, legacyBytes);
  assert.deepEqual(operationResult.observations, legacy.receipt.observations);
});

test("procedural SVG operation is semantically idempotent while object storage reuses the same content", async () => {
  const root = await workspace();
  const first = await executeProceduralSvgScatterOperation(root, { parameters: PARAMETERS });
  const second = await executeProceduralSvgScatterOperation(root, { parameters: PARAMETERS });

  assert.deepEqual(second, first);
  assert.deepEqual(
    await resolveAssetObject(root, second.outputs.output),
    await resolveAssetObject(root, first.outputs.output),
  );
});

test("procedural SVG operation rejects inputs, invalid seeds, and parameters the backend does not own", async () => {
  const root = await workspace();
  await assert.rejects(
    () => executeProceduralSvgScatterOperation(root, { parameters: { ...PARAMETERS, seed: "01" } }),
    /parameters\.seed must be a non-negative decimal integer string/,
  );
  await assert.rejects(
    () => executeProceduralSvgScatterOperation(root, { parameters: { ...PARAMETERS, ambient: true } }),
    /does not accept parameter 'ambient'/,
  );
  await assert.rejects(
    () =>
      executeProceduralSvgScatterOperation(root, {
        parameters: PARAMETERS,
        inputs: {
          source: {
            schemaVersion: 1,
            kind: "image",
            mediaType: "image/png",
            sha256: "a".repeat(64),
            byteLength: 1,
            metadata: {},
          },
        },
      }),
    /unknown port 'source'/,
  );
});
