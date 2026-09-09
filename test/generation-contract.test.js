import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readSchema(name) {
  return JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
}

test("published generation receipt v1 remains the immutable compatibility contract", async () => {
  const schema = await readSchema("generation-receipt-v1.schema.json");
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.$defs.generator.required, ["id", "version"]);
  assert.equal(schema.$defs.generator.properties.kind, undefined);
  assert.equal(schema.properties.parameters, undefined);
  assert.equal(schema.properties.observations, undefined);
});

test("generation receipt v2 is shared by procedural and model generators", async () => {
  const schema = await readSchema("generation-receipt-v2.schema.json");
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.ok(schema.required.includes("parameters"));
  assert.ok(schema.required.includes("parametersSha256"));
  assert.ok(schema.required.includes("observations"));
  assert.deepEqual(schema.$defs.generator.required, ["id", "version", "kind"]);
  assert.deepEqual(
    schema.$defs.generator.properties.kind.enum,
    ["procedural", "model", "utility"],
  );
  assert.equal(schema.properties.inputs.additionalProperties.$ref, "#/$defs/artifact");
  assert.equal(schema.properties.models.additionalProperties.$ref, "#/$defs/model");
  assert.equal(schema.properties.observations.type, "object");
});

test("generation receipt v2 keeps provenance containers fail-closed", async () => {
  const schema = await readSchema("generation-receipt-v2.schema.json");
  for (const definition of [
    "specIdentity",
    "toolIdentity",
    "generator",
    "artifact",
    "model",
    "environment",
    "output",
    "reproducibility",
  ]) {
    assert.equal(schema.$defs[definition].additionalProperties, false, definition);
  }
});
