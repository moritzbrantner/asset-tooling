import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, stablePrettyJson } from "../src/canonical.js";

test("canonical JSON preserves own __proto__ keys", () => {
  const value = JSON.parse('{"mode":"a","__proto__":{"x":1}}');
  const canonical = canonicalJson(value);

  assert.equal(canonical, '{"__proto__":{"x":1},"mode":"a"}');
  const roundTrip = JSON.parse(canonical);
  assert.equal(Object.hasOwn(roundTrip, "__proto__"), true);
  assert.deepEqual(roundTrip.__proto__, { x: 1 });
});

test("stable pretty JSON preserves own constructor and prototype-shaped keys", () => {
  const value = JSON.parse('{"prototype":{"y":2},"constructor":{"z":3},"__proto__":{"x":1}}');
  const roundTrip = JSON.parse(stablePrettyJson(value));

  assert.deepEqual(roundTrip, value);
  assert.equal(Object.hasOwn(roundTrip, "__proto__"), true);
  assert.equal(Object.hasOwn(roundTrip, "constructor"), true);
  assert.equal(Object.hasOwn(roundTrip, "prototype"), true);
});
