import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/canonical.js";
import { generateAsset, validateSpec, verifyAsset } from "../src/core.js";
import { sha256Bytes } from "../src/hash.js";

async function makeWorkspace(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-test-"));
  await mkdir(path.join(root, "inputs"), { recursive: true });
  const source = Buffer.from("deterministic source\n", "utf8");
  await writeFile(path.join(root, "inputs", "source.txt"), source);

  const spec = {
    schemaVersion: 1,
    assetId: "test.copy",
    generator: { id: "builtin.copy", version: "1" },
    randomness: { mode: "none" },
    inputs: {
      source: {
        path: "inputs/source.txt",
        sha256: sha256Bytes(source),
      },
    },
    models: {},
    parameters: {},
    output: { path: ".asset-tooling/output.txt" },
    reproducibility: { expected: "exact" },
    ...overrides,
  };
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return { root, specPath, spec, source };
}

test("canonical JSON is stable across object insertion order", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { d: 4, c: 3 }, items: [{ b: 2, a: 1 }] }),
    canonicalJson({ items: [{ a: 1, b: 2 }], a: { c: 3, d: 4 }, z: 1 }),
  );
});

test("validate rejects non-portable paths", async () => {
  const { specPath } = await makeWorkspace({
    output: { path: "../escaped.txt" },
  });
  await assert.rejects(() => validateSpec(specPath), /must not contain empty, '\.' or '\.\.' segments/);
});

test("validate rejects specs the selected backend cannot consume", async () => {
  const { specPath } = await makeWorkspace({ randomness: { mode: "seeded", seed: "7" } });
  await assert.rejects(() => validateSpec(specPath), /builtin\.copy requires randomness\.mode='none'/);
});

test("receipt collisions fail before mutating outputs or dependencies", async () => {
  for (const target of ["asset.json", "inputs/source.txt", ".asset-tooling/output.txt"]) {
    const { specPath, root, source } = await makeWorkspace();
    await assert.rejects(() => generateAsset(specPath, { receiptPath: target }), /receipt path must not collide/);
    await assert.rejects(() => readFile(path.join(root, ".asset-tooling", "output.txt")), /ENOENT/);
    assert.deepEqual(await readFile(path.join(root, "inputs", "source.txt")), source);
  }
});

test("receipt collisions follow filesystem aliases", async () => {
  if (process.platform === "win32") return;
  const { specPath, root, source } = await makeWorkspace();
  await symlink("inputs/source.txt", path.join(root, "receipt-alias.json"));
  await assert.rejects(
    () => generateAsset(specPath, { receiptPath: "receipt-alias.json" }),
    /receipt path must not collide with input 'source'/,
  );
  assert.deepEqual(await readFile(path.join(root, "inputs", "source.txt")), source);
  await assert.rejects(() => readFile(path.join(root, ".asset-tooling", "output.txt")), /ENOENT/);
});

test("receipt schema constrains required provenance structures", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schemas/generation-receipt-v1.schema.json", import.meta.url), "utf8"),
  );
  assert.equal(schema.properties.generator.$ref, "#/$defs/generator");
  assert.equal(schema.properties.randomness.$ref, "#/$defs/randomness");
  assert.equal(schema.properties.inputs.additionalProperties.$ref, "#/$defs/artifact");
  assert.equal(schema.properties.models.additionalProperties.$ref, "#/$defs/model");
  for (const definition of ["generator", "artifact", "model"]) {
    assert.equal(schema.$defs[definition].additionalProperties, false);
  }
  assert.equal(schema.properties.environment.additionalProperties, false);
  assert.equal(schema.properties.environment.properties.platform.additionalProperties, false);
  assert.equal(schema.properties.environment.properties.runtime.additionalProperties, false);
});

test("verification rejects receipts missing required provenance", async () => {
  const { specPath, root } = await makeWorkspace();
  const generated = await generateAsset(specPath);
  const receiptPath = path.join(root, generated.receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  delete receipt.tool;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const report = await verifyAsset(specPath);
  assert.equal(report.status, "broken");
  assert.match(report.error, /receipt\.tool must be an object/);
});

test("generation reconciles identical output and receipt", async () => {
  const { specPath, root, source } = await makeWorkspace();
  const first = await generateAsset(specPath);
  const second = await generateAsset(specPath);

  assert.equal(first.status, "changed");
  assert.equal(first.outputChanged, true);
  assert.equal(first.receiptChanged, true);
  assert.match(first.receipt.tool.sourceFingerprint.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.receipt.environment.components, []);
  assert.equal(second.status, "unchanged");
  assert.equal(second.outputChanged, false);
  assert.equal(second.receiptChanged, false);
  assert.deepEqual(await readFile(path.join(root, ".asset-tooling", "output.txt")), source);
});

test("exact verification rebuilds and compares accepted bytes", async () => {
  const { specPath } = await makeWorkspace();
  await generateAsset(specPath);
  const report = await verifyAsset(specPath);

  assert.equal(report.status, "exact");
  assert.equal(report.checks.acceptedOutputMatchesReceipt, true);
  assert.equal(report.checks.regeneratedOutputMatchesReceipt, true);
});

test("verification reports tampered accepted output as drift", async () => {
  const { specPath, root } = await makeWorkspace();
  await generateAsset(specPath);
  await writeFile(path.join(root, ".asset-tooling", "output.txt"), "tampered\n");

  const report = await verifyAsset(specPath);
  assert.equal(report.status, "drift");
  assert.equal(report.checks.acceptedOutputMatchesReceipt, false);
  assert.equal(report.checks.regeneratedOutputMatchesReceipt, true);
});

test("declared input hash mismatch fails closed before mutation", async () => {
  const { specPath, root } = await makeWorkspace();
  await writeFile(path.join(root, "inputs", "source.txt"), "changed source\n");

  await assert.rejects(() => generateAsset(specPath), /input 'source' hash mismatch/);
  await assert.rejects(() => readFile(path.join(root, ".asset-tooling", "output.txt")), /ENOENT/);
});

test("environment drift is visible without invalidating byte-exact reproduction", async () => {
  const { specPath, root } = await makeWorkspace();
  await generateAsset(specPath);
  const receiptPath = path.join(root, ".asset-tooling", "output.txt.receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.environment.sha256 = "0".repeat(64);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const report = await verifyAsset(specPath);
  assert.equal(report.status, "exact");
  assert.equal(report.checks.environmentMatchesReceipt, false);
});
