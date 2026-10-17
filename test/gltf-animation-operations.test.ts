/// <reference path="../src/gltf-validator.d.ts" />
// scene.extract.animation.gltf@1 / scene.embed.animation.gltf@1 (#110): hand-authored skinned fixtures
// cover the skin-joint rest rig and hips reference height, clip extraction on skin-joint indices, a
// clip round trip through embed, and the failures (duplicate/missing clips, out-of-range nodes).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Document, NodeIO } from "@gltf-transform/core";
import { THREE_D_ANIMATION_MEDIA_TYPE } from "../src/animation-processing-operations.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  GLTF_EMBED_ANIMATION_OPERATION, GLTF_EXTRACT_ANIMATION_OPERATION,
  createGltfEmbedAnimationOperationBuildIdentity, createGltfExtractAnimationOperationBuildIdentity,
  executeGltfEmbedAnimationOperation, executeGltfExtractAnimationOperation,
} from "../src/gltf-animation-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
const ALLOWED = ["NODE_SKINNED_MESH_NON_ROOT"];
const POLICY = { allowedValidatorWarnings: ALLOWED };

/** Armature (non-joint, +0.5 m Y) > root > hips (+1 m) > leg (-0.5 m), one triangle skinned to the three joints. */
async function skinnedGlb(withClip: boolean): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const armature = document.createNode("Armature").setTranslation([0, 0.5, 0]);
  const root = document.createNode("root");
  const hips = document.createNode("hips").setTranslation([0, 1, 0]);
  const leg = document.createNode("leg").setTranslation([0, -0.5, 0]).setRotation([0, 0, 0.38268343, 0.9238795]);
  armature.addChild(root); root.addChild(hips); hips.addChild(leg);
  const accessor = (type: "SCALAR" | "VEC3" | "VEC4" | "MAT4", array: Float32Array | Uint8Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const ibm = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.5, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
  ]);
  const skin = document.createSkin("rig").addJoint(root).addJoint(hips).addJoint(leg).setInverseBindMatrices(accessor("MAT4", ibm));
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute("JOINTS_0", accessor("VEC4", new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0])))
    .setAttribute("WEIGHTS_0", accessor("VEC4", new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  const body = document.createNode("body").setMesh(document.createMesh("body").addPrimitive(primitive)).setSkin(skin);
  document.createScene("scene").addChild(armature).addChild(body);
  if (withClip) {
    const sampler = (input: number[], output: number[], type: "VEC3" | "VEC4") => document.createAnimationSampler()
      .setInput(accessor("SCALAR", new Float32Array(input))).setOutput(accessor(type, new Float32Array(output))).setInterpolation("LINEAR");
    const clip = document.createAnimation("Wave");
    const rotation = sampler([0, 0.5, 1], [0, 0, 0, 1, 0, 0.38268343, 0, 0.9238795, 0, 0.70710677, 0, 0.70710677], "VEC4");
    const translation = sampler([0, 1], [0, 1, 0, 0, 1.25, 0], "VEC3");
    const armatureMove = sampler([0, 1], [0, 0.5, 0, 1, 0.5, 0], "VEC3");
    clip.addSampler(rotation).addSampler(translation).addSampler(armatureMove)
      .addChannel(document.createAnimationChannel().setTargetNode(leg).setTargetPath("rotation").setSampler(rotation))
      .addChannel(document.createAnimationChannel().setTargetNode(hips).setTargetPath("translation").setSampler(translation))
      .addChannel(document.createAnimationChannel().setTargetNode(armature).setTargetPath("translation").setSampler(armatureMove));
  }
  return Buffer.from(await new NodeIO().writeBinary(document));
}

async function workspace(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-animation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = async (bytes: Uint8Array) => (await storeAssetObject(root, { bytes, kind: "scene", mediaType: "model/gltf-binary" })).asset;
  return { root, animated: await store(await skinnedGlb(true)), plain: await store(await skinnedGlb(false)) };
}
function port(result: AssetOperationResult, id: string): AssetRef {
  const value = result.outputs[id];
  assert.ok(value && !Array.isArray(value), `output '${id}'`);
  return value;
}
const json = async (root: string, asset: AssetRef): Promise<Json> => JSON.parse((await resolveAssetObject(root, asset)).toString("utf8"));

test("the operations declare GLB/rig/animation ports", () => {
  assert.deepEqual([GLTF_EXTRACT_ANIMATION_OPERATION.id, GLTF_EXTRACT_ANIMATION_OPERATION.version], ["scene.extract.animation.gltf", "1"]);
  assert.deepEqual(GLTF_EXTRACT_ANIMATION_OPERATION.outputs.map((output) => [output.id, output.required]), [["rig", true], ["animation", false]]);
  assert.deepEqual([GLTF_EMBED_ANIMATION_OPERATION.id, GLTF_EMBED_ANIMATION_OPERATION.version], ["scene.embed.animation.gltf", "1"]);
});

test("extract reads the skin-joint rest rig with the hips model-space height, and a clip on joint indices", async (t) => {
  const { root, animated } = await workspace(t);
  const invocation = { inputs: { source: animated }, parameters: { hipsJoint: "hips", clip: "Wave", policy: POLICY } };
  const identity = await createGltfExtractAnimationOperationBuildIdentity(root, invocation);
  assert.deepEqual(identity.parameters, invocation.parameters);
  const result = await executeGltfExtractAnimationOperation(root, invocation);
  const rig = await json(root, port(result, "rig"));
  assert.deepEqual(rig.jointNames, ["root", "hips", "leg"]);
  assert.deepEqual(rig.nodes.map((node: Json) => node.parent), [null, 0, 1]);
  assert.deepEqual(rig.nodes[2], { parent: 1, translation: [0, -0.5, 0], rotation: [0, 0, 0.38268343, 0.9238795], scale: [1, 1, 1] });
  assert.equal(rig.referenceHeight, 1.5, "hips height includes the non-joint Armature offset");
  const clip = await json(root, port(result, "animation"));
  assert.deepEqual(clip.channels.map((channel: Json) => [channel.node, channel.kind]), [[1, "translation"], [2, "rotation"]]);
  assert.deepEqual(clip.channels[0].keyframes, [{ time: 0, value: [0, 1, 0] }, { time: 1, value: [0, 1.25, 0] }]);
  assert.equal(clip.channels[1].keyframes.length, 3);
  const observations = result.observations as Json;
  assert.deepEqual(observations.clip.skippedChannels, [{ node: "Armature", path: "translation" }]);
  assert.deepEqual([observations.clip.startSeconds, observations.clip.endSeconds], [0, 1]);
  assert.equal(observations.rig.referenceHeight, 1.5);

  // Rig only (the retarget target): no clip parameter, no animation output.
  const rigOnly = await executeGltfExtractAnimationOperation(root, { inputs: { source: animated }, parameters: { hipsJoint: "hips", policy: POLICY } });
  assert.deepEqual(Object.keys(rigOnly.outputs), ["rig"]);
  assert.equal(port(rigOnly, "rig").sha256, port(result, "rig").sha256);

  await assert.rejects(executeGltfExtractAnimationOperation(root, { inputs: { source: animated }, parameters: { hipsJoint: "hips", clip: "Run", policy: POLICY } }), /EXTRACT_CLIP_MISSING/);
  await assert.rejects(executeGltfExtractAnimationOperation(root, { inputs: { source: animated }, parameters: { hipsJoint: "pelvis", policy: POLICY } }), /EXTRACT_HIPS_MISSING/);
  await assert.rejects(executeGltfExtractAnimationOperation(root, { inputs: { source: animated }, parameters: { hipsJoint: "hips", extra: 1 } }), /unknown/);
});

test("a clip round-trips through embed onto another GLB's skin joints, and extracting it again is identical", async (t) => {
  const { root, animated, plain } = await workspace(t);
  const extracted = port(await executeGltfExtractAnimationOperation(root, { inputs: { source: animated }, parameters: { hipsJoint: "hips", clip: "Wave", policy: POLICY } }), "animation");
  const invocation = { inputs: { source: plain, animations: [extracted] }, parameters: { clips: [{ name: "Wave" }], policy: POLICY } };
  const identity = await createGltfEmbedAnimationOperationBuildIdentity(root, invocation);
  assert.deepEqual(identity.operation, { id: "scene.embed.animation.gltf", version: "1" });
  const embedded = await executeGltfEmbedAnimationOperation(root, invocation);
  const again = await executeGltfEmbedAnimationOperation(root, invocation);
  assert.equal(port(again, "output").sha256, port(embedded, "output").sha256, "deterministic output");
  const observations = embedded.observations as Json;
  assert.deepEqual(observations.output.clipNames, ["Wave"]);
  assert.deepEqual(observations.clips[0].animatedJoints, ["hips", "leg"]);

  const document = await new NodeIO().readBinary(await resolveAssetObject(root, port(embedded, "output")));
  const [animation] = document.getRoot().listAnimations();
  assert.equal(animation!.getName(), "Wave");
  assert.deepEqual(animation!.listChannels().map((channel) => [channel.getTargetNode()!.getName(), channel.getTargetPath(), channel.getSampler()!.getInterpolation()]),
    [["hips", "translation", "LINEAR"], ["leg", "rotation", "LINEAR"]]);
  const roundTrip = port(await executeGltfExtractAnimationOperation(root, { inputs: { source: port(embedded, "output") }, parameters: { hipsJoint: "hips", clip: "Wave", policy: POLICY } }), "animation");
  assert.equal(roundTrip.sha256, extracted.sha256, "embed then extract reproduces the animation document");
});

test("embed rejects an existing or duplicated clip name and nodes outside the skin", async (t) => {
  const { root, animated, plain } = await workspace(t);
  const extracted = port(await executeGltfExtractAnimationOperation(root, { inputs: { source: animated }, parameters: { hipsJoint: "hips", clip: "Wave", policy: POLICY } }), "animation");
  await assert.rejects(executeGltfEmbedAnimationOperation(root, { inputs: { source: animated, animations: [extracted] }, parameters: { clips: [{ name: "Wave" }], policy: POLICY } }), /EMBED_CLIP_EXISTS: .*'Wave'/);
  await assert.rejects(executeGltfEmbedAnimationOperation(root, { inputs: { source: plain, animations: [extracted, extracted] }, parameters: { clips: [{ name: "A" }, { name: "A" }], policy: POLICY } }), /EMBED_CLIP_DUPLICATE/);
  await assert.rejects(executeGltfEmbedAnimationOperation(root, { inputs: { source: plain, animations: [extracted] }, parameters: { clips: [{ name: "A" }, { name: "B" }], policy: POLICY } }), /pair one animation/);
  const outside = (await storeAssetObject(root, {
    bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, channels: [{ kind: "rotation", node: 3, keyframes: [{ time: 0, value: [0, 0, 0, 1] }] }] })),
    kind: "animation", mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
  })).asset;
  await assert.rejects(executeGltfEmbedAnimationOperation(root, { inputs: { source: plain, animations: [outside] }, parameters: { clips: [{ name: "A" }], policy: POLICY } }), /EMBED_NODE_OUT_OF_RANGE/);
});

test("a joint below another joint through a non-joint helper is rejected, not emitted as a root", async (t) => {
  // Regression (PR #255): root > helper (non-joint, offset) > hips must not become two disconnected roots.
  const { root } = await workspace(t);
  const document = await new NodeIO().readBinary(await skinnedGlb(false));
  const joints = document.getRoot().listSkins()[0]!.listJoints();
  const [rootJoint, hips] = [joints[0]!, joints[1]!];
  const helper = document.createNode("helper").setTranslation([0, 0.25, 0]);
  rootJoint.removeChild(hips); rootJoint.addChild(helper); helper.addChild(hips);
  const source = (await storeAssetObject(root, { bytes: await new NodeIO().writeBinary(document), kind: "scene", mediaType: "model/gltf-binary" })).asset;
  await assert.rejects(executeGltfExtractAnimationOperation(root, { inputs: { source }, parameters: { hipsJoint: "hips", policy: POLICY } }),
    /EXTRACT_JOINT_HELPER_ANCESTOR: joint 'hips' is below joint 'root' through non-joint node 'helper'/);
});

test("the package subpath exports the same operations", async () => {
  const api = await import("asset-tooling/operations/processing/gltf-animation");
  assert.equal(api.executeGltfExtractAnimationOperation, executeGltfExtractAnimationOperation);
  assert.equal(api.executeGltfEmbedAnimationOperation, executeGltfEmbedAnimationOperation);
});
