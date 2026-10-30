/// <reference path="../../src/gltf-validator.d.ts" />
// scene.compose.skinned.gltf@1 (#110, owner answer 2026-10-17: one GLB with body and outfit on the
// shared skeleton, no geometry removed). Small hand-authored skinned fixtures cover rebinding by
// joint name, byte-exact inverse bind matrices, failures, texture dedupe and replay. The real-source
// test imports the hydrated Male_Ranger outfit and Superhero body through scene.import.gltf@2 and
// composes them; it skips on Git LFS pointers unless ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1.
// Set ASSET_TOOLING_GLTF_COMPOSE_OUT to a file path to keep the composed real GLB (and <path>.observations.json).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Document, NodeIO } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { resolveAssetObject, storeAssetObject } from "../../src/asset-store.js";
import { createAssetCatalog } from "../../src/catalog.js";
import { importAssetCatalogStorageSource } from "../../src/catalog-storage.js";
import {
  GLTF_COMPOSE_SKINNED_OPERATION,
  createGltfComposeSkinnedOperationBuildIdentity,
  executeGltfComposeSkinnedOperation,
} from "../../src/gltf-compose-operations.js";
import { executeGltfProductionImportOperation } from "../../src/gltf-production-operations.js";
import type { AssetOperationResult, AssetRef } from "../../src/operations.js";

type Json = Record<string, any>;

// ------------------------------------------------------------------ fixtures

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(salt: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((2 * 3 + 1) * 2);
  for (let index = 0; index < rows.length; index += 1) if (index % 7) rows[index] = (index * 31 + salt) & 0xff;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}

interface PartOptions {
  mesh: string;
  /** Joint names, chain order (each a child of the previous), with local rest translations. */
  joints: [string, [number, number, number]][];
  textureSalt?: number;
  animation?: boolean;
  staticMesh?: boolean;
}

/** A self-contained GLB: Armature > joint chain, one skinned triangle mesh at the scene root. */
async function partGlb(options: PartOptions): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const armature = document.createNode("Armature");
  scene.addChild(armature);
  let parent = armature, worldY = 0;
  const jointNodes = [];
  const inverseBinds: number[] = [];
  for (const [name, translation] of options.joints) {
    const node = document.createNode(name).setTranslation(translation);
    parent.addChild(node);
    parent = node;
    worldY += translation[1];
    jointNodes.push(node);
    // Fixture rests only translate along Y, so each inverse bind is a pure translation.
    inverseBinds.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -translation[0], -worldY, -translation[2], 1);
  }
  const accessor = (type: "VEC3" | "VEC4" | "MAT4" | "SCALAR", array: Float32Array | Uint8Array | Uint16Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const texture = document.createTexture(`${options.mesh}-color`).setImage(png(options.textureSalt ?? 0)).setMimeType("image/png");
  const material = document.createMaterial(`${options.mesh}-material`).setBaseColorTexture(texture).setRoughnessFactor(0.75);
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute("NORMAL", accessor("VEC3", new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute("TEXCOORD_0", accessor("VEC3", new Float32Array([0, 0, 1, 0, 0, 1])).setType("VEC2"))
    .setAttribute("JOINTS_0", accessor("VEC4", new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setAttribute("WEIGHTS_0", accessor("VEC4", new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0])))
    .setIndices(accessor("SCALAR", new Uint16Array([0, 1, 2])))
    .setMaterial(material);
  const skin = document.createSkin(`${options.mesh}-skin`).setSkeleton(jointNodes[0]!)
    .setInverseBindMatrices(accessor("MAT4", new Float32Array(inverseBinds)));
  for (const node of jointNodes) skin.addJoint(node);
  scene.addChild(document.createNode(options.mesh).setMesh(document.createMesh(options.mesh).addPrimitive(primitive)).setSkin(skin));
  if (options.staticMesh) {
    const prop = document.createPrimitive().setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])));
    scene.addChild(document.createNode("prop").setMesh(document.createMesh("prop").addPrimitive(prop)));
  }
  if (options.animation) {
    const sampler = document.createAnimationSampler().setInput(accessor("SCALAR", new Float32Array([0, 1])))
      .setOutput(accessor("VEC3", new Float32Array([0, 1, 0, 0, 1.2, 0]))).setInterpolation("LINEAR");
    document.createAnimation("wave").addSampler(sampler)
      .addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(jointNodes[0]!).setTargetPath("translation"));
  }
  return new NodeIO().writeBinary(document);
}

const SKELETON_JOINTS: PartOptions["joints"] = [["hips", [0, 1, 0]], ["spine", [0, 0.5, 0]], ["head", [0, 0.3, 0]]];
// Same names and order, different rests (wider/taller), as the UBC body differs from the outfit.
const PART_JOINTS: PartOptions["joints"] = [["hips", [0, 1.1, 0]], ["spine", [0, 0.45, 0]], ["head", [0, 0.3, 0]]];

async function store(root: string, bytes: Uint8Array): Promise<AssetRef> {
  return (await storeAssetObject(root, { bytes, kind: "scene", mediaType: "model/gltf-binary" })).asset;
}

async function fixture(part: Partial<PartOptions> = {}, skeleton: Partial<PartOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-compose-"));
  const skeletonRef = await store(root, await partGlb({ mesh: "outfit", joints: SKELETON_JOINTS, textureSalt: 1, ...skeleton }));
  const partRef = await store(root, await partGlb({ mesh: "body", joints: PART_JOINTS, textureSalt: 2, ...part }));
  return { root, skeleton: skeletonRef, part: partRef, invocation: { inputs: { skeleton: skeletonRef, parts: [partRef] } } };
}

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  assert.ok(output && !Array.isArray(output));
  return output;
}

// ------------------------------------------------------------- behaviour

test("compose binds the part's skinned mesh to the skeleton's joint nodes by name and keeps its own inverse binds", async () => {
  const { root, part, invocation } = await fixture();
  try {
    assert.deepEqual([GLTF_COMPOSE_SKINNED_OPERATION.id, GLTF_COMPOSE_SKINNED_OPERATION.version], ["scene.compose.skinned.gltf", "1"]);
    const result = await executeGltfComposeSkinnedOperation(root, invocation);
    const output = await new NodeIO().readBinary(await resolveAssetObject(root, single(result)));
    const outputRoot = output.getRoot();
    // One skeleton: every joint name exists once, under the skeleton input's Armature.
    const names = outputRoot.listNodes().map((node) => node.getName());
    for (const joint of ["Armature", "hips", "spine", "head"]) assert.equal(names.filter((name) => name === joint).length, 1, joint);
    assert.deepEqual(outputRoot.listMeshes().map((mesh) => mesh.getName()), ["outfit", "body"]);
    const [outfitSkin, bodySkin] = outputRoot.listSkins();
    assert.ok(outfitSkin && bodySkin && outputRoot.listSkins().length === 2);
    assert.deepEqual(bodySkin.listJoints(), outfitSkin.listJoints(), "the part skin uses the skeleton's joint nodes");
    assert.equal(bodySkin.getSkeleton(), outfitSkin.getSkeleton());
    assert.equal(bodySkin.listJoints()[0]!.getTranslation()[1], 1, "skeleton rests are authoritative");
    // The part's inverse bind matrices are preserved byte-exact.
    const source = await new NodeIO().readBinary(await resolveAssetObject(root, part));
    const sourceIbm = source.getRoot().listSkins()[0]!.getInverseBindMatrices()!.getArray()!;
    const outputIbm = bodySkin.getInverseBindMatrices()!.getArray()!;
    assert.deepEqual(Buffer.from(outputIbm.buffer, outputIbm.byteOffset, outputIbm.byteLength), Buffer.from(sourceIbm.buffer, sourceIbm.byteOffset, sourceIbm.byteLength));
    const bodyPrimitive = outputRoot.listMeshes()[1]!.listPrimitives()[0]!;
    assert.deepEqual(Array.from(bodyPrimitive.getAttribute("WEIGHTS_0")!.getArray()!), [1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0]);
    assert.deepEqual(Array.from(bodyPrimitive.getAttribute("JOINTS_0")!.getArray()!), [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    assert.equal(bodyPrimitive.getMaterial()!.getName(), "body-material");
    // Observations.
    const observations = result.observations as Json;
    assert.equal(observations.skeleton.jointCount, 3);
    const report = observations.parts[0];
    assert.equal(report.jointCount, 3);
    assert.equal(report.meshesAdded, 1);
    assert.equal(report.skinsCreated, 1);
    assert.equal(report.triangleCount, 1);
    assert.deepEqual(report.restDifferences.differingJoints, ["hips", "spine"]);
    assert.ok(Math.abs(report.restDifferences.maxTranslationDelta - 0.1) < 1e-6);
    assert.equal(observations.output.skinCount, 2);
    assert.equal(observations.output.triangleCount, 2);
    assert.equal(observations.output.textureCount, 2);
    const validation = await validateBytes(await resolveAssetObject(root, single(result)), { format: "glb", writeTimestamp: false });
    assert.equal(validation.issues.numErrors, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compose output and build identity are deterministic across repeated runs", async () => {
  const { root, invocation } = await fixture();
  try {
    const first = await executeGltfComposeSkinnedOperation(root, invocation);
    const second = await executeGltfComposeSkinnedOperation(root, invocation);
    assert.deepEqual(second, first);
    const identity = await createGltfComposeSkinnedOperationBuildIdentity(root, invocation);
    assert.deepEqual(await createGltfComposeSkinnedOperationBuildIdentity(root, invocation), identity);
    assert.deepEqual(identity.operation, { id: "scene.compose.skinned.gltf", version: "1" });
    assert.deepEqual(identity.parameters, { policy: { allowedValidatorWarnings: [] } });
    assert.equal((identity.implementation as Json).id, "gltf-transform-skinned-compose");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical texture image bytes are deduplicated", async () => {
  const { root, invocation } = await fixture({ textureSalt: 1 });
  try {
    const result = await executeGltfComposeSkinnedOperation(root, invocation);
    const observations = result.observations as Json;
    assert.equal(observations.texturesDeduplicated, 1);
    assert.equal(observations.output.textureCount, 1);
    const output = await new NodeIO().readBinary(await resolveAssetObject(root, single(result)));
    const [outfit, body] = output.getRoot().listMaterials();
    assert.equal(body!.getBaseColorTexture(), outfit!.getBaseColorTexture());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compose fails visibly on a missing joint, duplicate joint names, animations and non-skinned part meshes", async () => {
  const cases: [string, Partial<PartOptions>, Partial<PartOptions>, RegExp][] = [
    ["missing joint", { joints: [...PART_JOINTS, ["tail", [0, -0.2, 0]]] }, {}, /COMPOSE_JOINT_MISSING: part joint 'tail'/],
    ["duplicate skeleton joint names", {}, { joints: [["hips", [0, 1, 0]], ["hips", [0, 0.5, 0]]] }, /COMPOSE_JOINT_NAME_DUPLICATE/],
    ["part animation", { animation: true }, {}, /parts\[0\]: \/animations: COMPOSE_ANIMATIONS_UNSUPPORTED/],
    ["skeleton animation", {}, { animation: true }, /skeleton: \/animations: COMPOSE_ANIMATIONS_UNSUPPORTED/],
    ["non-skinned part mesh", { staticMesh: true }, {}, /COMPOSE_NON_SKINNED_MESH: part mesh 'prop'/],
  ];
  for (const [label, part, skeleton, pattern] of cases) {
    const { root, invocation } = await fixture(part, skeleton);
    try {
      await assert.rejects(executeGltfComposeSkinnedOperation(root, invocation), pattern, label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("compose rejects unknown parameters and an empty parts list", async () => {
  const { root, skeleton, invocation } = await fixture();
  try {
    await assert.rejects(executeGltfComposeSkinnedOperation(root, { ...invocation, parameters: { meshNamePrefix: "x" } }), /unknown glTF compose parameter/);
    await assert.rejects(executeGltfComposeSkinnedOperation(root, { ...invocation, parameters: { policy: { allowedValidatorWarnings: ["UNUSED_OBJECT"] } } }), /allowedValidatorWarnings/);
    await assert.rejects(executeGltfComposeSkinnedOperation(root, { inputs: { skeleton, parts: [] } }), /parts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package subpath exports the compose operation", async () => {
  const api = await import("asset-tooling/operations/processing/gltf-compose");
  assert.equal(api.GLTF_COMPOSE_SKINNED_OPERATION, GLTF_COMPOSE_SKINNED_OPERATION);
  assert.equal(api.executeGltfComposeSkinnedOperation, executeGltfComposeSkinnedOperation);
  assert.equal(typeof api.createGltfComposeSkinnedOperationBuildIdentity, "function");
});

// ------------------------------------------------------- real hydrated sources

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";
const ALLOWED = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const BODY = { archive: "quaternius.universal-base-characters-standard", gltf: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf" };
const OUTFIT = { archive: "quaternius.modular-character-outfits-fantasy-standard", gltf: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf" };

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

test("real sources: Male_Ranger outfit (skeleton) and Superhero body compose into one 65-joint GLB", { skip: await hydratedSkip(), timeout: 600_000 }, async () => {
  const objectStoreRoot = await mkdtemp(path.join(os.tmpdir(), "gltf-compose-real-"));
  try {
    const outfit = await importMember(objectStoreRoot, OUTFIT);
    const body = await importMember(objectStoreRoot, BODY);
    const io = new NodeIO();
    const outfitDocument = await io.readBinary(await resolveAssetObject(objectStoreRoot, outfit));
    const bodyDocument = await io.readBinary(await resolveAssetObject(objectStoreRoot, body));
    const invocation = { inputs: { skeleton: outfit, parts: [body] }, parameters: { policy: { allowedValidatorWarnings: ALLOWED } } };
    const result = await executeGltfComposeSkinnedOperation(objectStoreRoot, invocation);
    const bytes = await resolveAssetObject(objectStoreRoot, single(result));
    const outputPath = process.env.ASSET_TOOLING_GLTF_COMPOSE_OUT;
    if (outputPath) { await mkdir(path.dirname(outputPath), { recursive: true }); await writeFile(outputPath, bytes); await writeFile(`${outputPath}.observations.json`, JSON.stringify(result.observations, null, 2)); }
    const output = await io.readBinary(bytes);
    const outputRoot = output.getRoot();
    const observations = result.observations as Json;
    assert.equal(observations.skeleton.jointCount, 65);
    assert.equal(observations.parts[0].jointCount, 65);
    assert.equal(observations.output.jointCount, 65);
    const jointSet = new Set(outputRoot.listSkins().flatMap((skin) => skin.listJoints()));
    assert.equal(jointSet.size, 65, "all skins share one 65-joint skeleton");
    assert.equal(outputRoot.listNodes().filter((node) => node.getName() === "Armature").length, 1);
    // Both mesh sets are present, every primitive kept.
    const meshNames = outputRoot.listMeshes().map((mesh) => mesh.getName());
    for (const mesh of [...outfitDocument.getRoot().listMeshes(), ...bodyDocument.getRoot().listMeshes()]) assert.ok(meshNames.includes(mesh.getName()), mesh.getName());
    assert.equal(outputRoot.listMeshes().length, outfitDocument.getRoot().listMeshes().length + bodyDocument.getRoot().listMeshes().length);
    assert.equal(observations.output.triangleCount, observations.skeleton.triangleCount + observations.parts[0].triangleCount);
    assert.ok(observations.parts[0].restDifferences.differingJointCount > 0, "the UBC body's limb rests differ from the outfit's");
    // Each body skin keeps its own inverse bind matrices.
    const bodyIbms = bodyDocument.getRoot().listSkins().map((skin) => Array.from(skin.getInverseBindMatrices()!.getArray()!));
    const outputIbms = outputRoot.listSkins().slice(outfitDocument.getRoot().listSkins().length).map((skin) => Array.from(skin.getInverseBindMatrices()!.getArray()!));
    assert.deepEqual(outputIbms, bodyIbms);
    const validation = await validateBytes(bytes, { format: "glb", writeTimestamp: false, maxIssues: 0 });
    assert.equal(validation.issues.numErrors, 0);
    assert.deepEqual([...new Set(validation.issues.messages.filter((issue) => issue.severity === 1).map((issue) => issue.code))].filter((code) => !ALLOWED.includes(code)), []);
  } finally {
    await rm(objectStoreRoot, { recursive: true, force: true });
  }
});
