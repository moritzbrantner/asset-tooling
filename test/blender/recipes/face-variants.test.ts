// Ranger facial variants (#348): the option table, the morph-target transfer, and with Blender and the hydrated UBC
// bodies, the authored shape keys on the real male and female head parts composed onto their Ranger outfits.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { resolveAssetObject } from "../../../src/asset-store.js";
import { createAssetCatalog } from "../../../src/catalog.js";
import { importAssetCatalogStorageSource } from "../../../src/catalog-storage.js";
import { FACE_FEATURES, FACE_MORPH_NODES, FACE_MORPH_TARGETS, addFaceVariants, faceAppearance, transferFaceMorphs } from "../../../src/face-variants.js";
import { executeGltfComposeSkinnedOperation } from "../../../src/gltf-compose-operations.js";
import { executeGltfProductionImportOperation } from "../../../src/gltf-production-operations.js";
import { executeGltfSubsetSkinnedOperation } from "../../../src/gltf-subset-operations.js";
import type { AssetOperationResult, AssetRef } from "../../../src/operations.js";
import { RANGER_FIGURES, RANGER_HEAD_RECIPE } from "../../../scripts/build-ranger-character.js";

type Json = Record<string, any>;
const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("face options: four features, a base and two keys each, matching the Blender recipe's keys", async () => {
  assert.deepEqual(FACE_FEATURES.map((feature) => feature.id), ["face", "eyes", "nose", "mouth"]);
  assert.deepEqual(FACE_MORPH_TARGETS, ["face.broad", "face.narrow", "eyes.large", "eyes.narrow", "nose.broad", "nose.long", "mouth.full", "mouth.thin"]);
  const script = await readFile(path.join(ROOT, "adapters/blender/face_variants.py"), "utf8");
  for (const feature of FACE_FEATURES) {
    const keys = feature.options.slice(1).map(([id]) => `"${id}"`).join(", ");
    assert.ok(script.includes(`"${feature.id}": [${keys}]`), `face_variants.py declares ${feature.id}: ${keys}`);
  }
  const face = faceAppearance({ nodes: FACE_MORPH_NODES.male, variants: ["default", "skin.light"], unsupported: ["lod1"] });
  assert.deepEqual(face.unsupported.variants, ["lod1"]);
  assert.deepEqual(face.features[1], { id: "eyes", label: "Eyes", default: "eyes.base", options: [
    { id: "eyes.base", label: "Base", morphs: {} }, { id: "eyes.large", label: "Large", morphs: { "eyes.large": 1 } },
    { id: "eyes.narrow", label: "Narrow, almond", morphs: { "eyes.narrow": 1 } }] });
});

/** One triangle mesh node `Eyes`; `targets` adds the face keys with the given per-vertex position deltas. */
async function triangle(order: number[], targets?: (vertex: number, key: number) => number[]) {
  const document = new Document();
  const buffer = document.createBuffer();
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  const positions = order.flatMap((vertex) => corners[vertex]!);
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer));
  const mesh = document.createMesh("Face.001").addPrimitive(primitive);
  if (targets) {
    FACE_MORPH_TARGETS.forEach((name, key) => primitive.addTarget(document.createPrimitiveTarget(name).setAttribute("POSITION",
      document.createAccessor().setType("VEC3").setArray(new Float32Array(order.flatMap((vertex) => targets(vertex, key)))).setBuffer(buffer))));
    mesh.setExtras({ targetNames: [...FACE_MORPH_TARGETS] }).setWeights(FACE_MORPH_TARGETS.map(() => 0));
  }
  document.createScene().addChild(document.createNode("Eyes").setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

test("the transfer copies each authored vertex's deltas onto the source vertex at the same position", async () => {
  const delta = (vertex: number, key: number) => (vertex === 1 ? [0, 0, (key + 1) / 100] : [0, 0, 0]);
  const { glb, transfer } = await transferFaceMorphs(await triangle([0, 1, 2]), await triangle([2, 0, 1], delta));
  const document = await new NodeIO().readBinary(glb);
  const mesh = document.getRoot().listMeshes()[0]!;
  assert.deepEqual((mesh.getExtras() as Json).targetNames, FACE_MORPH_TARGETS);
  const targets = mesh.listPrimitives()[0]!.listTargets();
  assert.deepEqual(targets.map((target) => target.getName()), FACE_MORPH_TARGETS);
  assert.deepEqual([...targets[3]!.getAttribute("POSITION")!.getArray()!].map((value) => Math.round(value * 100)), [0, 0, 0, 0, 0, 4, 0, 0, 0]);
  assert.equal(targets[3]!.getAttribute("POSITION")!.getSparse(), true);
  assert.equal(transfer.Eyes!.movedVertices["mouth.thin"], 1);

  const moved = await triangle([0, 1, 2]);
  const document2 = await new NodeIO().readBinary(await triangle([0, 1, 2], delta));
  document2.getRoot().listAccessors()[0]!.setElement(1, [1, 0.5, 0]);
  await assert.rejects(transferFaceMorphs(moved, await new NodeIO().writeBinary(document2)), /vertex 1 .* has no authored counterpart/);
  await assert.rejects(transferFaceMorphs(moved, moved), /no morph targets/);
});

// ------------------------------------------------------------- real head parts in Blender

const blender = process.env.ASSET_TOOLING_BLENDER && process.env.BLENDER_TESTS === "1";
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const POLICY = { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] };
const single = (result: AssetOperationResult) => result.outputs.output as AssetRef;

async function importer(objectStoreRoot: string) {
  const read = async (file: string) => JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
  const [providers, sources, storage] = [await read("catalog/providers.json"), await read("catalog/sources.json"), await read("catalog/storage.json")];
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const ids = (match: (source: Json) => boolean) => (sources.sources as Json[]).filter(match).map((source) => source.id as string);
  const member = async (sourceId: string) => (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot })).asset as AssetRef;
  return async ({ archive, path: memberPath }: { archive: string; path: string }) => {
    const [gltfId] = ids((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
    const entry = (storage.entries as Json[]).find((candidate) => candidate.sourceId === gltfId)!;
    if ((await readFile(path.join(ROOT, entry.path))).subarray(0, 64).toString("utf8").startsWith(LFS_POINTER_PREFIX)) return undefined;
    const source = await member(gltfId!);
    const json = JSON.parse((await resolveAssetObject(objectStoreRoot, source)).toString("utf8"));
    const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((item: Json) => item.uri);
    const resources: AssetRef[] = [];
    for (const uri of uris) {
      const substitute = ids((source) => source.metadata?.substitutesFor?.some((item: Json) => item.member === gltfId && item.uri === uri));
      const [id] = substitute.length ? substitute : ids((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === uri);
      resources.push(await member(id!));
    }
    return single(await executeGltfProductionImportOperation(objectStoreRoot, { inputs: { source, resources }, parameters: { resourceUris: uris, policy: POLICY } }));
  };
}

for (const figure of ["male", "female"] as const) {
  test(`${figure} Ranger: face keys move only the face, and survive composition onto the outfit`, { skip: !blender, timeout: 600_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "face-variants-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const shape = RANGER_FIGURES[figure];
    const load = await importer(root);
    const body = await load(shape.body), outfit = await load(shape.outfit);
    if (!body || !outfit) return t.skip("Git LFS payloads are not hydrated");
    const head = single(await executeGltfSubsetSkinnedOperation(root, { inputs: { source: body }, parameters: { ...RANGER_HEAD_RECIPE, keepMeshes: [...shape.headMeshes] } }));
    const face = await addFaceVariants(root, head, `test.${figure}`);
    const evidence = face.observations;
    assert.equal(evidence.fixedMaxDisplacement, 0);
    assert.ok(evidence.fixedVertices > 500, `${evidence.fixedVertices} fixed vertices`);
    const [headNode, eyes, brows] = FACE_MORPH_NODES[figure];
    for (const key of FACE_MORPH_TARGETS) {
      const largest = evidence.maxDisplacement[key][headNode!];
      // Visible on the head (at least 2 mm) and bounded (at most 12 mm).
      assert.ok(largest >= 0.002 && largest <= 0.012, `${key} moves the head by ${largest} m`);
      assert.equal(evidence.maxDisplacement[key][eyes!] > 0, key === "eyes.large", `${key} on the eyeballs`);
      if (key.startsWith("face.") || key.startsWith("nose.") || key.startsWith("mouth.")) assert.equal(evidence.maxDisplacement[key][brows!], 0);
      for (const node of [headNode!, eyes!, brows!]) assert.ok(evidence.transfer[node].maxMatchDistance < 1e-4);
    }
    const composed = single(await executeGltfComposeSkinnedOperation(root, { inputs: { skeleton: outfit, parts: [face.glb] }, parameters: { policy: POLICY } }));
    const document = await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, composed)));
    const morphed = document.getRoot().listNodes().filter((node) => node.getMesh()?.listPrimitives().some((primitive) => primitive.listTargets().length));
    assert.deepEqual(morphed.map((node) => node.getName()).sort(), [...FACE_MORPH_NODES[figure]].sort());
    for (const node of morphed) {
      assert.deepEqual((node.getMesh()!.getExtras() as Json).targetNames, FACE_MORPH_TARGETS);
      assert.ok(node.getSkin(), `${node.getName()} stays skinned`);
    }
    // The mouth moves a few hundred of the head's vertices, so its target stays sparse through the composition.
    const mouth = morphed.find((node) => node.getName() === headNode)!.getMesh()!.listPrimitives()[0]!.listTargets()[FACE_MORPH_TARGETS.indexOf("mouth.thin")]!;
    assert.equal(mouth.getAttribute("POSITION")!.getSparse(), true);
  });
}
