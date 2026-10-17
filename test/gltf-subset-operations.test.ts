/// <reference path="../src/gltf-validator.d.ts" />
// scene.subset.skinned.gltf@1 (#110, owner decision 2026-10-17, option A: keep the UBC body's face
// skinned to the neck/head joints plus eyes and eyebrows, then compose with the Male_Ranger outfit).
// Small hand-authored skinned fixtures cover joint/threshold filtering, keepMeshes, compaction with
// byte-exact skinning data, pruning, failures and replay. The real-source test imports the hydrated
// Superhero body and Male_Ranger outfit through scene.import.gltf@2, subsets the body and composes it
// with scene.compose.skinned.gltf@1; it skips on Git LFS pointers unless ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1.
// Set ASSET_TOOLING_GLTF_SUBSET_OUT to a file path to keep the composed real GLB (and <path>.observations.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Document, NodeIO, type Accessor } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfComposeSkinnedOperation } from "../src/gltf-compose-operations.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import {
  GLTF_SUBSET_SKINNED_OPERATION,
  createGltfSubsetSkinnedOperationBuildIdentity,
  executeGltfSubsetSkinnedOperation,
} from "../src/gltf-subset-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A valid 1x1 RGB PNG. */
function png(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 200, 100, 50]))), chunk("IEND", Buffer.alloc(0))]));
}

// ------------------------------------------------------------------ fixtures

// Joints: 0 hips, 1 spine, 2 head, 3 jaw. Per vertex [JOINTS_0, WEIGHTS_0, JOINTS_1, WEIGHTS_1]; v4 has
// head 0.3 in set 0 and jaw 0.3 in set 1, so the kept-joint sum must add the sets.
const BODY_VERTICES: [number[], number[], number[], number[]][] = [
  [[0, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // v0 hips
  [[0, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // v1 hips
  [[2, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // v2 head
  [[2, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // v3 head
  [[2, 1, 0, 0], [0.3, 0.4, 0, 0], [3, 0, 0, 0], [0.3, 0, 0, 0]], // v4 head 0.3 + jaw 0.3, spine 0.4
  [[2, 1, 0, 0], [0.4, 0.6, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // v5 head 0.4, spine 0.6
  [[2, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // v6 head
];
// t0 hips (removed), t1 head, t2 has v4 (head + jaw 0.6), t3 has v5 (head 0.4).
const BODY_INDICES = [0, 1, 2, 2, 3, 6, 3, 4, 6, 4, 5, 6];

interface Options { animation?: boolean }

async function sourceGlb(options: Options = {}): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const armature = document.createNode("Armature");
  scene.addChild(armature);
  const accessor = (type: "VEC2" | "VEC3" | "VEC4" | "MAT4" | "SCALAR", array: Float32Array | Uint8Array | Uint16Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  let parent = armature, worldY = 0;
  const joints = [];
  const inverseBinds: number[] = [];
  for (const [name, y] of [["hips", 1], ["spine", 0.5], ["head", 0.3], ["jaw", 0.1]] as const) {
    const node = document.createNode(name).setTranslation([0, y, 0]);
    parent.addChild(node);
    parent = node;
    worldY += y;
    joints.push(node);
    inverseBinds.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -worldY, 0, 1);
  }
  const skin = document.createSkin("skin").setSkeleton(joints[0]!).setInverseBindMatrices(accessor("MAT4", new Float32Array(inverseBinds)));
  for (const joint of joints) skin.addJoint(joint);
  const texture = document.createTexture("legs-color").setImage(png()).setMimeType("image/png");
  const materials = {
    body: document.createMaterial("body-material").setRoughnessFactor(0.75),
    legs: document.createMaterial("legs-material").setBaseColorTexture(texture),
    eyes: document.createMaterial("eyes-material"),
  };
  const skinned = (vertices: typeof BODY_VERTICES, indices: number[], material: keyof typeof materials) => {
    const primitive = document.createPrimitive()
      .setAttribute("POSITION", accessor("VEC3", new Float32Array(vertices.flatMap((_, index) => [index * 0.1, index * 0.25 + 0.01, (index % 3) * 0.05]))))
      .setAttribute("NORMAL", accessor("VEC3", new Float32Array(vertices.flatMap(() => [0, 0, 1]))))
      .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array(vertices.flatMap((_, index) => [index / 7, 1 - index / 7]))))
      .setAttribute("JOINTS_0", accessor("VEC4", new Uint8Array(vertices.flatMap((vertex) => vertex[0]))))
      .setAttribute("WEIGHTS_0", accessor("VEC4", new Float32Array(vertices.flatMap((vertex) => vertex[1]))))
      .setIndices(accessor("SCALAR", new Uint16Array(indices)))
      .setMaterial(materials[material]);
    if (vertices.some((vertex) => vertex[3].some(Boolean))) {
      primitive.setAttribute("JOINTS_1", accessor("VEC4", new Uint8Array(vertices.flatMap((vertex) => vertex[2]))))
        .setAttribute("WEIGHTS_1", accessor("VEC4", new Float32Array(vertices.flatMap((vertex) => vertex[3]))));
    }
    return primitive;
  };
  const hipsTriangle = BODY_VERTICES.slice(0, 3).map((vertex, index) => (index === 2 ? BODY_VERTICES[0]! : vertex));
  const body = document.createMesh("body").addPrimitive(skinned(BODY_VERTICES, BODY_INDICES, "body")).addPrimitive(skinned(hipsTriangle, [0, 1, 2], "legs"));
  const legs = document.createMesh("legs").addPrimitive(skinned(hipsTriangle, [0, 1, 2], "legs"));
  const eyes = document.createMesh("eyes").addPrimitive(skinned(hipsTriangle, [0, 1, 2], "eyes"));
  for (const mesh of [body, legs, eyes]) scene.addChild(document.createNode(`${mesh.getName()}-node`).setMesh(mesh).setSkin(skin));
  const prop = document.createPrimitive().setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])));
  scene.addChild(document.createNode("prop-node").setMesh(document.createMesh("prop").addPrimitive(prop)));
  if (options.animation) {
    const sampler = document.createAnimationSampler().setInput(accessor("SCALAR", new Float32Array([0, 1])))
      .setOutput(accessor("VEC3", new Float32Array([0, 1, 0, 0, 1.2, 0]))).setInterpolation("LINEAR");
    document.createAnimation("wave").addSampler(sampler)
      .addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(joints[0]!).setTargetPath("translation"));
  }
  return new NodeIO().writeBinary(document);
}

async function fixture(options: Options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-subset-"));
  const source = (await storeAssetObject(root, { bytes: await sourceGlb(options), kind: "scene", mediaType: "model/gltf-binary" })).asset;
  return { root, source, run: (parameters: Json) => executeGltfSubsetSkinnedOperation(root, { inputs: { source }, parameters }) };
}

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  assert.ok(output && !Array.isArray(output));
  return output;
}

const bytesOf = (accessor: Accessor) => { const array = accessor.getArray()!; return Buffer.from(array.buffer, array.byteOffset, array.byteLength); };
/** The source accessor's elements at `vertices`, as raw bytes. */
function elementBytes(accessor: Accessor, vertices: number[]) {
  const array = accessor.getArray()!, size = accessor.getElementSize(), width = array.BYTES_PER_ELEMENT * size;
  const all = bytesOf(accessor);
  return Buffer.concat(vertices.map((vertex) => all.subarray(vertex * width, vertex * width + width)));
}

async function readOutput(root: string, result: AssetOperationResult) {
  return new NodeIO().readBinary(await resolveAssetObject(root, single(result)));
}

// ------------------------------------------------------------- behaviour

test("subset keeps only triangles fully weighted to keepJoints, compacts vertices byte-exact and prunes the rest", async () => {
  const { root, source, run } = await fixture();
  try {
    assert.deepEqual([GLTF_SUBSET_SKINNED_OPERATION.id, GLTF_SUBSET_SKINNED_OPERATION.version], ["scene.subset.skinned.gltf", "1"]);
    const result = await run({ keepJoints: ["head", "jaw"], keepMeshes: ["eyes"] });
    const output = await readOutput(root, result);
    const outputRoot = output.getRoot();
    const sourceDocument = await new NodeIO().readBinary(await resolveAssetObject(root, source));
    assert.deepEqual(outputRoot.listMeshes().map((mesh) => mesh.getName()), ["body", "eyes"]);
    assert.deepEqual(outputRoot.listNodes().map((node) => node.getName()), ["Armature", "hips", "spine", "head", "jaw", "body-node", "eyes-node"]);
    assert.deepEqual(outputRoot.listMaterials().map((material) => material.getName()), ["body-material", "eyes-material"]);
    assert.equal(outputRoot.listTextures().length, 0, "the legs texture is pruned with its material");
    // Body: t1 and t2 kept (v4 sums 0.3 + 0.3 over both weight sets), compacted to v2, v3, v4, v6.
    const [primitive] = outputRoot.listMeshes()[0]!.listPrimitives();
    assert.equal(outputRoot.listMeshes()[0]!.listPrimitives().length, 1, "the all-hips primitive is removed");
    assert.deepEqual(Array.from(primitive!.getIndices()!.getArray()!), [0, 1, 3, 1, 2, 3]);
    const sourcePrimitive = sourceDocument.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    for (const semantic of sourcePrimitive.listSemantics()) {
      const kept = primitive!.getAttribute(semantic)!;
      assert.equal(kept.getComponentType(), sourcePrimitive.getAttribute(semantic)!.getComponentType(), semantic);
      assert.deepEqual(bytesOf(kept), elementBytes(sourcePrimitive.getAttribute(semantic)!, [2, 3, 4, 6]), semantic);
    }
    // Skin and inverse bind matrices unchanged; the kept mesh stays whole.
    assert.equal(outputRoot.listSkins().length, 1);
    assert.deepEqual(bytesOf(outputRoot.listSkins()[0]!.getInverseBindMatrices()!), bytesOf(sourceDocument.getRoot().listSkins()[0]!.getInverseBindMatrices()!));
    assert.deepEqual(outputRoot.listSkins()[0]!.listJoints().map((joint) => joint.getName()), ["hips", "spine", "head", "jaw"]);
    assert.equal(outputRoot.listMeshes()[1]!.listPrimitives()[0]!.getIndices()!.getCount(), 3);
    const observations = result.observations as Json;
    assert.deepEqual(observations.keepJoints, ["head", "jaw"]);
    assert.equal(observations.minWeight, 0.5);
    assert.deepEqual(observations.removedMeshes, ["legs", "prop"]);
    assert.deepEqual(observations.removedNodes, ["legs-node", "prop-node"]);
    const body = observations.meshes.find((mesh: Json) => mesh.name === "body");
    assert.deepEqual([body.keptTriangles, body.removedTriangles], [2, 3]);
    assert.deepEqual(body.primitives.map((entry: Json) => [entry.keptTriangles, entry.removedTriangles, entry.keptVertexCount, entry.removed]), [[2, 2, 4, false], [0, 1, 0, true]]);
    assert.deepEqual(observations.meshes.find((mesh: Json) => mesh.name === "eyes"), { name: "eyes", skinned: true, keptWhole: true, keptTriangles: 1, removedTriangles: 0, primitives: [] });
    assert.equal(observations.source.triangleCount, 8);
    assert.equal(observations.output.triangleCount, 3);
    assert.equal(observations.output.vertexCount, 7);
    assert.ok(observations.weightSums);
    const validation = await validateBytes(await resolveAssetObject(root, single(result)), { format: "glb", writeTimestamp: false });
    assert.equal(validation.issues.numErrors, 0);
    assert.equal(validation.issues.numWarnings, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("minWeight sets how much of each vertex must belong to keepJoints", async () => {
  const { root, run } = await fixture();
  try {
    const triangles = async (minWeight: number) => ((await run({ keepJoints: ["head", "jaw"], minWeight })).observations as Json).output.triangleCount;
    assert.equal(await triangles(0.7), 1, "v4 (0.6) drops t2");
    assert.equal(await triangles(0.5), 2);
    assert.equal(await triangles(0.4), 3, "v5 (0.4) keeps t3");
    assert.equal(await (async () => ((await run({ keepJoints: ["head"] })).observations as Json).output.triangleCount)(), 1, "without jaw, v4 has only 0.3");
    // Several joints add up: head + spine covers every non-hips vertex.
    assert.equal(((await run({ keepJoints: ["spine", "head", "jaw"], minWeight: 1 })).observations as Json).output.triangleCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subset output and build identity are deterministic, with defaults materialized", async () => {
  const { root, source, run } = await fixture();
  try {
    assert.deepEqual(await run({ keepJoints: ["head"] }), await run({ keepJoints: ["head"] }));
    const invocation = { inputs: { source }, parameters: { keepJoints: ["head"] } };
    const identity = await createGltfSubsetSkinnedOperationBuildIdentity(root, invocation);
    assert.deepEqual(await createGltfSubsetSkinnedOperationBuildIdentity(root, invocation), identity);
    assert.deepEqual(identity.operation, { id: "scene.subset.skinned.gltf", version: "1" });
    assert.deepEqual(identity.parameters, { keepJoints: ["head"], minWeight: 0.5, keepMeshes: [], policy: { allowedValidatorWarnings: [] } });
    assert.equal((identity.implementation as Json).id, "gltf-transform-skinned-subset");
    const other = await createGltfSubsetSkinnedOperationBuildIdentity(root, { ...invocation, parameters: { keepJoints: ["head"], minWeight: 0.6 } });
    assert.notDeepEqual(other.parameters, identity.parameters);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subset fails visibly on missing joints or meshes, an empty result, animations and bad parameters", async () => {
  const { root, run } = await fixture();
  try {
    await assert.rejects(run({ keepJoints: ["head", "tail"] }), /SUBSET_JOINT_MISSING: keepJoints names 'tail'/);
    await assert.rejects(run({ keepJoints: ["head"], keepMeshes: ["hat"] }), /SUBSET_MESH_MISSING: keepMeshes names 'hat'/);
    await assert.rejects(run({ keepJoints: ["spine"], minWeight: 1 }), /SUBSET_EMPTY_RESULT/);
    await assert.rejects(run({ keepJoints: [] }), /keepJoints must be a list/);
    await assert.rejects(run({}), /keepJoints must be a list/);
    await assert.rejects(run({ keepJoints: ["head", "head"] }), /duplicate keepJoints/);
    await assert.rejects(run({ keepJoints: ["head"], minWeight: 0 }), /minWeight must be a number in \(0, 1\]/);
    await assert.rejects(run({ keepJoints: ["head"], minWeight: 1.5 }), /minWeight/);
    await assert.rejects(run({ keepJoints: ["head"], threshold: 0.5 }), /unknown glTF subset parameter 'threshold'/);
    await assert.rejects(run({ keepJoints: ["head"], policy: { allowedValidatorWarnings: ["UNUSED_OBJECT"] } }), /allowedValidatorWarnings/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const animated = await fixture({ animation: true });
  try {
    await assert.rejects(animated.run({ keepJoints: ["head"] }), /\/animations: SUBSET_ANIMATIONS_UNSUPPORTED/);
  } finally {
    await rm(animated.root, { recursive: true, force: true });
  }
});

test("package subpath exports the subset operation", async () => {
  const api = await import("asset-tooling/operations/processing/gltf-subset");
  assert.equal(api.GLTF_SUBSET_SKINNED_OPERATION, GLTF_SUBSET_SKINNED_OPERATION);
  assert.equal(api.executeGltfSubsetSkinnedOperation, executeGltfSubsetSkinnedOperation);
  assert.equal(typeof api.createGltfSubsetSkinnedOperationBuildIdentity, "function");
});

// ------------------------------------------------------- real hydrated sources

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";
const ALLOWED = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const BODY = { archive: "quaternius.universal-base-characters-standard", gltf: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf" };
const OUTFIT = { archive: "quaternius.modular-character-outfits-fantasy-standard", gltf: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf" };
/** The Ranger recipe (docs/gltf-subset.md): the UBC rig's neck and head joints (Head has no child joints). */
const RANGER_HEAD_RECIPE = { keepJoints: ["neck_01", "Head"], minWeight: 0.5, keepMeshes: ["Face", "Face.001"], policy: { allowedValidatorWarnings: ALLOWED } };
const BODY_TRIANGLES = 14_318;

const providersDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
const sourcesDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
const storageDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
const rawSources: Json[] = sourcesDocument.sources;
const catalog = createAssetCatalog({ providers: providersDocument.providers, sources: sourcesDocument.sources });

function memberId(archive: string, memberPath: string): string {
  const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
  assert.equal(matches.length, 1, `'${memberPath}' must be registered once`);
  return matches[0]!.id;
}

/** Adjacent basename, or the one member whose metadata.substitutesFor names the URI (docs/humanoid-sources.md). */
function resourceId(archive: string, gltfId: string, uri: string): string {
  const substitutes = rawSources.filter((source) => source.metadata?.substitutesFor?.some((entry: Json) => entry.member === gltfId && entry.uri === uri));
  if (substitutes.length === 1) return substitutes[0]!.id;
  const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === uri);
  assert.equal(matches.length, 1, `URI '${uri}' must resolve to one member`);
  return matches[0]!.id;
}

async function hydratedSkip(): Promise<string | false> {
  const pointers: string[] = [];
  for (const { archive, gltf } of [BODY, OUTFIT]) {
    const entry = storageDocument.entries.find((candidate: Json) => candidate.sourceId === memberId(archive, gltf));
    const bytes = await readFile(path.join(ROOT, entry.path));
    if (bytes.subarray(0, 128).toString("utf8").startsWith(LFS_POINTER_PREFIX)) pointers.push(entry.path);
  }
  if (!pointers.length) return false;
  if (REQUIRE_HYDRATED) return false; // let the test fail on the pointer instead of skipping
  return `Git LFS payloads are not hydrated (e.g. ${pointers[0]}); run 'git lfs pull' or set ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`;
}

async function importMember(objectStoreRoot: string, { archive, gltf }: { archive: string; gltf: string }): Promise<AssetRef> {
  const gltfId = memberId(archive, gltf);
  const { asset: source } = await importAssetCatalogStorageSource({ catalog, storage: storageDocument, sourceId: gltfId, storageRoot: ROOT, objectStoreRoot });
  const json = JSON.parse((await resolveAssetObject(objectStoreRoot, source)).toString("utf8"));
  const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((entry: Json) => entry.uri);
  const resources: AssetRef[] = [];
  for (const uri of uris) {
    resources.push((await importAssetCatalogStorageSource({ catalog, storage: storageDocument, sourceId: resourceId(archive, gltfId, uri), storageRoot: ROOT, objectStoreRoot })).asset);
  }
  const result = await executeGltfProductionImportOperation(objectStoreRoot, {
    inputs: { source, resources }, parameters: { resourceUris: uris, policy: { allowedValidatorWarnings: ALLOWED } },
  });
  return single(result);
}

test("real sources: the UBC body subset to its face, eyes and eyebrows composes with the Male_Ranger outfit", { skip: await hydratedSkip(), timeout: 600_000 }, async () => {
  const objectStoreRoot = await mkdtemp(path.join(os.tmpdir(), "gltf-subset-real-"));
  try {
    const outfit = await importMember(objectStoreRoot, OUTFIT);
    const body = await importMember(objectStoreRoot, BODY);
    const io = new NodeIO();
    const bodyDocument = await io.readBinary(await resolveAssetObject(objectStoreRoot, body));
    // The recipe's joints are the rig's neck/head chain, and Head has no child joints.
    const bodyJoints = bodyDocument.getRoot().listSkins()[0]!.listJoints();
    const head = bodyJoints.find((joint) => joint.getName() === "Head")!;
    assert.deepEqual(head.listChildren().filter((child) => bodyJoints.includes(child)), []);
    assert.equal(bodyJoints.some((joint) => joint.getName() === "neck_02"), false);

    const subset = await executeGltfSubsetSkinnedOperation(objectStoreRoot, { inputs: { source: body }, parameters: RANGER_HEAD_RECIPE });
    const subsetObservations = subset.observations as Json;
    assert.equal(subsetObservations.source.triangleCount, BODY_TRIANGLES);
    const meshReport = (name: string) => subsetObservations.meshes.find((mesh: Json) => mesh.name === name);
    assert.equal(meshReport("Face").keptWhole, true);
    assert.equal(meshReport("Face.001").keptWhole, true);
    const skin = meshReport("Sphere.005_Retopology.004");
    assert.ok(skin.keptTriangles > 0 && skin.keptTriangles < BODY_TRIANGLES / 4, `face triangles ${skin.keptTriangles}`);
    assert.equal(subsetObservations.output.triangleCount, 984 + 768 + skin.keptTriangles);
    assert.deepEqual(subsetObservations.output.meshNames, ["Face", "Face.001", "Sphere.005_Retopology.004"]);

    const composed = await executeGltfComposeSkinnedOperation(objectStoreRoot, {
      inputs: { skeleton: outfit, parts: [single(subset)] }, parameters: { policy: { allowedValidatorWarnings: ALLOWED } },
    });
    const bytes = await resolveAssetObject(objectStoreRoot, single(composed));
    const observations = composed.observations as Json;
    const outputPath = process.env.ASSET_TOOLING_GLTF_SUBSET_OUT;
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
      await writeFile(`${outputPath}.observations.json`, JSON.stringify({ subset: subsetObservations, compose: observations }, null, 2));
    }
    assert.equal(observations.output.jointCount, 65);
    assert.ok(observations.parts[0].triangleCount < BODY_TRIANGLES / 3, `body part triangles ${observations.parts[0].triangleCount}`);
    assert.equal(observations.output.triangleCount, observations.skeleton.triangleCount + observations.parts[0].triangleCount);
    const validation = await validateBytes(bytes, { format: "glb", writeTimestamp: false, maxIssues: 0 });
    assert.equal(validation.issues.numErrors, 0);
    assert.deepEqual([...new Set(validation.issues.messages.filter((issue) => issue.severity === 1).map((issue) => issue.code))].filter((code) => !ALLOWED.includes(code)), []);
  } finally {
    await rm(objectStoreRoot, { recursive: true, force: true });
  }
});
