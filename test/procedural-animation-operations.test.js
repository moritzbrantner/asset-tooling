import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject } from "../src/asset-store.js";
import {
  THREE_D_ANIMATION_MEDIA_TYPE,
  executeAnimationResampleOperation,
} from "../src/animation-processing-operations.js";
import {
  PROCEDURAL_ANIMATION_OPERATIONS,
  createProceduralTranslationAnimationOperationBuildIdentity,
  executeProceduralTranslationAnimationOperation,
  executeProceduralUniformScaleAnimationOperation,
  executeProceduralYawAnimationOperation,
} from "../src/procedural-animation-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(
  new URL("./fixtures/animation-process-adapter.js", import.meta.url),
);
const RESAMPLE_PROCESSOR = {
  repository: "fixture/3d-lab",
  revision: "c".repeat(40),
  executable: process.execPath,
  scriptPath: FIXTURE_ADAPTER,
  prefixArguments: [],
  sourceFiles: [FIXTURE_ADAPTER],
};

async function workspace(name) {
  return mkdtemp(path.join(os.tmpdir(), `asset-tooling-${name}-`));
}

async function readDocument(root, asset) {
  return JSON.parse((await resolveAssetObject(root, asset)).toString("utf8"));
}

test("procedural animation registry exposes focused source-clip operations", () => {
  assert.deepEqual(
    PROCEDURAL_ANIMATION_OPERATIONS.map((operation) => operation.id),
    [
      "animation.procedural.translation",
      "animation.procedural.uniform-scale",
      "animation.procedural.yaw",
    ],
  );
  for (const operation of PROCEDURAL_ANIMATION_OPERATIONS) {
    assert.deepEqual(operation.inputs, []);
    assert.deepEqual(operation.outputs[0].assetKinds, ["animation"]);
    assert.deepEqual(operation.outputs[0].mediaTypes, [THREE_D_ANIMATION_MEDIA_TYPE]);
  }
});

test("translation animation is f32-normalized, content-addressed, and idempotent", async () => {
  const root = await workspace("procedural-translation");
  const invocation = {
    parameters: {
      node: 3,
      durationSeconds: 0.1,
      from: [0, -0, 0.1],
      to: [2, 3, 4],
    },
    inputs: {},
  };
  const identity = await createProceduralTranslationAnimationOperationBuildIdentity(root, invocation);
  assert.equal(identity.parameters.durationSeconds, Math.fround(0.1));
  assert.deepEqual(identity.parameters.from, [0, 0, Math.fround(0.1)]);
  assert.equal(identity.implementation.codec, "three-d-animation-json-v1");
  assert.equal(identity.implementation.transformSpace, "local");
  assert.equal(identity.implementation.randomness, "none");

  const first = await executeProceduralTranslationAnimationOperation(root, invocation);
  const second = await executeProceduralTranslationAnimationOperation(root, invocation);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "animation");
  assert.equal(first.outputs.output.mediaType, THREE_D_ANIMATION_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.channelCount, 1);
  assert.equal(first.outputs.output.metadata.keyframeCount, 2);
  assert.equal(first.outputs.output.metadata.transformSpace, "local");

  assert.deepEqual(await readDocument(root, first.outputs.output), {
    schemaVersion: 1,
    channels: [
      {
        kind: "translation",
        node: 3,
        keyframes: [
          { time: 0, value: [0, 0, Math.fround(0.1)] },
          { time: Math.fround(0.1), value: [2, 3, 4] },
        ],
      },
    ],
  });
});

test("yaw and uniform-scale generators make rotation and scale channel mechanics explicit", async () => {
  const root = await workspace("procedural-transform-channels");
  const yaw = await executeProceduralYawAnimationOperation(root, {
    parameters: { node: 1, durationSeconds: 2, yawDegrees: 90 },
    inputs: {},
  });
  const scale = await executeProceduralUniformScaleAnimationOperation(root, {
    parameters: { node: 2, durationSeconds: 2, fromScale: 1, toScale: 1.5 },
    inputs: {},
  });

  const yawDocument = await readDocument(root, yaw.outputs.output);
  assert.deepEqual(yawDocument.channels[0], {
    kind: "rotation",
    node: 1,
    keyframes: [
      { time: 0, value: [0, 0, 0, 1] },
      { time: 2, value: [0, Math.fround(Math.SQRT1_2), 0, Math.fround(Math.SQRT1_2)] },
    ],
  });
  assert.deepEqual((await readDocument(root, scale.outputs.output)).channels[0], {
    kind: "scale",
    node: 2,
    keyframes: [
      { time: 0, value: [1, 1, 1] },
      { time: 2, value: [1.5, 1.5, 1.5] },
    ],
  });
});

test("generated source clips pass directly into the authoritative animation processing boundary", async () => {
  const root = await workspace("procedural-animation-processing");
  const generated = await executeProceduralTranslationAnimationOperation(root, {
    parameters: { node: 0, durationSeconds: 1, from: [0, 0, 0], to: [1, 0, 0] },
    inputs: {},
  });
  const resampled = await executeAnimationResampleOperation(
    root,
    {
      parameters: {
        sourceStartSeconds: 0,
        sourceEndSeconds: 1,
        targetTimesSeconds: [0, 0.5, 1],
        interpolation: { translation: "linear", rotation: "slerp", scale: "linear" },
        transformSpace: "local",
      },
      inputs: { source: generated.outputs.output },
    },
    RESAMPLE_PROCESSOR,
  );
  assert.equal(resampled.outputs.output.metadata.channelCount, 1);
  assert.equal(resampled.outputs.output.metadata.keyframeCount, 3);
  assert.deepEqual(
    (await readDocument(root, resampled.outputs.output)).channels[0].keyframes.map((keyframe) => keyframe.time),
    [0, 0.5, 1],
  );
});

test("procedural animation generation fails closed on ambiguous or invalid source mechanics", async () => {
  const root = await workspace("procedural-animation-invalid");
  await assert.rejects(
    () => executeProceduralTranslationAnimationOperation(root, {
      parameters: { node: 0, durationSeconds: 0, from: [0, 0, 0], to: [1, 0, 0] },
      inputs: {},
    }),
    /durationSeconds must be positive/,
  );
  await assert.rejects(
    () => executeProceduralYawAnimationOperation(root, {
      parameters: { node: 0, durationSeconds: 1, yawDegrees: 45 },
      inputs: {},
    }),
    /yawDegrees must be one of -180, -90, 90, 180/,
  );
  await assert.rejects(
    () => executeProceduralUniformScaleAnimationOperation(root, {
      parameters: { node: 0, durationSeconds: 1, fromScale: 1, toScale: 0 },
      inputs: {},
    }),
    /toScale must be positive/,
  );
});
