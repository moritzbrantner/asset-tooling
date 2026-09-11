import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createAssetOperationDescriptor } from "../src/operations.js";
import {
  ASSET_OPERATION_WORKFLOW_KIND,
  createAssetOperationWorkflowExecutor,
} from "../src/workflow-operations.js";

const OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1,
  id: "fixture.requires-image",
  version: "1",
  category: "fixture",
  inputs: [
    {
      id: "source",
      assetKinds: ["image"],
      mediaTypes: ["image/png"],
    },
  ],
  outputs: [],
  parameterSchema: {},
});

function node() {
  return {
    id: "fixture-node",
    kind: ASSET_OPERATION_WORKFLOW_KIND,
    data: {
      assetOperation: {
        id: OPERATION.id,
        version: OPERATION.version,
        parameters: {},
      },
    },
  };
}

test("workflow bridge rejects missing required input before invoking registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-workflow-input-"));
  let invoked = false;
  const executor = createAssetOperationWorkflowExecutor({
    root,
    registrations: [
      {
        operation: OPERATION,
        execute() {
          invoked = true;
          return { outputs: {} };
        },
      },
    ],
  });

  await assert.rejects(
    () => executor({ runId: "missing", node: node(), inputs: {} }),
    /missing required port 'source'/,
  );
  assert.equal(invoked, false);
});

test("workflow bridge rejects incompatible AssetRef before invoking registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-workflow-input-"));
  let invoked = false;
  const executor = createAssetOperationWorkflowExecutor({
    root,
    registrations: [
      {
        operation: OPERATION,
        execute() {
          invoked = true;
          return { outputs: {} };
        },
      },
    ],
  });

  await assert.rejects(
    () =>
      executor({
        runId: "wrong-media",
        node: node(),
        inputs: {
          source: {
            schemaVersion: 1,
            kind: "image",
            mediaType: "image/jpeg",
            sha256: "0".repeat(64),
            byteLength: 1,
            metadata: {},
          },
        },
      }),
    /media type 'image\/jpeg' is not accepted/,
  );
  assert.equal(invoked, false);
});
