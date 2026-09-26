import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  HUMANOID_VALIDATE_OPERATION,
  THREE_D_HUMANOID_MEDIA_TYPE,
  createHumanoidValidateOperationBuildIdentity,
  executeHumanoidValidateOperation,
} from "../src/humanoid-processing-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(
  new URL("./fixtures/humanoid-process-adapter.js", import.meta.url),
);
const PROCESSOR = {
  repository: "fixture/3d-lab",
  revision: "e".repeat(40),
  executable: process.execPath,
  scriptPath: FIXTURE_ADAPTER,
  prefixArguments: [],
  sourceFiles: [FIXTURE_ADAPTER],
};
const WRONG_ROOT_PROCESSOR = {
  ...PROCESSOR,
  prefixArguments: ["--mismatch=root"],
};
const WRONG_TOES_PROCESSOR = {
  ...PROCESSOR,
  prefixArguments: ["--mismatch=toes"],
};
const IDENTITY_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];
const IDENTITY_TRANSFORM = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};
const BONES = [
  "root",
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "left-shoulder",
  "left-upper-arm",
  "left-lower-arm",
  "left-hand",
  "right-shoulder",
  "right-upper-arm",
  "right-lower-arm",
  "right-hand",
  "left-upper-leg",
  "left-lower-leg",
  "left-foot",
  "right-upper-leg",
  "right-lower-leg",
  "right-foot",
];
const PARENTS = [
  null,
  0,
  1,
  2,
  3,
  4,
  3,
  6,
  7,
  8,
  3,
  10,
  11,
  12,
  1,
  14,
  15,
  1,
  17,
  18,
];
const SOCKETS = [
  ["head", "head"],
  ["chest", "chest"],
  ["back", "chest"],
  ["left-hand", "left-hand"],
  ["right-hand", "right-hand"],
  ["left-hip", "hips"],
  ["right-hip", "hips"],
];

function sourceDocument() {
  return {
    schemaVersion: 1,
    referenceHeight: 1.8,
    joints: PARENTS.map((parent) => ({ parent, inverseBind: IDENTITY_MATRIX })),
    restPose: BONES.map(() => IDENTITY_TRANSFORM),
    bindings: BONES.map((bone, node) => ({ bone, node })),
    sockets: SOCKETS.map(([socket, bone]) => ({
      socket,
      bone,
      local: IDENTITY_TRANSFORM,
    })),
  };
}

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-humanoid-"));
}

async function storedSource(root) {
  const document = sourceDocument();
  return (
    await storeAssetObject(root, {
      bytes: Buffer.from(JSON.stringify(document), "utf8"),
      kind: "humanoid-rig",
      mediaType: THREE_D_HUMANOID_MEDIA_TYPE,
      metadata: {
        humanoidSchemaVersion: 1,
        jointCount: document.joints.length,
        mappedBoneCount: document.bindings.length,
        socketCount: document.sockets.length,
      },
    })
  ).asset;
}

test("humanoid validation exposes a typed rig operation without gameplay semantics", () => {
  assert.equal(HUMANOID_VALIDATE_OPERATION.id, "rig.humanoid.validate");
  assert.equal(HUMANOID_VALIDATE_OPERATION.version, "1");
  assert.equal(HUMANOID_VALIDATE_OPERATION.category, "rig.processing");
  assert.deepEqual(HUMANOID_VALIDATE_OPERATION.inputs[0].assetKinds, ["humanoid-rig"]);
  assert.deepEqual(HUMANOID_VALIDATE_OPERATION.inputs[0].mediaTypes, [
    THREE_D_HUMANOID_MEDIA_TYPE,
  ]);
  assert.deepEqual(HUMANOID_VALIDATE_OPERATION.outputs[0].assetKinds, ["humanoid-rig"]);
  assert.deepEqual(HUMANOID_VALIDATE_OPERATION.parameterSchema.required, undefined);
});

test("humanoid build identity binds exact processor source and production algorithm", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  const identity = await createHumanoidValidateOperationBuildIdentity(
    root,
    { parameters: {}, inputs: { source } },
    PROCESSOR,
  );

  assert.deepEqual(identity.operation, { id: "rig.humanoid.validate", version: "1" });
  assert.deepEqual(identity.parameters, {});
  assert.equal(identity.implementation.id, "three-d-humanoid-validate");
  assert.equal(
    identity.implementation.probe.algorithm,
    "three-d-animation-humanoid-production-v1",
  );
  assert.equal(identity.implementation.probe.codec, "three-d-humanoid-json-v1");
  assert.equal(identity.implementation.source.repository, "fixture/3d-lab");
  assert.equal(identity.implementation.source.revision, "e".repeat(40));
  assert.match(identity.implementation.source.sourceSha256, /^[0-9a-f]{64}$/);
});

test("humanoid validation is idempotent and records reusable rig evidence", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  const invocation = { parameters: {}, inputs: { source } };

  const first = await executeHumanoidValidateOperation(root, invocation, PROCESSOR);
  const second = await executeHumanoidValidateOperation(root, invocation, PROCESSOR);

  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "humanoid-rig");
  assert.equal(first.outputs.output.mediaType, THREE_D_HUMANOID_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.jointCount, 20);
  assert.equal(first.outputs.output.metadata.mappedBoneCount, 20);
  assert.equal(first.outputs.output.metadata.socketCount, 7);
  assert.equal(first.observations.rootNode, 0);
  assert.equal(first.observations.hipsNode, 1);
  assert.equal(first.observations.semanticHierarchyValid, true);
  assert.equal(first.observations.rootHipsSeparated, true);
  assert.equal(first.observations.standardSocketsPresent, true);

  const output = JSON.parse(
    (await resolveAssetObject(root, first.outputs.output)).toString("utf8"),
  );
  assert.deepEqual(output, sourceDocument());
});

test("humanoid execution enforces the operation input kind and media type", async () => {
  const root = await workspace();
  const source = await storedSource(root);

  await assert.rejects(
    () =>
      executeHumanoidValidateOperation(
        root,
        {
          parameters: {},
          inputs: { source: { ...source, kind: "mesh" } },
        },
        PROCESSOR,
      ),
    /kind 'mesh' is not accepted/,
  );
  await assert.rejects(
    () =>
      executeHumanoidValidateOperation(
        root,
        {
          parameters: {},
          inputs: { source: { ...source, mediaType: "application/json" } },
        },
        PROCESSOR,
      ),
    /media type 'application\/json' is not accepted/,
  );
});

test("humanoid execution rejects processor observations that contradict source bindings", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  const invocation = { parameters: {}, inputs: { source } };

  await assert.rejects(
    () => executeHumanoidValidateOperation(root, invocation, WRONG_ROOT_PROCESSOR),
    /observations\.rootNode does not match the humanoid source binding/,
  );
  await assert.rejects(
    () => executeHumanoidValidateOperation(root, invocation, WRONG_TOES_PROCESSOR),
    /observations\.optionalToeCount does not match the humanoid source bindings/,
  );
});

test("humanoid validation rejects ambiguous parameters and malformed transport before execution", async () => {
  const root = await workspace();
  const source = await storedSource(root);
  await assert.rejects(
    () =>
      executeHumanoidValidateOperation(
        root,
        { parameters: { profile: "production-v1" }, inputs: { source } },
        PROCESSOR,
      ),
    /parameters must be empty/,
  );

  const malformed = (
    await storeAssetObject(root, {
      bytes: Buffer.from(
        JSON.stringify({ ...sourceDocument(), referenceHeight: Number.MAX_VALUE }),
        "utf8",
      ),
      kind: "humanoid-rig",
      mediaType: THREE_D_HUMANOID_MEDIA_TYPE,
      metadata: {},
    })
  ).asset;
  await assert.rejects(
    () =>
      executeHumanoidValidateOperation(
        root,
        { parameters: {}, inputs: { source: malformed } },
        PROCESSOR,
      ),
    /referenceHeight must be representable as a finite f32/,
  );
});
