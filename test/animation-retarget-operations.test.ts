// animation.retarget@1 (#110): joint-name bindings become the processor's HumanoidBone -> node-index
// bindings for each rig, the sample grid comes from sampleRate or explicit times, and the processor
// output/observations are checked against the grid and the target bindings. The fixture adapter is no
// solver; the pinned 3d-lab processor is exercised by scripts/check-processor-contract.ts.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  ANIMATION_RETARGET_OPERATION,
  THREE_D_ANIMATION_MEDIA_TYPE,
  THREE_D_HUMANOID_RIG_MEDIA_TYPE,
  createAnimationRetargetOperationBuildIdentity,
  executeAnimationRetargetOperation,
  humanoidRigBindings,
  parseHumanoidRigDocument,
  retargetSampleTimes,
} from "../src/animation-processing-operations.js";

const FIXTURE_ADAPTER = fileURLToPath(new URL("./fixtures/animation-process-adapter.js", import.meta.url));
const PROCESSOR = {
  repository: "fixture/3d-lab",
  revision: "c".repeat(40),
  executable: process.execPath,
  scriptPath: FIXTURE_ADAPTER,
  prefixArguments: [],
  sourceFiles: [FIXTURE_ADAPTER],
};
const REQUIRED = [
  "hips", "spine", "head", "left-upper-arm", "left-lower-arm", "right-upper-arm",
  "right-lower-arm", "left-upper-leg", "left-lower-leg", "right-upper-leg", "right-lower-leg",
];

/** A chain rig whose joint i is named `${prefix}${bone}` in `order`. */
function rig(prefix: string, order: string[], referenceHeight: number) {
  return {
    schemaVersion: 1,
    jointNames: order.map((bone) => `${prefix}${bone}`),
    nodes: order.map((_, index) => ({
      parent: index === 0 ? null : 0,
      translation: [0, index === 0 ? referenceHeight : 0.1, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    })),
    referenceHeight,
  };
}
const SOURCE_RIG = rig("src.", REQUIRED, 1);
const TARGET_ORDER = [...REQUIRED].reverse();
const TARGET_RIG = rig("tgt.", TARGET_ORDER, 0.9);
const BINDINGS = Object.fromEntries(REQUIRED.map((bone) => [bone, { source: `src.${bone}`, target: `tgt.${bone}` }]));

async function workspace(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "animation-retarget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = async (value: unknown, kind: string, mediaType: string) =>
    (await storeAssetObject(root, { bytes: Buffer.from(JSON.stringify(value)), kind, mediaType })).asset;
  const animation = await store({
    schemaVersion: 1,
    channels: [
      { kind: "rotation", node: 1, keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0.70710677, 0, 0.70710677] }] },
      { kind: "translation", node: 0, keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 1, value: [0, 1.1, 0] }] },
    ],
  }, "animation", THREE_D_ANIMATION_MEDIA_TYPE);
  const inputs = {
    animation,
    "source-rig": await store(SOURCE_RIG, "rig", THREE_D_HUMANOID_RIG_MEDIA_TYPE),
    "target-rig": await store(TARGET_RIG, "rig", THREE_D_HUMANOID_RIG_MEDIA_TYPE),
  };
  return { root, inputs };
}

test("animation.retarget@1 declares animation plus source/target rig inputs", () => {
  assert.deepEqual([ANIMATION_RETARGET_OPERATION.id, ANIMATION_RETARGET_OPERATION.version], ["animation.retarget", "1"]);
  assert.deepEqual(ANIMATION_RETARGET_OPERATION.inputs.map((port: { id: string }) => port.id), ["animation", "source-rig", "target-rig"]);
  assert.deepEqual(ANIMATION_RETARGET_OPERATION.inputs[1].mediaTypes, [THREE_D_HUMANOID_RIG_MEDIA_TYPE]);
});

test("joint-name bindings convert to node indices per rig and fail on unknown or reused joints", () => {
  const source = parseHumanoidRigDocument(Buffer.from(JSON.stringify(SOURCE_RIG)));
  const target = parseHumanoidRigDocument(Buffer.from(JSON.stringify(TARGET_RIG)));
  const sourceBindings = humanoidRigBindings(source, BINDINGS, "source");
  const targetBindings = humanoidRigBindings(target, BINDINGS, "target");
  assert.deepEqual(sourceBindings, Object.fromEntries(REQUIRED.map((bone, index) => [bone, index])));
  assert.deepEqual(targetBindings, Object.fromEntries(REQUIRED.map((bone) => [bone, TARGET_ORDER.indexOf(bone)])));
  assert.throws(() => humanoidRigBindings(target, { ...BINDINGS, hips: { source: "src.hips", target: "tgt.pelvis" } }, "target"), /RETARGET_JOINT_MISSING.*tgt\.pelvis/);
  assert.throws(() => humanoidRigBindings(source, { ...BINDINGS, spine: { source: "src.hips", target: "tgt.spine" } }, "source"), /RETARGET_JOINT_DUPLICATE/);
  assert.throws(() => parseHumanoidRigDocument(Buffer.from(JSON.stringify({ ...SOURCE_RIG, jointNames: SOURCE_RIG.jointNames.slice(1) }))), /jointNames must name every rig node/);
});

test("sampleRate grids cover both clip endpoints", () => {
  assert.deepEqual(retargetSampleTimes(0, 1, 4), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(retargetSampleTimes(0, 0.9, 2), [0, 0.5, Math.fround(0.9)]);
  assert.equal(retargetSampleTimes(0, Math.fround(4 / 3), 30).length, 41);
});

test("animation.retarget@1 runs the processor on converted bindings and checks its output", async (t) => {
  const { root, inputs } = await workspace(t);
  const invocation = { inputs, parameters: { bindings: BINDINGS, sampleRate: 4, rootMotion: "in-place" } };
  const identity = await createAnimationRetargetOperationBuildIdentity(root, invocation, PROCESSOR);
  assert.deepEqual(identity.operation, { id: "animation.retarget", version: "1" });
  assert.equal(identity.implementation.probe.id, "three-d-animation-retarget");
  assert.deepEqual(identity.parameters.rootMotion, "in-place");
  assert.deepEqual(Object.keys(identity.inputs).sort(), ["animation", "source-rig", "target-rig"]);

  const first = await executeAnimationRetargetOperation(root, invocation, PROCESSOR);
  const second = await executeAnimationRetargetOperation(root, invocation, PROCESSOR);
  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  const output = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  // Channels land on the target rig's indices for each bound bone, keyed at the sampleRate grid.
  const rotated = output.channels.filter((channel: { kind: string }) => channel.kind === "rotation").map((channel: { node: number }) => channel.node);
  assert.deepEqual(rotated, [...REQUIRED.map((bone) => TARGET_ORDER.indexOf(bone))].sort((a, b) => a - b));
  for (const channel of output.channels) assert.deepEqual(channel.keyframes.map((key: { time: number }) => key.time), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(first.observations.sampleCount, 5);
  assert.equal(first.observations.mappedBoneCount, REQUIRED.length);
  assert.equal(first.observations.rootMotion, "in-place");
  assert.equal(first.observations.targetJointNames.hips, "tgt.hips");
  assert.equal(first.outputs.output.metadata.targetRigSha256, inputs["target-rig"].sha256);

  const explicit = await executeAnimationRetargetOperation(root, { inputs, parameters: { bindings: BINDINGS, sampleTimesSeconds: [0, 1], rootMotion: "keep" } }, PROCESSOR);
  assert.equal(explicit.observations.sampleCount, 2);
});

test("animation.retarget@1 rejects invalid parameters and bindings before running the processor", async (t) => {
  const { root, inputs } = await workspace(t);
  const run = (parameters: unknown) => executeAnimationRetargetOperation(root, { inputs, parameters }, PROCESSOR);
  await assert.rejects(run({ bindings: BINDINGS, rootMotion: "keep" }), /exactly one of sampleRate or sampleTimesSeconds/);
  await assert.rejects(run({ bindings: BINDINGS, sampleRate: 30, sampleTimesSeconds: [0], rootMotion: "keep" }), /exactly one of/);
  await assert.rejects(run({ bindings: BINDINGS, sampleRate: 30, rootMotion: "drift" }), /rootMotion/);
  await assert.rejects(run({ bindings: { pelvis: { source: "a", target: "b" } }, sampleRate: 30, rootMotion: "keep" }), /unknown humanoid bone 'pelvis'/);
  await assert.rejects(run({ bindings: { ...BINDINGS, head: { source: "src.skull", target: "tgt.head" } }, sampleRate: 30, rootMotion: "keep" }), /RETARGET_JOINT_MISSING/);
  await assert.rejects(run({ bindings: BINDINGS, sampleTimesSeconds: [0.5, 0.5], rootMotion: "keep" }), /strictly increasing/);
});
