/// <reference path="../../src/gltf-validator.d.ts" />
// scene.place.gltf@1 (#118, owner decision Q3, 2026-10-14: one named parent node with an exact
// translation; vertices are not baked; routine default origin at the footprint's base centre).
// Small hand-authored fixtures cover a static mesh offset from the origin, a nested hierarchy with a
// source pivot, a skinned mesh, byte-exact accessors, the anchor math, explicit translations, name
// collisions, bad parameters and replay. The real-source test imports the hydrated Greyhaven wall and
// barrel through scene.import.gltf@2 and places them at the footprint base centre; it skips on Git LFS
// pointers unless ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Document, NodeIO, type Accessor } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { resolveAssetObject, storeAssetObject } from "../../src/asset-store.js";
import { createAssetCatalog } from "../../src/catalog.js";
import { importAssetCatalogStorageSource } from "../../src/catalog-storage.js";
import { executeGltfProductionImportOperation } from "../../src/gltf-production-operations.js";
import { GLTF_PLACE_OPERATION, createGltfPlaceOperationBuildIdentity, executeGltfPlaceOperation } from "../../src/gltf-place-operations.js";
import type { AssetOperationResult, AssetRef } from "../../src/operations.js";

type Json = Record<string, any>;
type Vec3 = [number, number, number];

// ------------------------------------------------------------------ fixtures

/** Unit box spanning x,z in [-0.5, 0.5] and y in [0, 1], mesh-local. */
const BOX = new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0.5, -0.5, 1, 0.5]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

function meshOf(document: Document, name: string, positions: Float32Array) {
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions.length).map((_, index) => (index % 3 === 1 ? 1 : 0))).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(QUAD_INDICES).setBuffer(buffer))
    .setMaterial(document.createMaterial(`${name}-material`).setRoughnessFactor(0.5));
  return document.createMesh(name).addPrimitive(primitive);
}

/** One box node offset from the origin: translation [3, 1, -2], uniform scale 2. World x [2, 4], y [1, 3], z [-3, -1]. */
async function staticGlb(): Promise<Uint8Array> {
  const document = new Document();
  document.createBuffer();
  const scene = document.createScene("Scene");
  scene.addChild(document.createNode("crate").setMesh(meshOf(document, "crate", BOX)).setTranslation([3, 1, -2]).setScale([2, 2, 2]));
  return new NodeIO().writeBinary(document);
}

/**
 * Two roots. `house` (translation [10, 0.5, 0], rotated 90° about +Y) holds the box and a child
 * `door` at local [0.5, 0, 0], which also instances the box. `sign` is a separate root at [10, 2, 5].
 */
async function nestedGlb(): Promise<Uint8Array> {
  const document = new Document();
  document.createBuffer();
  const scene = document.createScene("Scene");
  const box = meshOf(document, "box", BOX);
  const s = Math.SQRT1_2;
  const house = document.createNode("house").setMesh(box).setTranslation([10, 0.5, 0]).setRotation([0, s, 0, s]);
  house.addChild(document.createNode("door").setMesh(box).setTranslation([0.5, 0, 0]));
  scene.addChild(house);
  scene.addChild(document.createNode("sign").setMesh(meshOf(document, "sign", new Float32Array([0, 0, 0, 0.2, 0, 0, 0.2, 0.3, 0, 0, 0.3, 0]))).setTranslation([10, 2, 5]));
  return new NodeIO().writeBinary(document);
}

/**
 * A skinned quad: `Armature` at [0, 0, 4] holds joint `root` (local [1, 0, 0]); the quad is bound
 * in that bind pose, so its bind-pose (world) positions are the POSITION values x [0.5, 1.5], y [0.25, 1.25], z 4.
 */
async function skinnedGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const armature = document.createNode("Armature").setTranslation([0, 0, 4]);
  const joint = document.createNode("root").setTranslation([1, 0, 0]);
  armature.addChild(joint);
  scene.addChild(armature);
  const skin = document.createSkin("skin").setSkeleton(joint).addJoint(joint)
    .setInverseBindMatrices(document.createAccessor().setType("MAT4").setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, -4, 1])).setBuffer(buffer));
  const positions = new Float32Array([0.5, 0.25, 4, 1.5, 0.25, 4, 1.5, 1.25, 4, 0.5, 1.25, 4]);
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
    .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(new Uint8Array(16)).setBuffer(buffer))
    .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(QUAD_INDICES).setBuffer(buffer));
  scene.addChild(document.createNode("body").setMesh(document.createMesh("body").addPrimitive(primitive)).setSkin(skin));
  return new NodeIO().writeBinary(document);
}

async function fixture(glb: Uint8Array) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-place-"));
  const source = (await storeAssetObject(root, { bytes: glb, kind: "scene", mediaType: "model/gltf-binary" })).asset;
  return { root, source, run: (parameters: Json) => executeGltfPlaceOperation(root, { inputs: { source }, parameters }) };
}

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  assert.ok(output && !Array.isArray(output));
  return output;
}

/** The GLB's JSON chunk, to read the exact written numbers. */
function glbJson(bytes: Uint8Array): Json {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
}

const accessorBytes = (accessor: Accessor) => {
  const array = accessor.getArray()!;
  return { type: accessor.getType(), componentType: accessor.getComponentType(), normalized: accessor.getNormalized(), bytes: Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString("hex") };
};

/** Every accessor of output equals source's, in order, byte for byte. */
async function assertAccessorsByteExact(root: string, source: AssetRef, output: AssetRef) {
  const io = new NodeIO();
  const before = (await io.readBinary(await resolveAssetObject(root, source))).getRoot().listAccessors().map(accessorBytes);
  const after = (await io.readBinary(await resolveAssetObject(root, output))).getRoot().listAccessors().map(accessorBytes);
  assert.ok(before.length > 0);
  assert.deepEqual(after, before, "accessor bytes are unchanged");
}

/** Independent world-space bounds for static meshes (node world matrices only). */
function staticWorldBounds(document: Document) {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const node of document.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const m = node.getWorldMatrix();
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION")!;
      const p: number[] = [];
      for (let vertex = 0; vertex < positions.getCount(); vertex += 1) {
        positions.getElement(vertex, p);
        const world = [0, 1, 2].map((row) => m[row]! * p[0]! + m[4 + row]! * p[1]! + m[8 + row]! * p[2]! + m[12 + row]!);
        world.forEach((value, axis) => { min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value); });
      }
    }
  }
  return { min, max };
}

const near = (actual: number[], expected: number[], tolerance = 1e-9, label = "") =>
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]!) <= tolerance, `${label}[${index}] ${value} vs ${expected[index]}`));

// ------------------------------------------------------------- behaviour

test("footprint-base-center moves a static mesh's base centre to the origin under one named parent, without baking vertices", async () => {
  const { root, source, run } = await fixture(await staticGlb());
  try {
    assert.deepEqual([GLTF_PLACE_OPERATION.id, GLTF_PLACE_OPERATION.version], ["scene.place.gltf", "1"]);
    const result = await run({ parentName: "crate-placed", anchor: "footprint-base-center" });
    const observations = result.observations as Json;
    assert.deepEqual(observations.translation, [-3, -1, 2]);
    assert.deepEqual(observations.bounds.source.min, [2, 1, -3]);
    assert.deepEqual(observations.bounds.source.max, [4, 3, -1]);
    assert.deepEqual(observations.bounds.placed.min, [-1, 0, -1]);
    assert.deepEqual(observations.bounds.placed.max, [1, 2, 1]);
    assert.deepEqual(observations.footprint, { width: 2, depth: 2, height: 2 });
    assert.equal(observations.verticesBaked, false);
    assert.deepEqual(observations.reparentedRoots, ["crate"]);

    const bytes = await resolveAssetObject(root, single(result));
    const json = glbJson(bytes);
    assert.equal(json.scenes.length, 1);
    assert.equal(json.scenes[0].nodes.length, 1, "the scene's only root is the new parent");
    const parent = json.nodes[json.scenes[0].nodes[0]];
    assert.equal(parent.name, "crate-placed");
    assert.deepEqual(parent.translation, [-3, -1, 2]);
    assert.equal(parent.mesh, undefined);
    assert.deepEqual(parent.children.map((index: number) => json.nodes[index].name), ["crate"]);
    const crate = json.nodes.find((node: Json) => node.name === "crate");
    assert.deepEqual([crate.translation, crate.scale], [[3, 1, -2], [2, 2, 2]], "original root transforms are kept");
    await assertAccessorsByteExact(root, source, single(result));
    const placed = staticWorldBounds(await new NodeIO().readBinary(bytes));
    near(placed.min, [-1, 0, -1]); near(placed.max, [1, 2, 1]);
    const validation = await validateBytes(bytes, { format: "glb", writeTimestamp: false });
    assert.equal(validation.issues.numErrors, 0);
    assert.equal(validation.issues.numWarnings, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a nested hierarchy keeps every node and local transform; world placement shifts exactly; sourcePivot records a node's world position", async () => {
  const { root, source, run } = await fixture(await nestedGlb());
  try {
    const result = await run({ parentName: "placed", anchor: "footprint-base-center", sourcePivot: { node: "door" } });
    const observations = result.observations as Json;
    // house rotated +90° about Y maps local (x, z) to (z, -x): box at x [9.5, 10.5], z [-0.5, 0.5]; door at local
    // [0.5, 0, 0] sits at world [10, 0.5, -0.5] with z [-1, 0]; sign spans x [10, 10.2], y [2, 2.3], z 5.
    const before = observations.bounds.source;
    near(before.min, [9.5, 0.5, -1]); near(before.max, [10.5, 2.3, 5], 1e-6);
    near(observations.translation, [-10, -0.5, -2], 1e-12);
    near(observations.sourcePivot.sourceWorldPosition, [10, 0.5, -0.5], 1e-12);
    near(observations.sourcePivot.placedWorldPosition, [0, 0, -2.5], 1e-12);
    assert.equal(observations.sourcePivot.node, "door");
    assert.deepEqual(observations.reparentedRoots, ["house", "sign"]);
    near(observations.bounds.placed.min, [-0.5, 0, -3], 1e-6);
    assert.equal(observations.bounds.placed.min[1], 0);

    const io = new NodeIO();
    const sourceDocument = await io.readBinary(await resolveAssetObject(root, source));
    const output = await io.readBinary(await resolveAssetObject(root, single(result)));
    const scene = output.getRoot().listScenes()[0]!;
    assert.deepEqual(scene.listChildren().map((node) => node.getName()), ["placed"]);
    const parent = scene.listChildren()[0]!;
    assert.deepEqual(parent.listChildren().map((node) => node.getName()), ["house", "sign"]);
    assert.deepEqual(output.getRoot().listNodes().map((node) => node.getName()), ["house", "door", "sign", "placed"]);
    const t = parent.getTranslation();
    for (const node of sourceDocument.getRoot().listNodes()) {
      const placed = output.getRoot().listNodes().find((candidate) => candidate.getName() === node.getName())!;
      assert.deepEqual([placed.getTranslation(), placed.getRotation(), placed.getScale()], [node.getTranslation(), node.getRotation(), node.getScale()], `${node.getName()} local TRS`);
      assert.deepEqual(placed.listChildren().map((child) => child.getName()), node.listChildren().map((child) => child.getName()));
      const a = node.getWorldMatrix(), b = placed.getWorldMatrix();
      near([b[12], b[13], b[14]], [a[12] + t[0], a[13] + t[1], a[14] + t[2]], 1e-12, `${node.getName()} world`);
    }
    await assertAccessorsByteExact(root, source, single(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit translation is written exactly, whatever the bounds", async () => {
  const { root, source, run } = await fixture(await nestedGlb());
  try {
    const translation = [1.25, -0.1, 1e-7];
    const result = await run({ parentName: "placed", translation: [1.25, -0.1, 1e-7] });
    assert.deepEqual((result.observations as Json).translation, translation);
    assert.equal((result.observations as Json).mode, "translation");
    const json = glbJson(await resolveAssetObject(root, single(result)));
    assert.deepEqual(json.nodes.find((node: Json) => node.name === "placed").translation, translation, "JSON carries the exact doubles");
    await assertAccessorsByteExact(root, source, single(result));
    // A zero translation stays a plain parent; -0 is canonicalized.
    const zero = await run({ parentName: "placed", translation: [-0, 0, 0] });
    assert.ok(Object.is((zero.observations as Json).translation[0], 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skinned mesh is bounded by its bind-pose positions and moves with its reparented joints", async () => {
  const { root, source, run } = await fixture(await skinnedGlb());
  try {
    // The skinned body node ends up below the parent, so its glTF warning must be declared.
    await assert.rejects(run({ parentName: "placed", anchor: "footprint-base-center" }), /NODE_SKINNED_MESH_NON_ROOT/);
    const result = await run({ parentName: "placed", anchor: "footprint-base-center", policy: { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT"] } });
    const observations = result.observations as Json;
    assert.deepEqual(observations.bounds.source.min, [0.5, 0.25, 4]);
    assert.deepEqual(observations.bounds.source.max, [1.5, 1.25, 4]);
    assert.deepEqual(observations.translation, [-1, -0.25, -4]);
    near(observations.bounds.placed.min, [-0.5, 0, 0], 1e-6);
    near(observations.bounds.placed.max, [0.5, 1, 0], 1e-6);
    assert.deepEqual(observations.reparentedRoots, ["Armature", "body"]);
    assert.ok(observations.weightSums);
    assert.deepEqual(observations.outputValidatorWarnings.map((warning: Json) => warning.code), ["NODE_SKINNED_MESH_NON_ROOT"]);
    const output = await new NodeIO().readBinary(await resolveAssetObject(root, single(result)));
    const skin = output.getRoot().listSkins()[0]!;
    assert.deepEqual(skin.listJoints().map((joint) => joint.getName()), ["root"]);
    near(Array.from(skin.listJoints()[0]!.getWorldMatrix()).slice(12, 15), [0, -0.25, 0], 1e-12);
    await assertAccessorsByteExact(root, source, single(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("place output and build identity are deterministic", async () => {
  const { root, source, run } = await fixture(await nestedGlb());
  try {
    const parameters = { parentName: "placed", anchor: "footprint-base-center", sourcePivot: { node: "door" } };
    assert.deepEqual(await run(parameters), await run(parameters));
    const invocation = { inputs: { source }, parameters };
    const identity = await createGltfPlaceOperationBuildIdentity(root, invocation);
    assert.deepEqual(await createGltfPlaceOperationBuildIdentity(root, invocation), identity);
    assert.deepEqual(identity.operation, { id: "scene.place.gltf", version: "1" });
    assert.deepEqual(identity.parameters, { ...parameters, policy: { allowedValidatorWarnings: [] } });
    assert.equal((identity.implementation as Json).id, "gltf-transform-place");
    const other = await createGltfPlaceOperationBuildIdentity(root, { ...invocation, parameters: { parentName: "placed", translation: [0, 0, 0] } });
    assert.notDeepEqual(other.parameters, identity.parameters);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("place fails visibly on a parent name collision, a missing pivot and bad parameters, and stores nothing", async () => {
  const { root, run } = await fixture(await nestedGlb());
  try {
    const before = (await readdir(root, { recursive: true })).map(String).sort();
    await assert.rejects(run({ parentName: "door", anchor: "footprint-base-center" }), /PLACE_PARENT_NAME_COLLISION: parentName 'door'/);
    await assert.rejects(run({ parentName: "placed", anchor: "footprint-base-center", sourcePivot: { node: "hinge" } }), /PLACE_PIVOT_NODE_MISSING: sourcePivot.node 'hinge'/);
    await assert.rejects(run({ parentName: "placed" }), /exactly one of translation or anchor/);
    await assert.rejects(run({ parentName: "placed", translation: [0, 0, 0], anchor: "footprint-base-center" }), /exactly one of translation or anchor/);
    await assert.rejects(run({ parentName: "placed", translation: [0, Number.NaN, 0] }), /three finite numbers/);
    await assert.rejects(run({ parentName: "placed", translation: [0, 0] }), /three finite numbers/);
    await assert.rejects(run({ parentName: "placed", anchor: "center" }), /anchor must be one of footprint-base-center/);
    await assert.rejects(run({ parentName: "", anchor: "footprint-base-center" }), /parentName must be a non-empty string/);
    await assert.rejects(run({ anchor: "footprint-base-center" }), /parentName must be a non-empty string/);
    await assert.rejects(run({ parentName: "placed", anchor: "footprint-base-center", rotation: [0, 0, 0, 1] }), /unknown glTF place parameter 'rotation'/);
    await assert.rejects(run({ parentName: "placed", anchor: "footprint-base-center", sourcePivot: { node: "door", axis: "y" } }), /unknown sourcePivot field 'axis'/);
    await assert.rejects(run({ parentName: "placed", anchor: "footprint-base-center", policy: { allowedValidatorWarnings: ["UNUSED_OBJECT"] } }), /allowedValidatorWarnings/);
    assert.deepEqual((await readdir(root, { recursive: true })).map(String).sort(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package subpath exports the place operation", async () => {
  const api = await import("asset-tooling/operations/processing/gltf-place");
  assert.equal(api.GLTF_PLACE_OPERATION, GLTF_PLACE_OPERATION);
  assert.equal(api.executeGltfPlaceOperation, executeGltfPlaceOperation);
  assert.equal(typeof api.createGltfPlaceOperationBuildIdentity, "function");
});

// ------------------------------------------------------- real hydrated sources

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";
const TANGENT_WARNING = "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE";
const REAL = [
  { label: "wall", archive: "quaternius.medieval-village-megakit-standard", gltf: "glTF/Wall_Plaster_Door_Flat.gltf", parentName: "Wall_Plaster_Door_Flat_Placed" },
  { label: "barrel", archive: "quaternius.fantasy-props-megakit-standard", gltf: "Exports/glTF/Barrel.gltf", parentName: "Barrel_Placed" },
];

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

/** The single registered member of `archive` with the URI's basename (docs/greyhaven-starter-sources.md). */
function resourceId(archive: string, uri: string): string {
  const name = path.posix.basename(decodeURIComponent(uri));
  const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === name);
  assert.equal(matches.length, 1, `URI '${uri}' must resolve to one member`);
  return matches[0]!.id;
}

async function hydratedSkip(): Promise<string | false> {
  const pointers: string[] = [];
  for (const { archive, gltf } of REAL) {
    const entry = storageDocument.entries.find((candidate: Json) => candidate.sourceId === memberId(archive, gltf));
    const bytes = await readFile(path.join(ROOT, entry.path));
    if (bytes.subarray(0, 128).toString("utf8").startsWith(LFS_POINTER_PREFIX)) pointers.push(entry.path);
  }
  if (!pointers.length || REQUIRE_HYDRATED) return false; // with the flag, a pointer fails the test instead
  return `Git LFS payloads are not hydrated (e.g. ${pointers[0]}); run 'git lfs pull' or set ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`;
}

async function importMember(objectStoreRoot: string, archive: string, gltf: string): Promise<AssetRef> {
  const { asset: source } = await importAssetCatalogStorageSource({ catalog, storage: storageDocument, sourceId: memberId(archive, gltf), storageRoot: ROOT, objectStoreRoot });
  const json = JSON.parse((await resolveAssetObject(objectStoreRoot, source)).toString("utf8"));
  const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((entry: Json) => entry.uri);
  const resources: AssetRef[] = [];
  for (const uri of uris) {
    resources.push((await importAssetCatalogStorageSource({ catalog, storage: storageDocument, sourceId: resourceId(archive, uri), storageRoot: ROOT, objectStoreRoot })).asset);
  }
  return single(await executeGltfProductionImportOperation(objectStoreRoot, {
    inputs: { source, resources }, parameters: { resourceUris: uris, policy: { allowedValidatorWarnings: [TANGENT_WARNING] } },
  }));
}

test("real sources: the Greyhaven wall and barrel are placed with their footprint base centre at the origin", { skip: await hydratedSkip(), timeout: 600_000 }, async () => {
  const objectStoreRoot = await mkdtemp(path.join(os.tmpdir(), "gltf-place-real-"));
  try {
    for (const asset of REAL) {
      const imported = await importMember(objectStoreRoot, asset.archive, asset.gltf);
      const parameters = { parentName: asset.parentName, anchor: "footprint-base-center", policy: { allowedValidatorWarnings: [TANGENT_WARNING] } };
      const result = await executeGltfPlaceOperation(objectStoreRoot, { inputs: { source: imported }, parameters });
      const bytes = await resolveAssetObject(objectStoreRoot, single(result));
      const placed = staticWorldBounds(await new NodeIO().readBinary(bytes));
      assert.ok(Math.abs(placed.min[1]) <= 1e-6, `${asset.label}: min Y ${placed.min[1]}`);
      assert.ok(Math.abs((placed.min[0] + placed.max[0]) / 2) <= 1e-6, `${asset.label}: centre X`);
      assert.ok(Math.abs((placed.min[2] + placed.max[2]) / 2) <= 1e-6, `${asset.label}: centre Z`);
      const observations = result.observations as Json;
      near(observations.bounds.placed.min, placed.min, 1e-9, `${asset.label} placed min`);
      near(observations.bounds.placed.max, placed.max, 1e-9, `${asset.label} placed max`);
      assert.deepEqual([...new Set(observations.outputValidatorWarnings.map((warning: Json) => warning.code))], [TANGENT_WARNING]);
      await assertAccessorsByteExact(objectStoreRoot, imported, single(result));
      const json = glbJson(bytes);
      assert.deepEqual(json.scenes[0].nodes.map((index: number) => json.nodes[index].name), [asset.parentName]);
      const validation = await validateBytes(bytes, { format: "glb", writeTimestamp: false, maxIssues: 0 });
      assert.equal(validation.issues.numErrors, 0);
      assert.deepEqual(await executeGltfPlaceOperation(objectStoreRoot, { inputs: { source: imported }, parameters }), result, `${asset.label}: replay`);
    }
  } finally {
    await rm(objectStoreRoot, { recursive: true, force: true });
  }
});
