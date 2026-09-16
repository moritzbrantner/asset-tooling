import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  ANIMATION_REDUCE_OPERATION,
  ANIMATION_RESAMPLE_OPERATION,
  THREE_D_ANIMATION_MEDIA_TYPE,
  createAnimationReduceOperationBuildIdentity,
  createAnimationResampleOperationBuildIdentity,
  executeAnimationReduceOperation,
  executeAnimationResampleOperation,
} from "../src/animation-processing-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(
  new URL("./fixtures/animation-process-adapter.js", import.meta.url),
);
const PROCESSOR_BASE = {
  repository: "fixture/3d-lab",
  executable: process.execPath,
  scriptPath: FIXTURE_ADAPTER,
  prefixArguments: [],
  sourceFiles: [FIXTURE_ADAPTER],
};
const RESAMPLE_PROCESSOR = { ...PROCESSOR_BASE, revision: "a".repeat(40) };
const REDUCE_PROCESSOR = { ...PROCESSOR_BASE, revision: "b".repeat(40) };

const RESAMPLE_PARAMETERS = {
  sourceStartSeconds: 0,
  sourceEndSeconds: 1,
  targetTimesSeconds: [0, 0.5, 1],
  interpolation: { translation: "linear", rotation: "slerp", scale: "linear" },
  transformSpace: "local",
};
const REDUCE_PARAMETERS = {
  translationError: 0.01,
  rotationErrorRadians: 0.01,
  scaleError: 0.01,
  transformSpace: "local",
  preserveEndpoints: true,
};

function animationDocument() {
  return {
    schemaVersion: 1,
    channels: [
      {
        kind: "translation",
        node: 0,
        keyframes: [
          { time: 0, value: [0, 0, 0] },
          { time: 0.5, value: [0.5, 0, 0] },
          { time: 1, value: [1, 0, 0] },
        ],
      },
      {
        kind: "rotation",
        node: 0,
        keyframes: [
          { time: 0, value: [0, 0, 0, 1] },
          { time: 0.5, value: [0, 0.38268343, 0, 0.9238795] },
          { time: 1, value: [0, 0.70710677, 0, 0.70710677] },
        ],
      },
      {
        kind: "scale",
        node: 0,
        keyframes: [
          { time: 0, value: [1, 1, 1] },
          { time: 0.5, value: [1.5, 1.5, 1.5] },
          { time: 1, value: [2, 2, 2] },
        ],
      },
    ],
  };
}

async function workspaceWithSource() {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-animation-operation-"));
  const bytes = Buffer.from(JSON.stringify(animationDocument()), "utf8");
  const stored = await storeAssetObject(root, {
    bytes,
    kind: "animation",
    mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
    metadata: { animationSchemaVersion: 1, channelCount: 3, keyframeCount: 9 },
  });
  return { root, source: stored.asset };
}

test("animation operations expose one typed animation input and output", () => {
  for (const [operation, id] of [
    [ANIMATION_RESAMPLE_OPERATION, "animation.resample"],
    [ANIMATION_REDUCE_OPERATION, "animation.reduce"],
  ]) {
    assert.equal(operation.id, id);
    assert.equal(operation.version, "1");
    assert.deepEqual(operation.inputs[0].assetKinds, ["animation"]);
    assert.deepEqual(operation.inputs[0].mediaTypes, [THREE_D_ANIMATION_MEDIA_TYPE]);
    assert.deepEqual(operation.outputs[0].assetKinds, ["animation"]);
    assert.deepEqual(operation.outputs[0].mediaTypes, [THREE_D_ANIMATION_MEDIA_TYPE]);
  }
});

test("animation.resample build identity binds source bytes, processor bytes, and revision", async () => {
  const { root, source } = await workspaceWithSource();
  const identity = await createAnimationResampleOperationBuildIdentity(
    root,
    { parameters: RESAMPLE_PARAMETERS, inputs: { source } },
    RESAMPLE_PROCESSOR,
  );
  assert.deepEqual(identity.operation, { id: "animation.resample", version: "1" });
  assert.equal(identity.inputs.source.sha256, source.sha256);
  assert.equal(identity.implementation.source.repository, "fixture/3d-lab");
  assert.equal(identity.implementation.source.revision, "a".repeat(40));
  assert.match(identity.implementation.source.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(identity.implementation.probe.id, "three-d-animation-resample");
  assert.equal(identity.implementation.probe.codec, "three-d-animation-json-v1");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(JSON.stringify(identity).includes(FIXTURE_ADAPTER), false);
});

test("animation.resample materializes the processor f32 parameter domain", async () => {
  const { root, source } = await workspaceWithSource();
  const identity = await createAnimationResampleOperationBuildIdentity(
    root,
    {
      parameters: {
        ...RESAMPLE_PARAMETERS,
        targetTimesSeconds: [0, 0.1, 1],
      },
      inputs: { source },
    },
    RESAMPLE_PROCESSOR,
  );
  assert.equal(identity.parameters.targetTimesSeconds[1], Math.fround(0.1));

  await assert.rejects(
    () =>
      createAnimationResampleOperationBuildIdentity(
        root,
        {
          parameters: {
            ...RESAMPLE_PARAMETERS,
            sourceEndSeconds: 2,
            targetTimesSeconds: [1, 1 + 1e-8],
          },
          inputs: { source },
        },
        RESAMPLE_PROCESSOR,
      ),
    /strictly increasing after f32 normalization/,
  );
});

test("animation.resample validates and stores a deterministic explicit time-grid result", async () => {
  const { root, source } = await workspaceWithSource();
  const invocation = { parameters: RESAMPLE_PARAMETERS, inputs: { source } };
  const first = await executeAnimationResampleOperation(root, invocation, RESAMPLE_PROCESSOR);
  const second = await executeAnimationResampleOperation(root, invocation, RESAMPLE_PROCESSOR);
  assert.equal(first.outputs.output.kind, "animation");
  assert.equal(first.outputs.output.mediaType, THREE_D_ANIMATION_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.animationSchemaVersion, 1);
  assert.equal(first.outputs.output.metadata.channelCount, 3);
  assert.equal(first.outputs.output.metadata.keyframeCount, 9);
  assert.equal(first.outputs.output.metadata.sourceSha256, source.sha256);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.deepEqual(first.observations, {
    sourceKeyframeCount: 9,
    resultKeyframeCount: 9,
    channelCount: 3,
    durationSeconds: 1,
  });
  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.deepEqual(
    output.channels.map((channel) => channel.keyframes.map((keyframe) => keyframe.time)),
    [
      [0, 0.5, 1],
      [0, 0.5, 1],
      [0, 0.5, 1],
    ],
  );
});

test("animation.reduce binds its own processor identity and retains only source keys", async () => {
  const { root, source } = await workspaceWithSource();
  const invocation = { parameters: REDUCE_PARAMETERS, inputs: { source } };
  const identity = await createAnimationReduceOperationBuildIdentity(
    root,
    invocation,
    REDUCE_PROCESSOR,
  );
  assert.deepEqual(identity.operation, { id: "animation.reduce", version: "1" });
  assert.equal(identity.implementation.source.repository, "fixture/3d-lab");
  assert.equal(identity.implementation.source.revision, "b".repeat(40));
  assert.match(identity.implementation.source.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(identity.implementation.probe.id, "three-d-animation-reduce");
  assert.equal(identity.parameters.translationError, Math.fround(0.01));
  assert.equal(identity.parameters.rotationErrorRadians, Math.fround(0.01));
  assert.equal(identity.parameters.scaleError, Math.fround(0.01));

  const result = await executeAnimationReduceOperation(root, invocation, REDUCE_PROCESSOR);
  assert.equal(result.outputs.output.metadata.keyframeCount, 6);
  assert.deepEqual(result.observations, {
    sourceKeyframeCount: 9,
    resultKeyframeCount: 6,
    maxTranslationError: 0,
    maxRotationErrorRadians: 0,
    maxScaleError: 0,
    endpointsPreserved: true,
  });
  const output = JSON.parse((await resolveAssetObject(root, result.outputs.output)).toString("utf8"));
  assert.deepEqual(
    output.channels.map((channel) => channel.keyframes.map((keyframe) => keyframe.time)),
    [
      [0, 1],
      [0, 1],
      [0, 1],
    ],
  );
});

test("animation processing validates parameters and source object presence before generation", async () => {
  const { root, source } = await workspaceWithSource();
  await assert.rejects(
    () =>
      executeAnimationResampleOperation(
        root,
        {
          parameters: {
            ...RESAMPLE_PARAMETERS,
            interpolation: { ...RESAMPLE_PARAMETERS.interpolation, rotation: "linear" },
          },
          inputs: { source },
        },
        RESAMPLE_PROCESSOR,
      ),
    /requires linear translation\/scale and slerp rotation interpolation/,
  );
  await assert.rejects(
    () =>
      executeAnimationReduceOperation(
        root,
        { parameters: { ...REDUCE_PARAMETERS, translationError: -1 }, inputs: { source } },
        REDUCE_PROCESSOR,
      ),
    /translationError must be a finite non-negative number/,
  );

  const missing = { ...source, sha256: "c".repeat(64) };
  await assert.rejects(
    () =>
      executeAnimationReduceOperation(
        root,
        { parameters: REDUCE_PARAMETERS, inputs: { source: missing } },
        REDUCE_PROCESSOR,
      ),
    /asset object '[0-9a-f]{64}' is missing/,
  );
});

test("animation codec rejects negative or f32-colliding source times before processor execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-animation-invalid-time-"));
  const negative = animationDocument();
  negative.channels[0].keyframes[0].time = -1;
  const negativeStored = await storeAssetObject(root, {
    bytes: Buffer.from(JSON.stringify(negative), "utf8"),
    kind: "animation",
    mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
    metadata: {},
  });
  await assert.rejects(
    () =>
      executeAnimationReduceOperation(
        root,
        { parameters: REDUCE_PARAMETERS, inputs: { source: negativeStored.asset } },
        REDUCE_PROCESSOR,
      ),
    /must be a finite non-negative number/,
  );

  const collision = animationDocument();
  collision.channels[0].keyframes[1].time = 1;
  collision.channels[0].keyframes[2].time = 1 + 1e-8;
  const collisionStored = await storeAssetObject(root, {
    bytes: Buffer.from(JSON.stringify(collision), "utf8"),
    kind: "animation",
    mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
    metadata: {},
  });
  await assert.rejects(
    () =>
      executeAnimationReduceOperation(
        root,
        { parameters: REDUCE_PARAMETERS, inputs: { source: collisionStored.asset } },
        REDUCE_PROCESSOR,
      ),
    /strictly increasing after f32 normalization/,
  );
});
