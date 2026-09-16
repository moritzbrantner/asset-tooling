import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertPortableRelativePath } from "../src/schema.js";

test("portable paths reject drive-qualified values at runtime", () => {
  for (const candidate of ["C:/models/checkpoint.bin", "c:/output/image.png", "D:relative.txt"]) {
    assert.throws(
      () => assertPortableRelativePath(candidate, "path"),
      /must not be drive-qualified/,
    );
  }
  assert.equal(
    assertPortableRelativePath("models/checkpoint.bin", "path"),
    "models/checkpoint.bin",
  );
});

test("generation receipt v2 schema rejects drive-qualified portable paths", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schemas/generation-receipt-v2.schema.json", import.meta.url), "utf8"),
  );
  const portablePath = new RegExp(schema.$defs.portablePath.pattern);
  assert.equal(portablePath.test("models/checkpoint.bin"), true);
  assert.equal(portablePath.test("C:/models/checkpoint.bin"), false);
  assert.equal(portablePath.test("c:/output/image.png"), false);
  assert.equal(portablePath.test("D:relative.txt"), false);
});
