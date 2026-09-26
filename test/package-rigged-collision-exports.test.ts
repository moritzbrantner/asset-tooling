import test from "node:test";
import assert from "node:assert/strict";

test("package exports rigged collision processing through a focused subpath", async () => {
  const collision = await import("asset-tooling/operations/processing/rigged-collision");
  assert.equal(collision.MESH_RIGGED_COLLISION_FIT_OPERATION.id, "mesh.rigged-collision.fit");
  assert.equal(
    collision.THREE_D_RIGGED_COLLISION_MEDIA_TYPE,
    "application/vnd.moritzbrantner.three-d.rigged-collision+json",
  );
});
