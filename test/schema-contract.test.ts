import { expect, test } from "bun:test";
import {
  parseAssetSpec,
  parseGenerationReceipt,
  type AssetSpec,
} from "../src/schema.js";

const SHA = "a".repeat(64);

test("asset spec parsing exposes one normalized typed contract", () => {
  const spec: AssetSpec = parseAssetSpec({
    schemaVersion: 1,
    assetId: "fixture.asset",
    generator: { id: "fixture.generator", version: "1" },
    randomness: { mode: "seeded", seed: "42" },
    inputs: {
      zSource: { path: "inputs/z.bin", sha256: SHA },
      aSource: { path: "inputs/a.bin", sha256: SHA },
    },
    models: {
      primary: { id: "fixture.model", path: "models/model.bin", sha256: SHA },
    },
    parameters: { count: 2, nested: { enabled: true } },
    output: { path: "dist/output.bin" },
    reproducibility: { expected: "exact" },
  });

  expect(Object.keys(spec.inputs)).toEqual(["aSource", "zSource"]);
  expect(spec.models.primary?.id).toBe("fixture.model");
  expect(spec.randomness).toEqual({ mode: "seeded", seed: "42" });
  expect(spec.parameters).toEqual({ count: 2, nested: { enabled: true } });
});

test("asset spec parsing keeps schema and JSON evidence fail-closed", () => {
  const base = {
    schemaVersion: 1,
    assetId: "fixture.asset",
    generator: { id: "fixture.generator", version: "1" },
    randomness: { mode: "none" },
    inputs: {},
    models: {},
    output: { path: "dist/output.bin" },
    reproducibility: { expected: "exact" },
  };

  expect(() => parseAssetSpec({ ...base, parameters: { score: Number.NaN } })).toThrow(
    "parameters.score contains a non-finite number",
  );
  expect(() => parseAssetSpec({ ...base, parameters: {}, extra: true })).toThrow(
    "asset spec contains unknown field 'extra'",
  );
  expect(() =>
    parseAssetSpec({ ...base, parameters: {}, output: { path: "../outside.bin" } }),
  ).toThrow("output.path must not contain empty, '.' or '..' segments");
});

test("legacy generation receipt parsing returns its validated v1 shape", () => {
  const receipt = parseGenerationReceipt({
    schemaVersion: 1,
    assetId: "fixture.asset",
    spec: { sha256: SHA, canonicalizer: "asset-tooling-canonical-json-v1" },
    tool: {
      name: "asset-tooling",
      version: "0.1.0",
      sourceFingerprint: { algorithm: "sha256-tree-v1", sha256: SHA },
    },
    generator: { id: "fixture.generator", version: "1" },
    randomness: { mode: "none" },
    inputs: { source: { path: "inputs/source.bin", sha256: SHA } },
    models: {
      primary: { id: "fixture.model", path: "models/model.bin", sha256: SHA },
    },
    parametersSha256: SHA,
    environment: {
      schemaVersion: 1,
      platform: { os: "linux", arch: "x64" },
      runtime: { name: "bun", version: "1.4.0", executableSha256: SHA },
      components: [{ name: "fixture", version: "1" }],
      sha256: SHA,
    },
    output: { path: "dist/output.bin", sha256: SHA },
    reproducibility: { expected: "exact", baseline: "constrained", reasons: [] },
  });

  expect(receipt.schemaVersion).toBe(1);
  expect(receipt.models.primary?.id).toBe("fixture.model");
  expect(receipt.tool.sourceFingerprint.algorithm).toBe("sha256-tree-v1");
  expect(receipt.reproducibility).toEqual({
    expected: "exact",
    baseline: "constrained",
    reasons: [],
  });
});
