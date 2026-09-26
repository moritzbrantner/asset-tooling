import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  THREE_D_ANIMATION_MEDIA_TYPE,
  createAnimationReduceOperationBuildIdentity,
  createAnimationResampleOperationBuildIdentity,
  executeAnimationReduceOperation,
  executeAnimationResampleOperation,
} from "../src/animation-processing-operations.js";
import {
  THREE_D_LOD_CHAIN_MEDIA_TYPE,
  THREE_D_MESH_MEDIA_TYPE,
  createMeshLodChainOperationBuildIdentity,
  createMeshSimplifyOperationBuildIdentity,
  executeMeshLodChainOperation,
  executeMeshSimplifyOperation,
} from "../src/processing-operations.js";
import {
  THREE_D_SKINNING_MEDIA_TYPE,
  createMeshSkinningValidateOperationBuildIdentity,
  executeMeshSkinningValidateOperation,
} from "../src/skinning-processing-operations.js";
import {
  THREE_D_RIGGED_COLLISION_INPUT_MEDIA_TYPE,
  THREE_D_RIGGED_COLLISION_MEDIA_TYPE,
  createMeshRiggedCollisionFitOperationBuildIdentity,
  executeMeshRiggedCollisionFitOperation,
} from "../src/rigged-collision-processing-operations.js";

const [processorCheckout, revision, repository, manifestRelativePath, operation] = process.argv.slice(2);
if (!processorCheckout || !path.isAbsolute(processorCheckout)) {
  throw new Error("processor checkout must be an absolute path");
}
if (!/^[0-9a-f]{40}$/.test(revision ?? "")) {
  throw new Error("processor revision must be an exact lowercase Git commit SHA");
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
  throw new Error("processor repository must use owner/repository form");
}
if (
  !manifestRelativePath ||
  path.isAbsolute(manifestRelativePath) ||
  manifestRelativePath.includes("\\") ||
  manifestRelativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
) {
  throw new Error("processor manifest path must be a normalized portable relative path");
}
const supportedOperations = new Set([
  "mesh.simplify",
  "mesh.lod_chain",
  "mesh.skinning.validate",
  "mesh.rigged-collision.fit",
  "animation.resample",
  "animation.reduce",
]);
if (!supportedOperations.has(operation)) {
  throw new Error(
    "processor contract proof supports mesh.simplify, mesh.lod_chain, mesh.skinning.validate, mesh.rigged-collision.fit, animation.resample, and animation.reduce",
  );
}

const manifestPath = path.join(processorCheckout, ...manifestRelativePath.split("/"));
const fetchProcess = Bun.spawn(["cargo", "fetch", "--manifest-path", manifestPath], {
  cwd: processorCheckout,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await fetchProcess.exited) !== 0) {
  throw new Error("explicit processor dependency acquisition failed");
}
const prefixArguments = ["--quiet", "--offline", "--manifest-path", manifestPath];
if (operation === "mesh.lod_chain") prefixArguments.push("--bin", "lod_chain");
if (operation === "animation.reduce") prefixArguments.push("--bin", "animation_reduce");
prefixArguments.push("--");
const verifiedCheckoutOperation =
  operation.startsWith("animation.") ||
  operation === "mesh.skinning.validate" ||
  operation === "mesh.rigged-collision.fit";
const processor = {
  repository,
  revision,
  executable: "cargo",
  scriptPath: "run",
  prefixArguments,
  ...(verifiedCheckoutOperation ? { checkoutRoot: processorCheckout } : {}),
};
const meshSource = { repository, revision };
const verifiedSource = { repository, revision, verification: "git-clean-exact-head" };

function gridMesh(segments) {
  const vertices = [];
  const indices = [];
  for (let y = 0; y <= segments; y += 1) {
    for (let x = 0; x <= segments; x += 1) {
      vertices.push([x / segments, y / segments, 0]);
    }
  }
  const stride = segments + 1;
  for (let y = 0; y < segments; y += 1) {
    for (let x = 0; x < segments; x += 1) {
      const topLeft = y * stride + x;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft);
    }
  }
  return { schemaVersion: 1, vertices, indices };
}

async function storedMeshSource(root) {
  const sourceDocument = gridMesh(8);
  const sourceTriangleCount = sourceDocument.indices.length / 3;
  const sourceBytes = Buffer.from(JSON.stringify(sourceDocument), "utf8");
  const source = (
    await storeAssetObject(root, {
      bytes: sourceBytes,
      kind: "mesh",
      mediaType: THREE_D_MESH_MEDIA_TYPE,
      metadata: {
        meshSchemaVersion: 1,
        triangleCount: sourceTriangleCount,
        vertexCount: sourceDocument.vertices.length,
      },
    })
  ).asset;
  return { sourceDocument, sourceTriangleCount, source };
}

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

async function storedAnimationSource(root) {
  const sourceDocument = animationDocument();
  const sourceBytes = Buffer.from(JSON.stringify(sourceDocument), "utf8");
  const source = (
    await storeAssetObject(root, {
      bytes: sourceBytes,
      kind: "animation",
      mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
      metadata: { animationSchemaVersion: 1, channelCount: 3, keyframeCount: 9 },
    })
  ).asset;
  return { sourceDocument, source };
}

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function translatedY(value) {
  const matrix = [...IDENTITY];
  matrix[13] = value;
  return matrix;
}

function skinningDocument() {
  return {
    schemaVersion: 1,
    joints: [
      { parent: null, inverseBind: IDENTITY, bindWorld: IDENTITY },
      { parent: 0, inverseBind: translatedY(-1), bindWorld: translatedY(1) },
    ],
    influences: [
      { joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] },
      { joints: [0, 1, 0, 0], weights: [1, 3, 0, 0] },
    ],
  };
}

async function storedSkinningSource(root) {
  const sourceDocument = skinningDocument();
  const source = (
    await storeAssetObject(root, {
      bytes: Buffer.from(JSON.stringify(sourceDocument), "utf8"),
      kind: "skinning",
      mediaType: THREE_D_SKINNING_MEDIA_TYPE,
      metadata: { skinningSchemaVersion: 1, jointCount: 2, vertexInfluenceCount: 2 },
    })
  ).asset;
  return { sourceDocument, source };
}

function riggedCollisionDocument() {
  const positions = [];
  for (const x of [-0.2, 0.2]) {
    for (const y of [-1, 1]) {
      for (const z of [-0.2, 0.2]) {
        positions.push([x, y, z]);
      }
    }
  }
  return {
    schemaVersion: 1,
    positions,
    joints: [{ parent: null, inverseBind: IDENTITY }],
    influences: positions.map(() => ({
      joints: [0, 0, 0, 0],
      weights: [1, 0, 0, 0],
    })),
  };
}

async function storedRiggedCollisionSource(root) {
  const sourceDocument = riggedCollisionDocument();
  const source = (
    await storeAssetObject(root, {
      bytes: Buffer.from(JSON.stringify(sourceDocument), "utf8"),
      kind: "rigged-mesh",
      mediaType: THREE_D_RIGGED_COLLISION_INPUT_MEDIA_TYPE,
      metadata: {
        riggedCollisionSchemaVersion: 1,
        jointCount: 1,
        vertexCount: sourceDocument.positions.length,
      },
    })
  ).asset;
  return { sourceDocument, source };
}

async function checkSimplify(root) {
  const { sourceDocument, sourceTriangleCount, source } = await storedMeshSource(root);
  const invocation = {
    parameters: {
      sourceTriangleCount,
      targetTriangleCount: Math.floor(sourceTriangleCount / 2),
      targetError: 1,
      lockBorder: false,
    },
    inputs: { source },
  };

  const identity = await createMeshSimplifyOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assert.deepEqual(identity.implementation.source, meshSource);
  assert.equal(identity.implementation.probe.id, "three-d-lod");
  assert.equal(identity.implementation.probe.algorithm, "meshopt-0.6.2");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-mesh-json-v1");
  assert.equal(identity.implementation.probe.dependencies.meshopt, "0.6.2");
  assert.match(identity.implementation.probe.cargoLock, /name = "meshopt"/);
  assert.match(identity.implementation.probe.cargoLock, /version = "0\.6\.2"/);
  assert.match(identity.implementation.probe.cargoLock, /name = "serde_json"/);

  const first = await executeMeshSimplifyOperation(root, invocation, processor);
  const second = await executeMeshSimplifyOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.observations.sourceTriangleCount, sourceTriangleCount);
  assert.equal(first.observations.requestedTriangleCount, invocation.parameters.targetTriangleCount);
  assert.ok(first.observations.resultTriangleCount <= sourceTriangleCount);
  assert.equal(first.observations.resultIndexCount, first.observations.resultTriangleCount * 3);
  assert.ok(first.observations.relativeError <= invocation.parameters.targetError);
  assert.equal(first.observations.sharedSourceVertexBuffer, true);

  const outputBytes = await resolveAssetObject(root, first.outputs.output);
  const output = JSON.parse(outputBytes.toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.deepEqual(output.vertices, sourceDocument.vertices);
  assert.equal(output.indices.length, first.observations.resultIndexCount);

  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    sourceTriangleCount,
    resultTriangleCount: first.observations.resultTriangleCount,
  };
}

async function checkLodChain(root) {
  const { sourceDocument, sourceTriangleCount, source } = await storedMeshSource(root);
  const levels = [0.75, 0.5, 0.25].map((triangleRatio) => ({
    triangleRatio,
    targetTriangleCount: Math.round(sourceTriangleCount * triangleRatio),
    targetError: 1,
    lockBorder: false,
  }));
  const invocation = {
    parameters: {
      sourceTriangleCount,
      sourceBased: true,
      budgetRounding: "nearest-ties-away-from-zero",
      levels,
    },
    inputs: { source },
  };

  const identity = await createMeshLodChainOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assert.deepEqual(identity.implementation.source, meshSource);
  assert.equal(identity.implementation.probe.id, "three-d-lod-chain");
  assert.equal(identity.implementation.probe.algorithm, "meshopt-0.6.2");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-lod-chain-json-v1");
  assert.equal(identity.implementation.probe.dependencies.meshopt, "0.6.2");
  assert.match(identity.implementation.probe.cargoLock, /name = "meshopt"/);
  assert.match(identity.implementation.probe.cargoLock, /version = "0\.6\.2"/);

  const first = await executeMeshLodChainOperation(root, invocation, processor);
  const second = await executeMeshLodChainOperation(root, invocation, processor);
  assert.equal(first.outputs.output.kind, "lod-chain");
  assert.equal(first.outputs.output.mediaType, THREE_D_LOD_CHAIN_MEDIA_TYPE);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.observations.sourceTriangleCount, sourceTriangleCount);
  assert.equal(first.observations.sourceVertexCount, sourceDocument.vertices.length);
  assert.equal(first.observations.sourceBased, true);
  assert.equal(first.observations.sharedSourceVertexBuffer, true);
  assert.equal(first.observations.levels.length, levels.length);
  for (const [index, level] of first.observations.levels.entries()) {
    assert.equal(level.level, index + 1);
    assert.equal(level.triangleRatio, levels[index].triangleRatio);
    assert.equal(level.requestedTriangleCount, levels[index].targetTriangleCount);
    assert.equal(level.resultIndexCount, level.resultTriangleCount * 3);
    assert.ok(level.relativeError <= levels[index].targetError);
    assert.match(level.indexSha256, /^[0-9a-f]{64}$/);
    if (index > 0) {
      assert.ok(level.resultTriangleCount <= first.observations.levels[index - 1].resultTriangleCount);
    }
  }

  const outputBytes = await resolveAssetObject(root, first.outputs.output);
  const output = JSON.parse(outputBytes.toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.deepEqual(output.sourceVertices, sourceDocument.vertices);
  assert.equal(output.levels.length, levels.length);
  for (const [index, level] of output.levels.entries()) {
    assert.equal(level.level, index + 1);
    assert.equal(level.indices.length, first.observations.levels[index].resultIndexCount);
  }

  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    sourceTriangleCount,
    levels: first.observations.levels.map((level) => ({
      level: level.level,
      requestedTriangleCount: level.requestedTriangleCount,
      resultTriangleCount: level.resultTriangleCount,
      indexSha256: level.indexSha256,
    })),
  };
}

async function checkSkinning(root) {
  const { sourceDocument, source } = await storedSkinningSource(root);
  const invocation = {
    parameters: { bindPoseIdentityTolerance: 0.0001 },
    inputs: { source },
  };
  const identity = await createMeshSkinningValidateOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assert.deepEqual(identity.implementation.source, verifiedSource);
  assert.equal(identity.implementation.runtime.kind, "cargo-rust-v1");
  assert.match(identity.implementation.runtime.cargo, /^cargo 1\.98\.1/m);
  assert.match(identity.implementation.runtime.rustc, /^rustc 1\.98\.1/m);
  assert.equal(identity.implementation.probe.id, "three-d-skinning-validate");
  assert.equal(identity.implementation.probe.algorithm, "three-d-animation-skinning-profile-v1");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-skinning-json-v1");
  assert.equal(identity.implementation.probe.dependencies.threeDAnimation, "0.1.0");
  assert.match(identity.implementation.probe.cargoLock, /name = "three-d-animation"/);

  const first = await executeMeshSkinningValidateOperation(root, invocation, processor);
  const second = await executeMeshSkinningValidateOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "skinning");
  assert.equal(first.outputs.output.mediaType, THREE_D_SKINNING_MEDIA_TYPE);
  assert.equal(first.observations.jointCount, 2);
  assert.equal(first.observations.rootJointCount, 1);
  assert.equal(first.observations.vertexInfluenceCount, 2);
  assert.equal(first.observations.influenceSlotsPerVertex, 4);
  assert.equal(first.observations.maxActiveInfluences, 2);
  assert.equal(first.observations.parentBeforeChild, true);
  assert.equal(first.observations.weightsNormalized, true);
  assert.equal(first.observations.activeJointIndicesInRange, true);
  assert.equal(first.observations.inverseBindMatchesBindPose, true);
  assert.equal(first.observations.maxBindPoseIdentityError, 0);
  assert.equal(first.observations.matrixLayout, "column-major-4x4");
  assert.equal(first.observations.skinMatrixRule, "joint-world-times-inverse-bind");

  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.deepEqual(output.joints, sourceDocument.joints);
  assert.deepEqual(output.influences[0], sourceDocument.influences[0]);
  assert.deepEqual(output.influences[1], {
    joints: [0, 1, 0, 0],
    weights: [0.25, 0.75, 0, 0],
  });

  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    runtime: identity.implementation.runtime,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    jointCount: first.observations.jointCount,
    vertexInfluenceCount: first.observations.vertexInfluenceCount,
    maxBindPoseIdentityError: first.observations.maxBindPoseIdentityError,
  };
}

async function checkRiggedCollision(root) {
  const { sourceDocument, source } = await storedRiggedCollisionSource(root);
  const invocation = {
    parameters: {
      minVerticesPerJoint: 4,
      minDominantWeight: 0.5,
      padding: 0.01,
      minimumExtent: 0.01,
      sphereAspectRatio: 1.25,
      capsuleAspectRatio: 1.75,
    },
    inputs: { source },
  };
  const identity = await createMeshRiggedCollisionFitOperationBuildIdentity(
    root,
    invocation,
    processor,
  );
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assert.deepEqual(identity.implementation.source, verifiedSource);
  assert.equal(identity.implementation.runtime.kind, "cargo-rust-v1");
  assert.match(identity.implementation.runtime.cargo, /^cargo 1\.98\.1/m);
  assert.match(identity.implementation.runtime.rustc, /^rustc 1\.98\.1/m);
  assert.equal(identity.implementation.probe.id, "three-d-rigged-collision-fit");
  assert.equal(
    identity.implementation.probe.algorithm,
    "three-d-rigged-assets-joint-proxy-fit-v1",
  );
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-rigged-collision-json-v1");
  assert.equal(identity.implementation.probe.dependencies.threeDRiggedAssets, "0.1.0");
  assert.match(identity.implementation.probe.cargoLock, /name = "three-d-rigged-assets"/);

  const first = await executeMeshRiggedCollisionFitOperation(root, invocation, processor);
  const second = await executeMeshRiggedCollisionFitOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "collision");
  assert.equal(first.outputs.output.mediaType, THREE_D_RIGGED_COLLISION_MEDIA_TYPE);
  assert.equal(first.observations.jointCount, 1);
  assert.equal(first.observations.vertexCount, sourceDocument.positions.length);
  assert.equal(first.observations.assignedVertices, sourceDocument.positions.length);
  assert.equal(first.observations.lowConfidenceVertices, 0);
  assert.equal(first.observations.representedVertices, sourceDocument.positions.length);
  assert.equal(first.observations.representedJointCount, 1);
  assert.equal(first.observations.proxyCount, 1);
  assert.deepEqual(first.observations.shapeCounts, {
    boxCount: 0,
    sphereCount: 0,
    capsuleCount: 1,
  });
  assert.equal(first.observations.capsuleAxis, "local-y");
  assert.equal(first.observations.transformSpace, "joint-bind-local");

  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.coordinateSystem, "right-handed-y-up");
  assert.equal(output.transformSpace, "joint-bind-local");
  assert.equal(output.capsuleAxis, "local-y");
  assert.equal(output.proxies.length, 1);
  assert.equal(output.proxies[0].shape, "capsule");
  assert.equal(output.proxies[0].joint, 0);

  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    runtime: identity.implementation.runtime,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    jointCount: first.observations.jointCount,
    vertexCount: first.observations.vertexCount,
    proxyCount: first.observations.proxyCount,
  };
}

async function checkAnimationResample(root) {
  const { source, sourceDocument } = await storedAnimationSource(root);
  const invocation = {
    parameters: {
      sourceStartSeconds: 0,
      sourceEndSeconds: 1,
      targetTimesSeconds: [0, 0.25, 0.5, 0.75, 1],
      interpolation: { translation: "linear", rotation: "slerp", scale: "linear" },
      transformSpace: "local",
    },
    inputs: { source },
  };
  const identity = await createAnimationResampleOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assert.deepEqual(identity.implementation.source, verifiedSource);
  assert.equal(identity.implementation.runtime.kind, "cargo-rust-v1");
  assert.match(identity.implementation.runtime.cargo, /^cargo 1\.98\.1/m);
  assert.match(identity.implementation.runtime.rustc, /^rustc 1\.98\.1/m);
  assert.equal(identity.implementation.probe.id, "three-d-animation-resample");
  assert.equal(identity.implementation.probe.algorithm, "three-d-animation-resample-v1");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-animation-json-v1");
  assert.equal(identity.implementation.probe.dependencies.threeDAnimation, "0.1.0");
  assert.match(identity.implementation.probe.cargoLock, /name = "three-d-animation"/);

  const first = await executeAnimationResampleOperation(root, invocation, processor);
  const second = await executeAnimationResampleOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.observations.sourceKeyframeCount, 9);
  assert.equal(first.observations.resultKeyframeCount, 15);
  assert.equal(first.observations.channelCount, 3);
  assert.equal(first.observations.durationSeconds, 1);
  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.channels.length, sourceDocument.channels.length);
  for (const channel of output.channels) {
    assert.deepEqual(
      channel.keyframes.map((keyframe) => keyframe.time),
      invocation.parameters.targetTimesSeconds,
    );
  }
  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    runtime: identity.implementation.runtime,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    sourceKeyframeCount: first.observations.sourceKeyframeCount,
    resultKeyframeCount: first.observations.resultKeyframeCount,
  };
}

async function checkAnimationReduce(root) {
  const { source } = await storedAnimationSource(root);
  const invocation = {
    parameters: {
      translationError: 0.01,
      rotationErrorRadians: 0.01,
      scaleError: 0.01,
      transformSpace: "local",
      preserveEndpoints: true,
    },
    inputs: { source },
  };
  const identity = await createAnimationReduceOperationBuildIdentity(root, invocation, processor);
  assert.deepEqual(identity.operation, { id: operation, version: "1" });
  assert.deepEqual(identity.implementation.source, verifiedSource);
  assert.equal(identity.implementation.runtime.kind, "cargo-rust-v1");
  assert.match(identity.implementation.runtime.cargo, /^cargo 1\.98\.1/m);
  assert.match(identity.implementation.runtime.rustc, /^rustc 1\.98\.1/m);
  assert.equal(identity.implementation.probe.id, "three-d-animation-reduce");
  assert.equal(identity.implementation.probe.algorithm, "three-d-animation-key-reduction-v1");
  assert.equal(identity.implementation.probe.protocol, "asset-tooling-process-adapter-v1");
  assert.equal(identity.implementation.probe.codec, "three-d-animation-json-v1");
  assert.equal(identity.implementation.probe.dependencies.threeDAnimation, "0.1.0");

  const first = await executeAnimationReduceOperation(root, invocation, processor);
  const second = await executeAnimationReduceOperation(root, invocation, processor);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.observations.sourceKeyframeCount, 9);
  assert.ok(first.observations.resultKeyframeCount <= 9);
  assert.ok(first.observations.maxTranslationError <= Math.fround(invocation.parameters.translationError));
  assert.ok(
    first.observations.maxRotationErrorRadians <=
      Math.fround(invocation.parameters.rotationErrorRadians),
  );
  assert.ok(first.observations.maxScaleError <= Math.fround(invocation.parameters.scaleError));
  assert.equal(first.observations.endpointsPreserved, true);
  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.channels.length, 3);
  for (const channel of output.channels) {
    assert.equal(channel.keyframes[0].time, 0);
    assert.equal(channel.keyframes[channel.keyframes.length - 1].time, 1);
  }
  return {
    status: "processor-contract-valid",
    processor: identity.implementation.source,
    runtime: identity.implementation.runtime,
    algorithm: identity.implementation.probe.algorithm,
    codec: identity.implementation.probe.codec,
    inputSha256: source.sha256,
    outputSha256: first.outputs.output.sha256,
    sourceKeyframeCount: first.observations.sourceKeyframeCount,
    resultKeyframeCount: first.observations.resultKeyframeCount,
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-real-processor-"));
try {
  let result;
  switch (operation) {
    case "mesh.simplify":
      result = await checkSimplify(root);
      break;
    case "mesh.lod_chain":
      result = await checkLodChain(root);
      break;
    case "mesh.skinning.validate":
      result = await checkSkinning(root);
      break;
    case "mesh.rigged-collision.fit":
      result = await checkRiggedCollision(root);
      break;
    case "animation.resample":
      result = await checkAnimationResample(root);
      break;
    case "animation.reduce":
      result = await checkAnimationReduce(root);
      break;
    default:
      throw new Error(`unsupported processor contract operation '${operation}'`);
  }
  console.log(JSON.stringify(result));
} finally {
  await rm(root, { recursive: true, force: true });
}
