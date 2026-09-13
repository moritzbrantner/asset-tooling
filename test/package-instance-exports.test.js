import test from "node:test";
import assert from "node:assert/strict";

test("package exports canonical instance-set and instance operations subpaths", async () => {
  const instanceSet = await import("asset-tooling/instance-set");
  const operations = await import("asset-tooling/operations/instances");
  assert.equal(
    instanceSet.INSTANCE_SET_MEDIA_TYPE,
    "application/vnd.asset-tooling.instance-set+json",
  );
  assert.deepEqual(
    operations.INSTANCE_OPERATIONS.map((operation) => operation.id),
    [
      "instances.project.heightfield",
      "instances.scatter.minimum-distance",
      "instances.scatter.uniform",
    ],
  );
});
