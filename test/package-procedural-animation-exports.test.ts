import test from "node:test";
import assert from "node:assert/strict";

test("package exports procedural animation operations through a focused generation subpath", async () => {
  const operations = await import("asset-tooling/operations/generation/procedural-animation");
  assert.deepEqual(
    operations.PROCEDURAL_ANIMATION_OPERATIONS.map((operation) => operation.id),
    [
      "animation.procedural.translation",
      "animation.procedural.uniform-scale",
      "animation.procedural.yaw",
    ],
  );
});
