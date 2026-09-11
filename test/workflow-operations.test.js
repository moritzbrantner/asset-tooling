import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject } from "../src/asset-store.js";
import {
  PROCEDURAL_SVG_SCATTER_OPERATION,
  executeProceduralSvgScatterOperation,
} from "../src/generation-operations.js";
import {
  MESH_SIMPLIFY_OPERATION,
  THREE_D_MESH_MEDIA_TYPE,
} from "../src/processing-operations.js";
import {
  ASSET_OPERATION_WORKFLOW_KIND,
  createAssetOperationWorkflowExecutor,
  createAssetOperationWorkflowNodeTemplate,
} from "../src/workflow-operations.js";

const SCATTER_PARAMETERS = {
  seed: "42",
  width: 96,
  height: 64,
  count: 8,
  minRadius: 2,
  maxRadius: 6,
  background: "#101418",
  palette: ["#ffcc00", "#3366ff", "#33aa66"],
};

test("workflow template projects operation identity, category, and exact asset type", () => {
  const template = createAssetOperationWorkflowNodeTemplate(PROCEDURAL_SVG_SCATTER_OPERATION, {
    parameters: SCATTER_PARAMETERS,
  });

  assert.equal(template.id, "asset-operation:procedural.svg.scatter@1");
  assert.equal(template.kind, ASSET_OPERATION_WORKFLOW_KIND);
  assert.equal(template.category, "Assets / Procedural / Vector");
  assert.deepEqual(template.data, {
    assetOperation: {
      id: "procedural.svg.scatter",
      version: "1",
      parameters: SCATTER_PARAMETERS,
    },
  });
  assert.equal(template.outputs[0].type.kind, "object");
  assert.deepEqual(template.outputs[0].type.properties.kind.type, {
    kind: "literal",
    value: "vector-image",
  });
  assert.deepEqual(template.outputs[0].type.properties.mediaType.type, {
    kind: "literal",
    value: "image/svg+xml",
  });
});

test("workflow template preserves mesh constraints without inventing workflow connection cardinality", () => {
  const template = createAssetOperationWorkflowNodeTemplate(MESH_SIMPLIFY_OPERATION);
  const source = template.inputs[0];

  assert.equal(source.id, "source");
  assert.equal(source.optional, undefined);
  assert.equal(Object.hasOwn(source, "cardinality"), false);
  assert.deepEqual(source.type.properties.kind.type, { kind: "literal", value: "mesh" });
  assert.deepEqual(source.type.properties.mediaType.type, {
    kind: "literal",
    value: THREE_D_MESH_MEDIA_TYPE,
  });
});

test("asset value cardinality projects to array values, not multiple workflow edges", () => {
  const template = createAssetOperationWorkflowNodeTemplate({
    schemaVersion: 1,
    id: "image.compose",
    version: "1",
    category: "image.composition",
    inputs: [
      {
        id: "layers",
        assetKinds: ["image"],
        mediaTypes: ["image/*"],
        cardinality: { min: 1, max: 8 },
      },
    ],
    outputs: [],
    parameterSchema: {},
  });

  assert.equal(template.inputs[0].type.kind, "array");
  assert.equal(template.inputs[0].type.element.properties.kind.type.value, "image");
  assert.deepEqual(template.inputs[0].type.element.properties.mediaType.type, { kind: "string" });
  assert.equal(Object.hasOwn(template.inputs[0], "cardinality"), false);
});

test("workflow executor runs the registered operation and keeps observations outside workflow outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-workflow-bridge-"));
  const evidence = [];
  const executor = createAssetOperationWorkflowExecutor({
    root,
    registrations: [
      {
        operation: PROCEDURAL_SVG_SCATTER_OPERATION,
        execute: executeProceduralSvgScatterOperation,
      },
    ],
    onOperationResult: (entry) => evidence.push(entry),
  });
  const template = createAssetOperationWorkflowNodeTemplate(PROCEDURAL_SVG_SCATTER_OPERATION, {
    parameters: SCATTER_PARAMETERS,
  });

  const execution = await executor({
    runId: "run-1",
    node: { id: "scatter", label: template.label, kind: template.kind, data: template.data },
    inputs: {},
    workflowInput: {},
    context: {},
  });

  assert.deepEqual(Object.keys(execution.outputs), ["output"]);
  assert.equal(Object.hasOwn(execution.outputs, "observations"), false);
  assert.equal(execution.outputs.output.kind, "vector-image");
  assert.match((await resolveAssetObject(root, execution.outputs.output)).toString("utf8"), /^<svg /);
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0].operation, { id: "procedural.svg.scatter", version: "1" });
  assert.equal(evidence[0].result.observations.algorithm, "svg-scatter-v1");
});

test("workflow executor rejects an operation that was not registered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-workflow-bridge-"));
  const executor = createAssetOperationWorkflowExecutor({ root, registrations: [] });
  const template = createAssetOperationWorkflowNodeTemplate(PROCEDURAL_SVG_SCATTER_OPERATION, {
    parameters: SCATTER_PARAMETERS,
  });

  await assert.rejects(
    () =>
      executor({
        runId: "run-missing",
        node: { id: "scatter", kind: template.kind, data: template.data },
        inputs: {},
        workflowInput: {},
        context: {},
      }),
    /procedural\.svg\.scatter@1.*not registered/,
  );
});
