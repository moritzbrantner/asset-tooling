import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_MIX_OPERATION,
  AUDIO_SYNTHESIZE_OPERATION,
} from "../src/audio-operations.js";
import {
  createAssetOperationWorkflowNodeTemplate,
  validateAssetOperationWorkflowConnection,
} from "../src/workflow-operations.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assetNode(template, id) {
  return {
    id,
    kind: template.kind,
    ...(template.inputs ? { inputs: clone(template.inputs) } : {}),
    ...(template.outputs ? { outputs: clone(template.outputs) } : {}),
  };
}

test("an exact generic AssetRef port may bridge an asset output", () => {
  const synth = createAssetOperationWorkflowNodeTemplate(AUDIO_SYNTHESIZE_OPERATION);
  const audioType = clone(synth.outputs[0].type);
  const document = {
    nodes: [
      assetNode(synth, "synth"),
      {
        id: "generic-exact",
        kind: "fixture.generic",
        inputs: [{ id: "input", type: audioType }],
      },
      {
        id: "generic-loose",
        kind: "fixture.generic",
        inputs: [{ id: "input", type: { kind: "object" } }],
      },
    ],
    edges: [],
  };

  assert.deepEqual(
    validateAssetOperationWorkflowConnection(document, {
      sourceNodeId: "synth",
      sourcePortId: "output",
      targetNodeId: "generic-exact",
      targetPortId: "input",
    }),
    { valid: true },
  );
  assert.deepEqual(
    validateAssetOperationWorkflowConnection(document, {
      sourceNodeId: "synth",
      sourcePortId: "output",
      targetNodeId: "generic-loose",
      targetPortId: "input",
    }),
    { valid: false, reason: "type-mismatch" },
  );
});

test("a generic producer cannot satisfy a lossy wildcard asset constraint by type alone", () => {
  const wildcardSink = createAssetOperationWorkflowNodeTemplate({
    schemaVersion: 1,
    id: "fixture.audio-wildcard.sink",
    version: "1",
    category: "fixture",
    inputs: [{ id: "source", assetKinds: ["media"], mediaTypes: ["audio/*"] }],
    outputs: [],
    parameterSchema: {},
  });
  const document = {
    nodes: [
      {
        id: "generic",
        kind: "fixture.generic",
        outputs: [{ id: "output", type: clone(wildcardSink.inputs[0].type) }],
      },
      assetNode(wildcardSink, "sink"),
    ],
    edges: [],
  };

  assert.deepEqual(
    validateAssetOperationWorkflowConnection(document, {
      sourceNodeId: "generic",
      sourcePortId: "output",
      targetNodeId: "sink",
      targetPortId: "source",
    }),
    { valid: false, reason: "type-mismatch" },
  );
});

test("a bounded generic AssetRef array must propagate verified asset metadata", () => {
  const mix = createAssetOperationWorkflowNodeTemplate(AUDIO_MIX_OPERATION);
  const sourceArrayType = clone(mix.inputs[0].type);
  const sourceArrayMetadata = clone(mix.inputs[0].metadata);
  const document = {
    nodes: [
      {
        id: "array-verified",
        kind: "json.array",
        outputs: [{ id: "value", type: sourceArrayType, metadata: sourceArrayMetadata }],
      },
      {
        id: "array-unverified",
        kind: "json.array",
        outputs: [{ id: "value", type: sourceArrayType }],
      },
      {
        id: "array-loose",
        kind: "json.array",
        outputs: [{ id: "value", type: { kind: "array", element: { kind: "object" } } }],
      },
      assetNode(mix, "mix"),
    ],
    edges: [],
  };

  assert.deepEqual(
    validateAssetOperationWorkflowConnection(document, {
      sourceNodeId: "array-verified",
      sourcePortId: "value",
      targetNodeId: "mix",
      targetPortId: "sources",
    }),
    { valid: true },
  );
  assert.deepEqual(
    validateAssetOperationWorkflowConnection(document, {
      sourceNodeId: "array-unverified",
      sourcePortId: "value",
      targetNodeId: "mix",
      targetPortId: "sources",
    }),
    { valid: false, reason: "type-mismatch" },
  );
  assert.deepEqual(
    validateAssetOperationWorkflowConnection(document, {
      sourceNodeId: "array-loose",
      sourcePortId: "value",
      targetNodeId: "mix",
      targetPortId: "sources",
    }),
    { valid: false, reason: "type-mismatch" },
  );
});
