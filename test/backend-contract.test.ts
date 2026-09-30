import { expect, test } from "bun:test";
import {
  normalizeGenerationResult,
  receiptGenerator,
  type GeneratorBackendIdentity,
} from "../src/backend-contract.js";

test("receipt generator binds the selected backend kind to the spec identity", () => {
  const backend: GeneratorBackendIdentity = {
    id: "builtin.copy",
    version: "1",
    kind: "utility",
  };

  expect(receiptGenerator({ id: "builtin.copy", version: "1" }, backend)).toEqual({
    id: "builtin.copy",
    version: "1",
    kind: "utility",
  });
});

test("receipt generator fails closed on unsupported kinds and identity drift", () => {
  expect(() =>
    receiptGenerator(
      { id: "builtin.copy", version: "1" },
      { id: "builtin.copy", version: "1", kind: "ambient" },
    ),
  ).toThrow("unsupported kind 'ambient'");

  expect(() =>
    receiptGenerator(
      { id: "builtin.copy", version: "1" },
      { id: "builtin.copy", version: "2", kind: "utility" },
    ),
  ).toThrow("selected backend identity does not match the asset specification");
});

test("generation result normalization owns canonical bytes and JSON observations", () => {
  const direct = normalizeGenerationResult(new Uint8Array([1, 2, 3]), "fixture.backend");
  expect(Buffer.isBuffer(direct.bytes)).toBe(true);
  expect([...direct.bytes]).toEqual([1, 2, 3]);
  expect(direct.observations).toEqual({});

  const structured = normalizeGenerationResult(
    {
      bytes: new Uint8Array([4, 5]),
      observations: {
        algorithm: "fixture-v1",
        counts: [1, 2],
        nested: { accepted: true },
      },
    },
    "fixture.backend",
  );
  expect([...structured.bytes]).toEqual([4, 5]);
  expect(structured.observations).toEqual({
    algorithm: "fixture-v1",
    counts: [1, 2],
    nested: { accepted: true },
  });
});

test("generation result normalization rejects ambiguous or non-JSON evidence", () => {
  expect(() =>
    normalizeGenerationResult(
      { bytes: new Uint8Array([1]), observations: {}, extra: true },
      "fixture.backend",
    ),
  ).toThrow("generation result contains unknown field 'extra'");

  expect(() =>
    normalizeGenerationResult(
      { bytes: new Uint8Array([1]), observations: { score: Number.NaN } },
      "fixture.backend",
    ),
  ).toThrow("contains a non-finite number");

  expect(() =>
    normalizeGenerationResult(
      { bytes: new Uint8Array([1]), observations: { callback: () => undefined } },
      "fixture.backend",
    ),
  ).toThrow("contains unsupported value type 'function'");
});
