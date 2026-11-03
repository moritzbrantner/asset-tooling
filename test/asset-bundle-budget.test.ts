import test from "node:test";
import assert from "node:assert/strict";
import { checkBudget, createBundleBudgetTracker } from "../src/asset-bundle-manifest.js";
import type { BundleResource } from "../src/asset-bundle-contract.js";

const MIB = 1024 * 1024;

function resource(index: number, byteLength: number): BundleResource {
  return {
    path: `assets/${String(index).padStart(4, "0")}.rgba.json`,
    source: { kind: "image", mediaType: "application/vnd.moritzbrantner.rgba8+json", sha256: index.toString(16).padStart(64, "0"), byteLength },
  };
}

test("incremental budget agrees with full validation across a 3,600-resource bundle", () => {
  const initial = Array.from({ length: 512 }, (_, index) => resource(index, 1024));
  const remaining = Array.from({ length: 3584 }, (_, index) => resource(index + 512, 1024));
  const budget = createBundleBudgetTracker(initial);
  for (const entry of remaining) budget.add(entry);
  checkBudget([...initial, ...remaining]);
});

test("incremental budget deduplicates identical paths but rejects conflicting lengths", () => {
  const first = resource(0, 128 * MIB);
  const second = resource(1, 128 * MIB);
  const budget = createBundleBudgetTracker([first]);
  budget.add(first);
  budget.add(second);
  assert.throws(() => budget.add(resource(2, 1)), /256 MiB unique payload budget/);
  assert.throws(() => budget.add({ ...first, source: { ...first.source, byteLength: 1 } }), /conflicting byte lengths/);
  assert.doesNotThrow(() => checkBudget([first, first, second]));
  assert.throws(() => checkBudget([first, { ...first, source: { ...first.source, byteLength: 1 } }]), /conflicting byte lengths/);
});
