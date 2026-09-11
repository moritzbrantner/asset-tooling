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

test("canonical JSON rejects sparse and decorated arrays instead of collapsing them", () => {
  const sparse = Array(1);
  assert.throws(() => canonicalJson(sparse), /does not support sparse arrays/);

  const decorated = [1];
  decorated.label = "ignored-by-JSON";
  assert.throws(() => canonicalJson(decorated), /does not support extra array properties/);
});

test("canonical JSON rejects non-plain objects and accessor properties", () => {
  assert.throws(() => canonicalJson(new Date(0)), /requires plain objects/);
  assert.throws(() => canonicalJson(new Map([["a", 1]])), /requires plain objects/);

  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      return 1;
    },
  });
  assert.throws(() => canonicalJson(accessor), /requires enumerable data properties/);
});

test("canonical JSON rejects symbol properties instead of ignoring them", () => {
  const value = { visible: true };
  value[Symbol("hidden")] = 1;
  assert.throws(() => canonicalJson(value), /does not support symbol properties/);
});
