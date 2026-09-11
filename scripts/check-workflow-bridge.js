import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  AUDIO_GAIN_OPERATION,
  AUDIO_MIX_OPERATION,
  AUDIO_SYNTHESIZE_OPERATION,
  executeAudioGainOperation,
  executeAudioMixOperation,
  executeAudioSynthesizeOperation,
} from "../src/audio-operations.js";
import { assertCanonicalAudioBytes } from "../src/audio.js";
import {
  PROCEDURAL_SVG_SCATTER_OPERATION,
  executeProceduralSvgScatterOperation,
} from "../src/generation-operations.js";
import {
  MESH_SIMPLIFY_OPERATION,
  THREE_D_MESH_MEDIA_TYPE,
  executeMeshSimplifyOperation,
} from "../src/processing-operations.js";
import {
  ASSET_OPERATION_WORKFLOW_KIND,
  createAssetOperationWorkflowConnectionValidator,
  createAssetOperationWorkflowExecutor,
  createAssetOperationWorkflowNodeTemplate,
} from "../src/workflow-operations.js";

const [editorCheckout, runnerCheckout, editorRevision, runnerRevision] = process.argv.slice(2);
for (const [value, name] of [
  [editorCheckout, "workflow-editor checkout"],
  [runnerCheckout, "workflow-runner checkout"],
]) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}
for (const [value, name] of [
  [editorRevision, "workflow-editor revision"],
  [runnerRevision, "workflow-runner revision"],
]) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new Error(`${name} must be an exact Git SHA`);
}

const workflowStack = JSON.parse(
  await Bun.file(new URL("../stability/workflow-stack.json", import.meta.url)).text(),
);
assert.equal(workflowStack.editor.commit, editorRevision);
assert.equal(workflowStack.runner.commit, runnerRevision);

const editor = await import(pathToFileURL(path.join(editorCheckout, "src", "index.ts")).href);
const {
  addWorkflowEditorArrayConstructorInputToNode,
  compileWorkflowEditorDocument,
  workflowEditorControlFlowNodeTemplates,
  workflowEditorJsonNodeTemplates,
} = editor;
const { validateWorkflowEditorConnectionWithCardinality } = await import(
  pathToFileURL(path.join(editorCheckout, "src", "cardinality.ts")).href
);
const { createWorkflowRunner } = await import(
  pathToFileURL(path.join(runnerCheckout, "src", "index.ts")).href
);

const validateAssetWorkflowConnection = createAssetOperationWorkflowConnectionValidator(
  validateWorkflowEditorConnectionWithCardinality,
);

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
const SIMPLIFY_PARAMETERS = {
  sourceTriangleCount: 8,
  targetTriangleCount: 4,
  targetError: 1,
  lockBorder: false,
};
const SYNTH_A_PARAMETERS = {
  waveform: "square",
  sampleRate: 8000,
  channels: 1,
  frameCount: 800,
  frequencyHz: 440,
  amplitude: 4000,
};
const SYNTH_B_PARAMETERS = {
  waveform: "saw",
  sampleRate: 8000,
  channels: 1,
  frameCount: 800,
  frequencyHz: 220,
  amplitude: 2000,
};
const GAIN_PARAMETERS = {
  numerator: 1,
  denominator: 2,
};
const MIX_PARAMETERS = {
  tracks: [
    { startFrame: 0, gainNumerator: 1, gainDenominator: 1 },
    { startFrame: 80, gainNumerator: 1, gainDenominator: 1 },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nodeFromTemplate(template, id, x, y) {
  return {
    id,
    label: template.label,
    kind: template.kind,
    x,
    y,
    ...(template.inputs ? { inputs: clone(template.inputs) } : {}),
    ...(template.outputs ? { outputs: clone(template.outputs) } : {}),
    ...(template.data ? { data: clone(template.data) } : {}),
  };
}

function sourceMeshDocument() {
  return {
    schemaVersion: 1,
    vertices: [
      [0, 0, 0], [1, 0, 0], [2, 0, 0],
      [0, 1, 0], [1, 1, 0], [2, 1, 0],
      [0, 2, 0], [1, 2, 0], [2, 2, 0],
    ],
    indices: [
      0, 1, 3, 1, 4, 3,
      1, 2, 4, 2, 5, 4,
      3, 4, 6, 4, 7, 6,
      4, 5, 7, 5, 8, 7,
    ],
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-workflow-stack-"));
const generatorTemplate = createAssetOperationWorkflowNodeTemplate(
  PROCEDURAL_SVG_SCATTER_OPERATION,
  { parameters: SCATTER_PARAMETERS },
);
const processorTemplate = createAssetOperationWorkflowNodeTemplate(MESH_SIMPLIFY_OPERATION, {
  parameters: SIMPLIFY_PARAMETERS,
});

assert.equal(generatorTemplate.kind, ASSET_OPERATION_WORKFLOW_KIND);
assert.equal(processorTemplate.kind, ASSET_OPERATION_WORKFLOW_KIND);
assert.deepEqual(generatorTemplate.outputs[0].type.properties.kind.type, {
  kind: "literal",
  value: "vector-image",
});
assert.deepEqual(processorTemplate.inputs[0].type.properties.kind.type, {
  kind: "literal",
  value: "mesh",
});

const incompatibleDocument = {
  nodes: [
    nodeFromTemplate(generatorTemplate, "generate", 0, 0),
    nodeFromTemplate(processorTemplate, "simplify", 240, 0),
  ],
  edges: [],
};
const incompatibleConnection = {
  sourceNodeId: "generate",
  sourcePortId: "output",
  targetNodeId: "simplify",
  targetPortId: "source",
};
assert.deepEqual(
  validateAssetWorkflowConnection(incompatibleDocument, incompatibleConnection),
  { valid: false, reason: "type-mismatch" },
);

const audioTemplate = createAssetOperationWorkflowNodeTemplate({
  schemaVersion: 1,
  id: "fixture.audio.source",
  version: "1",
  category: "fixture",
  inputs: [],
  outputs: [{ id: "output", assetKinds: ["media"], mediaTypes: ["audio/*"] }],
  parameterSchema: {},
});
const imageTemplate = createAssetOperationWorkflowNodeTemplate({
  schemaVersion: 1,
  id: "fixture.image.sink",
  version: "1",
  category: "fixture",
  inputs: [{ id: "source", assetKinds: ["media"], mediaTypes: ["image/*"] }],
  outputs: [],
  parameterSchema: {},
});
const wildcardDocument = {
  nodes: [
    nodeFromTemplate(audioTemplate, "audio", 0, 0),
    nodeFromTemplate(imageTemplate, "image", 240, 0),
  ],
  edges: [],
};
const wildcardConnection = {
  sourceNodeId: "audio",
  sourcePortId: "output",
  targetNodeId: "image",
  targetPortId: "source",
};
assert.deepEqual(
  validateWorkflowEditorConnectionWithCardinality(wildcardDocument, wildcardConnection),
  { valid: true },
);
assert.deepEqual(validateAssetWorkflowConnection(wildcardDocument, wildcardConnection), {
  valid: false,
  reason: "type-mismatch",
});

const evidence = [];
const fixtureAdapter = fileURLToPath(
  new URL("../test/fixtures/mesh-process-adapter.js", import.meta.url),
);
const fixtureProcessor = {
  repository: "fixture/three-d-lod",
  revision: "f".repeat(40),
  executable: process.execPath,
  scriptPath: fixtureAdapter,
  prefixArguments: [],
};
const assetExecutor = createAssetOperationWorkflowExecutor({
  root,
  registrations: [
    {
      operation: PROCEDURAL_SVG_SCATTER_OPERATION,
      execute: executeProceduralSvgScatterOperation,
    },
    {
      operation: MESH_SIMPLIFY_OPERATION,
      execute: (workspaceRoot, invocation) =>
        executeMeshSimplifyOperation(workspaceRoot, invocation, fixtureProcessor),
    },
  ],
  onOperationResult: (entry) => evidence.push(entry),
});
const runner = createWorkflowRunner({
  executors: { [ASSET_OPERATION_WORKFLOW_KIND]: assetExecutor },
});

const generatedWorkflow = compileWorkflowEditorDocument({
  nodes: [nodeFromTemplate(generatorTemplate, "generate", 0, 0)],
  edges: [],
});
assert.deepEqual(generatedWorkflow.nodes[0].data.assetOperation, {
  id: "procedural.svg.scatter",
  version: "1",
  parameters: SCATTER_PARAMETERS,
});
const generatedRun = await runner.dispatch({
  runId: "asset-generator-workflow",
  workflow: generatedWorkflow,
});
assert.equal(generatedRun.status, "succeeded");
const generatedAsset = generatedRun.nodeResults.generate.outputs.output;
assert.equal(generatedAsset.kind, "vector-image");
assert.match((await resolveAssetObject(root, generatedAsset)).toString("utf8"), /^<svg /);

const sourceDocument = sourceMeshDocument();
const storedSource = (
  await storeAssetObject(root, {
    bytes: Buffer.from(JSON.stringify(sourceDocument), "utf8"),
    kind: "mesh",
    mediaType: THREE_D_MESH_MEDIA_TYPE,
    metadata: { meshSchemaVersion: 1, triangleCount: 8, vertexCount: 9 },
  })
).asset;
const processorNode = nodeFromTemplate(processorTemplate, "simplify", 0, 0);
processorNode.inputs[0].defaultValue = storedSource;
const processedWorkflow = compileWorkflowEditorDocument({ nodes: [processorNode], edges: [] });
const processedRun = await runner.dispatch({
  runId: "asset-processor-workflow",
  workflow: processedWorkflow,
});
assert.equal(processedRun.status, "succeeded");
const processedAsset = processedRun.nodeResults.simplify.outputs.output;
assert.equal(processedAsset.kind, "mesh");
assert.equal(processedAsset.mediaType, THREE_D_MESH_MEDIA_TYPE);
const processedDocument = JSON.parse(
  (await resolveAssetObject(root, processedAsset)).toString("utf8"),
);
assert.equal(processedDocument.indices.length, 12);

assert.equal(evidence.length, 2);
assert.deepEqual(
  evidence.map((entry) => entry.operation),
  [
    { id: "procedural.svg.scatter", version: "1" },
    { id: "mesh.simplify", version: "1" },
  ],
);
assert.equal(evidence[0].result.observations.algorithm, "svg-scatter-v1");
assert.equal(evidence[1].result.observations.resultTriangleCount, 4);
assert.equal(Object.hasOwn(generatedRun.nodeResults.generate.outputs, "observations"), false);
assert.equal(Object.hasOwn(processedRun.nodeResults.simplify.outputs, "observations"), false);

const synthATemplate = createAssetOperationWorkflowNodeTemplate(AUDIO_SYNTHESIZE_OPERATION, {
  parameters: SYNTH_A_PARAMETERS,
});
const synthBTemplate = createAssetOperationWorkflowNodeTemplate(AUDIO_SYNTHESIZE_OPERATION, {
  parameters: SYNTH_B_PARAMETERS,
});
const gainTemplate = createAssetOperationWorkflowNodeTemplate(AUDIO_GAIN_OPERATION, {
  parameters: GAIN_PARAMETERS,
});
const mixTemplate = createAssetOperationWorkflowNodeTemplate(AUDIO_MIX_OPERATION, {
  parameters: MIX_PARAMETERS,
});
const arrayTemplate = workflowEditorJsonNodeTemplates.find((template) => template.kind === "json.array");
const endTemplate = workflowEditorControlFlowNodeTemplates.find((template) => template.kind === "control.end");
assert.ok(arrayTemplate, "pinned workflow-editor must expose json.array");
assert.ok(endTemplate, "pinned workflow-editor must expose control.end");

const synthANode = nodeFromTemplate(synthATemplate, "synth-a", 0, 0);
const synthBNode = nodeFromTemplate(synthBTemplate, "synth-b", 0, 180);
const gainNode = nodeFromTemplate(gainTemplate, "gain-a", 240, 0);
let arrayNode = nodeFromTemplate(arrayTemplate, "sources", 480, 80);
arrayNode = addWorkflowEditorArrayConstructorInputToNode(arrayNode, {
  portId: "gain-source",
  sourceNodeId: "gain-a",
  sourcePortId: "output",
  type: clone(gainTemplate.outputs[0].type),
});
arrayNode = addWorkflowEditorArrayConstructorInputToNode(arrayNode, {
  portId: "synth-b-source",
  sourceNodeId: "synth-b",
  sourcePortId: "output",
  type: clone(synthBTemplate.outputs[0].type),
});
arrayNode.outputs[0].type = clone(mixTemplate.inputs[0].type);
const mixNode = nodeFromTemplate(mixTemplate, "mix", 720, 80);
const endNode = nodeFromTemplate(endTemplate, "export", 960, 80);
endNode.inputs[0].type = clone(mixTemplate.outputs[0].type);

const referenceConnections = [
  {
    id: "ref-synth-gain",
    sourceNodeId: "synth-a",
    sourcePortId: "output",
    targetNodeId: "gain-a",
    targetPortId: "source",
  },
  {
    id: "ref-gain-array",
    sourceNodeId: "gain-a",
    sourcePortId: "output",
    targetNodeId: "sources",
    targetPortId: "gain-source",
  },
  {
    id: "ref-synth-b-array",
    sourceNodeId: "synth-b",
    sourcePortId: "output",
    targetNodeId: "sources",
    targetPortId: "synth-b-source",
  },
  {
    id: "ref-array-mix",
    sourceNodeId: "sources",
    sourcePortId: "value",
    targetNodeId: "mix",
    targetPortId: "sources",
  },
  {
    id: "ref-mix-export",
    sourceNodeId: "mix",
    sourcePortId: "output",
    targetNodeId: "export",
    targetPortId: "in",
  },
];
const referenceDocument = {
  nodes: [synthANode, synthBNode, gainNode, arrayNode, mixNode, endNode],
  edges: [],
};
for (const connection of referenceConnections) {
  assert.deepEqual(
    validateAssetWorkflowConnection(referenceDocument, connection),
    { valid: true },
    `reference workflow connection ${connection.id} must be valid`,
  );
  referenceDocument.edges.push(connection);
}

const referenceWorkflow = compileWorkflowEditorDocument(referenceDocument);
const compiledArray = referenceWorkflow.nodes.find((node) => node.id === "sources");
assert.ok(compiledArray);
assert.deepEqual(
  compiledArray.inputs.filter((input) => input.id !== "item-add").map((input) => input.id),
  ["gain-source", "synth-b-source"],
);

const referenceEvidence = [];
const referenceAssetExecutor = createAssetOperationWorkflowExecutor({
  root,
  registrations: [
    { operation: AUDIO_SYNTHESIZE_OPERATION, execute: executeAudioSynthesizeOperation },
    { operation: AUDIO_GAIN_OPERATION, execute: executeAudioGainOperation },
    { operation: AUDIO_MIX_OPERATION, execute: executeAudioMixOperation },
  ],
  onOperationResult: (entry) => referenceEvidence.push(entry),
});
const referenceRunner = createWorkflowRunner({
  executors: { [ASSET_OPERATION_WORKFLOW_KIND]: referenceAssetExecutor },
});
const firstReferenceRun = await referenceRunner.dispatch({
  runId: "reference-audio-workflow-1",
  workflow: referenceWorkflow,
});
const secondReferenceRun = await referenceRunner.dispatch({
  runId: "reference-audio-workflow-2",
  workflow: referenceWorkflow,
});
assert.equal(firstReferenceRun.status, "succeeded");
assert.equal(secondReferenceRun.status, "succeeded");
assert.equal(firstReferenceRun.output.kind, "audio");
assert.equal(secondReferenceRun.output.sha256, firstReferenceRun.output.sha256);
assert.equal(firstReferenceRun.nodeResults.mix.outputs.output.sha256, firstReferenceRun.output.sha256);
assert.equal(Object.hasOwn(firstReferenceRun.nodeResults.mix.outputs, "observations"), false);

const finalBytes = await resolveAssetObject(root, firstReferenceRun.output);
const finalAudio = assertCanonicalAudioBytes(finalBytes, firstReferenceRun.output.metadata);
assert.equal(finalAudio.sampleRate, 8000);
assert.equal(finalAudio.channels, 1);
assert.equal(finalAudio.samples.length, 880);

const firstGainAsset = firstReferenceRun.nodeResults["gain-a"].outputs.output;
const firstSynthBAsset = firstReferenceRun.nodeResults["synth-b"].outputs.output;
const firstMixEvidence = referenceEvidence.find(
  (entry) => entry.runId === "reference-audio-workflow-1" && entry.nodeId === "mix",
);
assert.ok(firstMixEvidence);
assert.deepEqual(firstMixEvidence.result.observations.orderedInputSha256, [
  firstGainAsset.sha256,
  firstSynthBAsset.sha256,
]);
assert.equal(firstMixEvidence.result.observations.trackCount, 2);
assert.equal(referenceEvidence.length, 8);
assert.equal(
  referenceEvidence.every((entry) => Object.hasOwn(entry.result, "observations")),
  true,
);

console.log(
  JSON.stringify({
    status: "workflow-bridge-valid",
    workflowEditor: editorRevision,
    workflowRunner: runnerRevision,
    generatorOutput: generatedAsset.sha256,
    processorOutput: processedAsset.sha256,
    referenceWorkflow: {
      finalOutput: firstReferenceRun.output.sha256,
      sampleRate: finalAudio.sampleRate,
      channels: finalAudio.channels,
      frameCount: finalAudio.samples.length,
      operationEvidenceEvents: referenceEvidence.length,
    },
    evidenceEvents: evidence.length,
  }),
);
