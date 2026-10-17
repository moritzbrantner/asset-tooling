/// <reference path="../src/gltf-validator.d.ts" />
// gltf-resources-v1 (asset.bundle@4, #118 owner decision Q4, #110): GLB scenes exported as glTF JSON whose
// buffers and images are hash-addressed external files stored once, plus doorway/collision attachments.
// Hand-authored skinned + animated fixtures cover shared-texture storage, closure tampering, corruption,
// interrupted export/resume, source-store-free loading and the deterministic release tar. The real-source
// test bundles the composed Ranger (docs/gltf-subset.md recipe); it skips on Git LFS pointers unless
// ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Document, NodeIO } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfComposeSkinnedOperation } from "../src/gltf-compose-operations.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { executeGltfSubsetSkinnedOperation } from "../src/gltf-subset-operations.js";
import { createAssetRef, type AssetOperationResult, type AssetRef } from "../src/operations.js";
import {
  ASSET_BUNDLE_MEDIA_TYPE, GLTF_RESOURCES_BUNDLE_OPERATION, GLTF_RESOURCES_BUNDLE_PROFILE, STATIC_ASSET_BUNDLE_PROFILE,
  createAssetBundleBuildIdentity, executeAssetBundleOperation, exportAssetBundle, listAssetBundleFiles,
  parseAssetBundleManifest, parseGltfResourcesBundleManifest, readAssetBundleAsset, readAssetBundleAttachment,
  readAssetBundleGltf, verifyAssetBundle, type GltfResourcesBundleManifest,
} from "../src/asset-bundle.js";
import { packAssetBundle, readAssetBundleTar, verifyAssetBundleTar } from "../src/asset-bundle-pack.js";

type Json = Record<string, any>;
const ALLOWED = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** A valid 1x1 RGB PNG; both fixture characters share these exact bytes. */
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

/** A two-joint skinned quad with a shared PNG texture and a named joint-translation clip. */
async function characterGlb(scale: number, clip: string): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const accessor = (type: "VEC2" | "VEC3" | "VEC4" | "MAT4" | "SCALAR", array: Float32Array | Uint8Array | Uint16Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const armature = document.createNode("Armature");
  scene.addChild(armature);
  const hips = document.createNode("hips").setTranslation([0, 1, 0]);
  const head = document.createNode("head").setTranslation([0, 0.5, 0]);
  armature.addChild(hips); hips.addChild(head);
  const skin = document.createSkin("skin").setSkeleton(hips)
    .setInverseBindMatrices(accessor("MAT4", new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.5, 0, 1])))
    .addJoint(hips).addJoint(head);
  const texture = document.createTexture("skin-color").setImage(png()).setMimeType("image/png");
  const material = document.createMaterial("skin-material").setBaseColorTexture(texture);
  const s = scale;
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 1, 0, s, 1, 0, s, 1 + s, 0, 0, 1 + s, 0])))
    .setAttribute("NORMAL", accessor("VEC3", new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])))
    .setAttribute("JOINTS_0", accessor("VEC4", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setAttribute("WEIGHTS_0", accessor("VEC4", new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(accessor("SCALAR", new Uint16Array([0, 1, 2, 0, 2, 3])))
    .setMaterial(material);
  scene.addChild(document.createNode("body-node").setMesh(document.createMesh("body").addPrimitive(primitive)).setSkin(skin));
  const sampler = document.createAnimationSampler().setInput(accessor("SCALAR", new Float32Array([0, 1])))
    .setOutput(accessor("VEC3", new Float32Array([0, 0.5, 0, 0, 0.6, 0]))).setInterpolation("LINEAR");
  document.createAnimation(clip).addSampler(sampler)
    .addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(head).setTargetPath("translation"));
  return Buffer.from(await new NodeIO().writeBinary(document));
}
/** A static triangle GLB as a collision attachment. */
async function collisionGlb(): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = document.createPrimitive().setAttribute("POSITION",
    document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer));
  document.createScene("collision").addChild(document.createNode("collider").setMesh(document.createMesh("collider").addPrimitive(primitive)));
  return Buffer.from(await new NodeIO().writeBinary(document));
}

async function workspace(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-resources-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = async (bytes: Uint8Array, kind: string, mediaType: string, metadata: Json = {}) =>
    (await storeAssetObject(root, { bytes, kind, mediaType, metadata })).asset;
  const archer = await store(await characterGlb(1, "idle"), "scene", "model/gltf-binary", { license: "CC0-1.0", sourceId: "fixture.archer" });
  const ranger = await store(await characterGlb(2, "walk"), "scene", "model/gltf-binary", { license: "CC0-1.0", sourceId: "fixture.ranger" });
  const doorways = await store(Buffer.from(`${canonicalJson({ schemaVersion: 1, doorways: [{ id: "front", position: [0, 0, 1] }] })}\n`), "scene-descriptor", "application/json");
  const collision = await store(await collisionGlb(), "mesh", "model/gltf-binary", { role: "collision" });
  const invocation = {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [
      { key: "character.ranger", variant: "default", attachments: [{ name: "doorways" }, { name: "collision" }] },
      { key: "character.archer", variant: "default" },
    ] },
    inputs: { assets: [ranger, archer], attachments: [doorways, collision] },
  };
  return { root, directory: path.join(root, "export"), archer, ranger, doorways, collision, invocation };
}
async function files(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) result.push(...await files(path.join(directory, child.name), relative));
    else result.push(relative);
  }
  return result.sort();
}
function manifestRef(bytes: Buffer): AssetRef {
  return createAssetRef({ kind: "asset-bundle", mediaType: ASSET_BUNDLE_MEDIA_TYPE, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength });
}
/** Re-pin a forged manifest so verification reaches the closure checks behind the manifest pin. */
async function forge(directory: string, edit: (manifest: Json) => void): Promise<AssetRef> {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  edit(manifest);
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  await writeFile(path.join(directory, "manifest.json"), bytes);
  return manifestRef(bytes);
}
const profile = { profile: GLTF_RESOURCES_BUNDLE_PROFILE } as const;

test("gltf-resources-v1 exports glTF scenes whose shared texture is stored once, with attachments and observations", async (t) => {
  const { root, directory, archer, ranger, doorways, collision, invocation } = await workspace(t);
  assert.deepEqual([GLTF_RESOURCES_BUNDLE_OPERATION.id, GLTF_RESOURCES_BUNDLE_OPERATION.version], ["asset.bundle", "4"]);
  const build = await createAssetBundleBuildIdentity(root, invocation);
  assert.deepEqual(build.operation, { id: "asset.bundle", version: "4" });
  assert.deepEqual((build.implementation as Json).policy.allowedValidatorWarnings, ALLOWED);
  assert.deepEqual(build.parameters, { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [
    { key: "character.archer", variant: "default", attachments: [] },
    { key: "character.ranger", variant: "default", attachments: [{ name: "collision" }, { name: "doorways" }] },
  ] });
  const operation = await executeAssetBundleOperation(root, invocation);
  const exported = await exportAssetBundle(root, directory, invocation);
  assert.deepEqual(exported.manifest, createAssetRef(operation.outputs.manifest));
  assert.equal(exported.manifestStatus, "changed");

  const png1 = sha256Bytes(png());
  assert.deepEqual(await files(directory), exported.files, "result.files is the complete fresh closure");
  assert.equal(exported.files.filter((file) => file.endsWith(".png")).length, 1, "the shared PNG is stored once");
  assert.ok(exported.files.includes(`resources/${png1}.png`));
  assert.ok(exported.files.includes("scenes/character.archer/default.gltf") && exported.files.includes("scenes/character.ranger/default.gltf"));
  assert.ok(exported.files.includes(`attachments/${doorways.sha256}.json`) && exported.files.includes(`attachments/${collision.sha256}.glb`));
  assert.equal(exported.files.filter((file) => file.endsWith(".bin")).length, 2, "one geometry/animation buffer per scene");

  const verified = await verifyAssetBundle(directory, exported.manifest, profile);
  const manifest: GltfResourcesBundleManifest = verified.manifest;
  assert.equal(manifest.schemaVersion, 4);
  assert.deepEqual(manifest.policy, { allowedValidatorWarnings: ALLOWED });
  assert.deepEqual(manifest.assets.map((entry) => entry.key), ["character.archer", "character.ranger"]);
  const [archerEntry, rangerEntry] = manifest.assets;
  assert.deepEqual(archerEntry!.source, archer);
  assert.deepEqual(rangerEntry!.source, ranger);
  assert.deepEqual(archerEntry!.observations, { skins: 1, animations: ["idle"], triangles: 2 });
  assert.deepEqual(rangerEntry!.observations, { skins: 1, animations: ["walk"], triangles: 2 });
  assert.deepEqual(rangerEntry!.attachments.map((a) => [a.name, a.path, a.mediaType]),
    [["collision", `attachments/${collision.sha256}.glb`, "model/gltf-binary"], ["doorways", `attachments/${doorways.sha256}.json`, "application/json"]]);
  const sharedImage = (entry: typeof archerEntry) => entry!.resources.find((r) => r.mediaType === "image/png")!;
  assert.equal(sharedImage(archerEntry).uri, `../../resources/${png1}.png`);
  assert.deepEqual(sharedImage(archerEntry), sharedImage(rangerEntry));
  assert.equal(archerEntry!.sha256, sha256Bytes(await readFile(path.join(directory, archerEntry!.path))));
  assert.deepEqual(parseGltfResourcesBundleManifest(await readFile(path.join(directory, "manifest.json"))), manifest);
  assert.deepEqual(listAssetBundleFiles(manifest), exported.files);

  // The exported .gltf validates with its external resources, and its accessor bytes equal the source GLB's.
  const { gltf, resources } = await readAssetBundleGltf(directory, manifest, "character.ranger", "default");
  assert.deepEqual([...resources.keys()].sort(), rangerEntry!.resources.map((r) => r.uri).sort());
  const report = await validateBytes(gltf, { format: "gltf", writeTimestamp: false, maxIssues: 0, externalResourceFunction: async (uri) => resources.get(uri)! });
  assert.equal(report.issues.numErrors, 0);
  assert.deepEqual(report.issues.messages.filter((issue) => issue.severity === 1 && !ALLOWED.includes(issue.code)), []);
  const io = new NodeIO();
  const packaged = await io.readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
  const original = await io.readBinary(await resolveAssetObject(root, ranger));
  const accessorBytes = (document: Document) => document.getRoot().listAccessors().map((accessor) => Buffer.from(accessor.getArray()!.buffer, accessor.getArray()!.byteOffset, accessor.getArray()!.byteLength).toString("hex"));
  assert.deepEqual(accessorBytes(packaged), accessorBytes(original));
  assert.equal(Buffer.from(packaged.getRoot().listTextures()[0]!.getImage()!).toString("hex"), Buffer.from(png()).toString("hex"));
  assert.deepEqual(packaged.getRoot().listAnimations().map((a) => a.getName()), ["walk"]);
  assert.equal(packaged.getRoot().listSkins()[0]!.listJoints().length, 2);
  assert.deepEqual(await readAssetBundleAttachment(directory, manifest, "character.ranger", "default", "doorways"), await resolveAssetObject(root, doorways));
  assert.deepEqual(await readAssetBundleAsset(directory, manifest, "character.archer", "default"), await readFile(path.join(directory, archerEntry!.path)));

  // Warm export reuses every file and leaves the manifest unchanged.
  const warm = await exportAssetBundle(root, directory, invocation);
  assert.deepEqual([warm.manifestStatus, warm.blobsWritten, warm.bytesWritten], ["unchanged", 0, 0]);
  assert.equal(warm.blobsReused, exported.blobsWritten);
});

test("gltf-resources-v1 loads with the source object store deleted and rejects other profiles' verification", async (t) => {
  const { root, directory, invocation } = await workspace(t);
  const exported = await exportAssetBundle(root, directory, invocation);
  await rm(path.join(root, ".asset-tooling"), { recursive: true, force: true });
  const { manifest } = await verifyAssetBundle(directory, exported.manifest, profile);
  const { gltf, resources } = await readAssetBundleGltf(directory, manifest, "character.archer", "default");
  const document = await new NodeIO().readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
  assert.equal(document.getRoot().listMeshes().length, 1);
  await assert.rejects(verifyAssetBundle(directory, exported.manifest), /selected verification profile|unsupported/);
  await assert.rejects(verifyAssetBundle(directory, exported.manifest, { profile: STATIC_ASSET_BUNDLE_PROFILE }), /selected verification profile|unsupported/);
  assert.throws(() => parseAssetBundleManifest(Buffer.from(canonicalJson(manifest))), /unsupported|requires exactly/);
});

test("gltf-resources-v1 verification rejects corruption and a broken resource closure", async (t) => {
  const { root, directory, invocation } = await workspace(t);
  const exported = await exportAssetBundle(root, directory, invocation);
  const manifest = (await verifyAssetBundle(directory, exported.manifest, profile)).manifest;
  const image = manifest.assets[0]!.resources.find((r) => r.mediaType === "image/png")!;
  const imageFile = path.join(directory, image.path), accepted = await readFile(imageFile);
  const corrupt = Buffer.from(accepted); corrupt[corrupt.length - 1]! ^= 1;
  await writeFile(imageFile, corrupt);
  await assert.rejects(verifyAssetBundle(directory, exported.manifest, profile), /hash does not match/);
  await rm(imageFile);
  await assert.rejects(verifyAssetBundle(directory, exported.manifest, profile), /ENOENT/);
  await writeFile(imageFile, accepted);

  // The glTF references a URI its entry does not list.
  const scene = path.join(directory, manifest.assets[0]!.path), acceptedScene = await readFile(scene);
  const json = JSON.parse(acceptedScene.toString("utf8"));
  json.images[0].uri = "../../resources/unlisted.png";
  const tampered = Buffer.from(`${canonicalJson(json)}\n`);
  await writeFile(scene, tampered);
  await assert.rejects(verifyAssetBundle(directory, exported.manifest, profile), /hash does not match/);
  let ref = await forge(directory, (m) => { m.assets[0].sha256 = sha256Bytes(tampered); });
  await assert.rejects(verifyAssetBundle(directory, ref, profile), /resource closure/);
  await writeFile(scene, acceptedScene);

  // The entry lists a resource its glTF does not reference.
  ref = await forge(directory, (m) => {
    m.assets[0].sha256 = sha256Bytes(acceptedScene);
    const extra = manifest.assets[1]!.resources.find((r) => r.mediaType === "application/octet-stream")!;
    m.assets[0].resources = [...m.assets[0].resources, extra].sort((a: Json, b: Json) => (a.path < b.path ? -1 : 1));
  });
  await assert.rejects(verifyAssetBundle(directory, ref, profile), /resource closure/);
  // Observations must describe the packaged glTF.
  ref = await forge(directory, (m) => { m.assets[0].resources = manifest.assets[0]!.resources; m.assets[0].observations.triangles = 3; });
  await assert.rejects(verifyAssetBundle(directory, ref, profile), /observations do not match/);
  // A forged path or policy fails parsing.
  ref = await forge(directory, (m) => { m.assets[0].observations = manifest.assets[0]!.observations; m.policy.allowedValidatorWarnings = []; });
  await assert.rejects(verifyAssetBundle(directory, ref, profile), /policy must allow exactly/);
  ref = await forge(directory, (m) => { m.policy = manifest.policy; m.assets[0].path = "scenes/other/default.gltf"; });
  await assert.rejects(verifyAssetBundle(directory, ref, profile), /path must be/);
  await forge(directory, (m) => { m.assets[0].path = manifest.assets[0]!.path; });
  await verifyAssetBundle(directory, exported.manifest, profile);
});

test("gltf-resources-v1 rejects incompatible selections before writing", async (t) => {
  const { root, directory, archer, doorways, invocation } = await workspace(t);
  const png1 = (await storeAssetObject(root, { bytes: png(), kind: "image", mediaType: "image/png" })).asset;
  const cases: [string, Json, RegExp][] = [
    ["image source", { ...invocation, inputs: { assets: [png1, archer], attachments: invocation.inputs.attachments } }, /incompatible with gltf-resources-v1/],
    ["missing attachment input", { ...invocation, inputs: { assets: invocation.inputs.assets, attachments: [doorways] } }, /one AssetRef per selected attachment/],
    ["png attachment", { ...invocation, inputs: { assets: invocation.inputs.assets, attachments: [doorways, png1] } }, /attachment media type 'image\/png'/],
    ["duplicate attachment", { ...invocation, parameters: { ...invocation.parameters, assets: [{ key: "a", variant: "b", attachments: [{ name: "x" }, { name: "x" }] }] }, inputs: { assets: [archer], attachments: [doorways, doorways] } }, /duplicate attachment names/],
    ["unknown field", { ...invocation, parameters: { ...invocation.parameters, assets: [{ key: "a", variant: "b", approved: {} }] }, inputs: { assets: [archer] } }, /requires exactly/],
  ];
  for (const [label, value, pattern] of cases) await assert.rejects(exportAssetBundle(root, directory, value), pattern, label);
  await assert.rejects(stat(directory), /ENOENT/, "no export directory was created");
});

test("interrupted gltf-resources-v1 export keeps the accepted manifest and resumes with completed files", async (t) => {
  const { root, directory, archer, invocation } = await workspace(t);
  const first = await exportAssetBundle(root, directory, invocation);
  const acceptedManifest = await readFile(path.join(directory, "manifest.json"));
  const edited = (await storeAssetObject(root, { bytes: await characterGlb(3, "run"), kind: "scene", mediaType: "model/gltf-binary" })).asset;
  const next = { ...invocation, inputs: { assets: [invocation.inputs.assets[0]!, edited], attachments: invocation.inputs.attachments } };
  const controller = new AbortController();
  await assert.rejects(exportAssetBundle(root, directory, next, { signal: controller.signal, onArtifact: (artifact) => { if (artifact.status === "changed") controller.abort(); } }), /abort/i);
  assert.deepEqual(await readFile(path.join(directory, "manifest.json")), acceptedManifest, "the accepted manifest survives");
  await verifyAssetBundle(directory, first.manifest, profile);
  await assert.rejects(exportAssetBundle(root, directory, next, { onArtifact: () => { throw new Error("callback failed"); } }), /callback failed/);
  assert.deepEqual(await readFile(path.join(directory, "manifest.json")), acceptedManifest);
  const resumed = await exportAssetBundle(root, directory, next);
  assert.equal(resumed.manifestStatus, "changed");
  assert.ok(resumed.blobsReused >= 4, `reused ${resumed.blobsReused}`);
  const { manifest } = await verifyAssetBundle(directory, resumed.manifest, profile);
  assert.equal(manifest.assets.find((entry) => entry.key === "character.archer")!.source.sha256, edited.sha256);
  assert.notEqual(edited.sha256, archer.sha256);
  // Retained former files stay in the directory; result.files is the active allowlist.
  assert.ok((await files(directory)).length > resumed.files.length);
  assert.deepEqual(listAssetBundleFiles(manifest), resumed.files);
});

test("pack produces a deterministic release tar that verifies offline and rejects tampering", async (t) => {
  const { root, directory, invocation } = await workspace(t);
  const exported = await exportAssetBundle(root, directory, invocation);
  const one = await packAssetBundle(directory), two = await packAssetBundle(directory);
  assert.ok(one.tar.equals(two.tar), "packing is byte-for-byte deterministic");
  assert.equal(one.sha256, sha256Bytes(one.tar));
  const entries = readAssetBundleTar(one.tar);
  assert.deepEqual(entries.map((entry) => entry.path), [...exported.files, "export.ref.json"].sort());
  assert.ok(entries.every((entry) => entry.mode === 0o644 && entry.mtime === 0 && entry.uid === 0 && entry.gid === 0));
  assert.deepEqual(JSON.parse(entries.find((entry) => entry.path === "export.ref.json")!.bytes.toString("utf8")), JSON.parse(canonicalJson(one.ref)));
  assert.equal(one.ref.sha256, exported.manifest.sha256);
  // A second, independent export packs to the same bytes.
  const other = path.join(root, "export-2");
  await exportAssetBundle(root, other, invocation);
  assert.ok((await packAssetBundle(other)).tar.equals(one.tar));

  const checked = await verifyAssetBundleTar(one.tar, { sha256: one.sha256, ref: exported.manifest });
  assert.equal(checked.manifest.profile, GLTF_RESOURCES_BUNDLE_PROFILE);
  await assert.rejects(verifyAssetBundleTar(one.tar, { sha256: "0".repeat(64) }), /sha256/);
  const tampered = Buffer.from(one.tar); tampered[tampered.length - 2048]! ^= 1;
  await assert.rejects(verifyAssetBundleTar(tampered, {}), /hash|checksum|pin/);
  await assert.rejects(verifyAssetBundleTar(one.tar, { ref: { ...exported.manifest, sha256: "1".repeat(64) } }), /hash|pin|length/);

  // The CLI writes <out>.tar and <out>.tar.sha256 and verifies them.
  const script = fileURLToPath(new URL("../scripts/pack-asset-bundle.ts", import.meta.url));
  const out = path.join(root, "dist", "bundle.tar");
  await mkdir(path.dirname(out), { recursive: true });
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  const packed = await run([directory, out]);
  assert.equal(packed.code, 0, packed.stderr);
  assert.ok((await readFile(out)).equals(one.tar));
  assert.equal(await readFile(`${out}.sha256`, "utf8"), `${one.sha256}  bundle.tar\n`);
  const verifiedCli = await run(["--verify", out]);
  assert.equal(verifiedCli.code, 0, verifiedCli.stderr);
  await writeFile(`${out}.sha256`, `${"0".repeat(64)}  bundle.tar\n`);
  assert.equal((await run(["--verify", out])).code, 1);
});

test("Codex P2 (#254): --verify requires exactly one valid sha256sum line in the sidecar", async (t) => {
  const { root, directory, invocation } = await workspace(t);
  await exportAssetBundle(root, directory, invocation);
  const script = fileURLToPath(new URL("../scripts/pack-asset-bundle.ts", import.meta.url));
  const out = path.join(root, "bundle.tar");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return { stderr, code };
  };
  assert.equal((await run([directory, out])).code, 0);
  const good = await readFile(`${out}.sha256`, "utf8"), digest = good.slice(0, 64);
  for (const sidecar of ["", "  \n", `${digest}\n`, `${digest.toUpperCase()}  bundle.tar\n`, `${digest}  other.tar\n`, `${good}${good}`, `${digest}  bundle.tar extra\n`]) {
    await writeFile(`${out}.sha256`, sidecar);
    const result = await run(["--verify", out]);
    assert.equal(result.code, 1, JSON.stringify(sidecar));
    assert.match(result.stderr, /must be exactly one line/, JSON.stringify(sidecar));
  }
  await writeFile(`${out}.sha256`, good);
  assert.equal((await run(["--verify", out])).code, 0);
});

test("Codex P2 (#254): verification counts scene .gltf bytes toward the 256 MiB distinct-payload budget", async (t) => {
  const { root, directory, invocation } = await workspace(t);
  await exportAssetBundle(root, directory, invocation);
  // Declared resources/attachments fill the budget to one byte below 256 MiB; only the scene bytes push it over.
  const ref = await forge(directory, (m) => {
    const declared = new Map<string, number>();
    for (const entry of m.assets) for (const file of [...entry.resources, ...entry.attachments]) declared.set(file.path, file.byteLength);
    let remaining = 256 * 1024 * 1024 - 1 - [...declared.values()].reduce((sum, n) => sum + n, 0);
    const fakes: Json[] = [];
    for (let index = 0; remaining > 0; index += 1) {
      const byteLength = Math.min(remaining, 64 * 1024 * 1024), sha256 = sha256Bytes(`fake-${index}`);
      fakes.push({ uri: `../../resources/${sha256}.bin`, path: `resources/${sha256}.bin`, sha256, byteLength, mediaType: "application/octet-stream" });
      remaining -= byteLength;
    }
    m.assets[0].resources = [...m.assets[0].resources, ...fakes].sort((a: Json, b: Json) => (a.path < b.path ? -1 : 1));
  });
  parseGltfResourcesBundleManifest(await readFile(path.join(directory, "manifest.json")));
  await assert.rejects(verifyAssetBundle(directory, ref, profile), /256 MiB unique payload budget/);
});

test("Codex P2 (#254): tar parsing rejects checksum-correct but non-canonical ustar headers", async (t) => {
  const { root, directory, invocation } = await workspace(t);
  await exportAssetBundle(root, directory, invocation);
  const { tar } = await packAssetBundle(directory);
  const rechecksum = (block: Buffer) => {
    block.fill(0x20, 148, 156);
    block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  };
  const edits: [string, (block: Buffer) => void][] = [
    ["owner name", (block) => { block.write("root", 265, "ascii"); }],
    ["ustar version", (block) => { block.write("01", 263, "ascii"); }],
    ["link name", (block) => { block.write("elsewhere", 157, "ascii"); }],
    ["reserved padding", (block) => { block[511] = 1; }],
  ];
  for (const [label, change] of edits) {
    const copy = Buffer.from(tar), block = copy.subarray(0, 512);
    change(block); rechecksum(block);
    assert.throws(() => readAssetBundleTar(copy), /non-canonical/, label);
  }
  assert.equal(readAssetBundleTar(tar).length > 0, true);
});

// ------------------------------------------------------- real hydrated sources

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";
const BODY = { archive: "quaternius.universal-base-characters-standard", gltf: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf" };
const OUTFIT = { archive: "quaternius.modular-character-outfits-fantasy-standard", gltf: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf" };
/** The Ranger recipe (docs/gltf-subset.md). */
const RANGER_HEAD_RECIPE = { keepJoints: ["neck_01", "Head"], minWeight: 0.5, keepMeshes: ["Face", "Face.001"], policy: { allowedValidatorWarnings: ALLOWED } };

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
  if (!pointers.length || REQUIRE_HYDRATED) return false;
  return `Git LFS payloads are not hydrated (e.g. ${pointers[0]}); run 'git lfs pull' or set ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`;
}
function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  assert.ok(output && !Array.isArray(output));
  return output;
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
  return single(await executeGltfProductionImportOperation(objectStoreRoot, {
    inputs: { source, resources }, parameters: { resourceUris: uris, policy: { allowedValidatorWarnings: ALLOWED } },
  }));
}

test("real sources: the composed Ranger character bundles as gltf-resources-v1 and verifies without its source store", { skip: await hydratedSkip(), timeout: 600_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gltf-resources-real-"));
  try {
    const outfit = await importMember(root, OUTFIT);
    const body = await importMember(root, BODY);
    const subset = await executeGltfSubsetSkinnedOperation(root, { inputs: { source: body }, parameters: RANGER_HEAD_RECIPE });
    const composed = single(await executeGltfComposeSkinnedOperation(root, {
      inputs: { skeleton: outfit, parts: [single(subset)] }, parameters: { policy: { allowedValidatorWarnings: ALLOWED } },
    }));
    const composedDocument = await new NodeIO().readBinary(await resolveAssetObject(root, composed));
    const directory = path.join(root, "export");
    const exported = await exportAssetBundle(root, directory, {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [{ key: "character.ranger", variant: "composed" }] },
      inputs: { assets: [composed] },
    });
    await rm(path.join(root, ".asset-tooling"), { recursive: true, force: true });
    const { manifest } = await verifyAssetBundle(directory, exported.manifest, profile);
    const entry = manifest.assets[0]!;
    assert.equal(entry.observations.skins, composedDocument.getRoot().listSkins().length);
    assert.equal(entry.observations.triangles, (await import("../src/gltf-processing.js")).gltfSummary(composedDocument).triangleCount);
    const images = entry.resources.filter((resource) => resource.mediaType.startsWith("image/"));
    assert.equal(images.length, new Set(composedDocument.getRoot().listTextures().map((texture) => sha256Bytes(texture.getImage()!))).size);
    assert.ok(images.length > 0);
    const { gltf, resources } = await readAssetBundleGltf(directory, manifest, "character.ranger", "composed");
    const packaged = await new NodeIO().readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
    assert.equal(packaged.getRoot().listSkins()[0]!.listJoints().length, 65);
    const tar = await packAssetBundle(directory);
    await verifyAssetBundleTar(tar.tar, { sha256: tar.sha256, ref: exported.manifest });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
