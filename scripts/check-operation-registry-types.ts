import { createAssetOperationRegistry } from "../src/operations.js";

const registry = createAssetOperationRegistry([
  {
    id: "test.operation",
    version: "1",
    category: "test.operation",
    inputs: [{ id: "source" }],
    outputs: [{ id: "output" }],
  },
]);

const registered = registry.get("test.operation", "1");
if (!registered) throw new Error("type contract fixture must register its descriptor");

// @ts-expect-error registered descriptors are recursively frozen and must be readonly to callers
registered.version = "2";
// @ts-expect-error nested descriptor arrays are recursively frozen and must be readonly to callers
registered.inputs.push({
  id: "other",
  assetKinds: [],
  mediaTypes: [],
  cardinality: "single",
  required: true,
});

const listed = registry.list();
listed.push(registered);
// @ts-expect-error list snapshots are mutable, but the frozen descriptors they contain are readonly
listed[0]!.outputs[0]!.required = false;
