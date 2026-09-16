import test from "node:test";
import assert from "node:assert/strict";

test("package exports skinning production validation through a focused processing subpath", async () => {
  const skinning = await import("asset-tooling/operations/processing/skinning");
  assert.equal(skinning.MESH_SKINNING_VALIDATE_OPERATION.id, "mesh.skinning.validate");
  assert.equal(
    skinning.THREE_D_SKINNING_MEDIA_TYPE,
    "application/vnd.moritzbrantner.three-d.skinning+json",
  );
});
