import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { createAssetCatalog, importAssetCatalogSource } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { resolveAssetObject } from "../src/asset-store.js";
import { createGltfImportOperationBuildIdentity, executeGltfImportOperation } from "../src/gltf-import-operations.js";
import { sha256Bytes } from "../src/hash.js";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const providers = JSON.parse(await readFile(path.join(repositoryRoot, "catalog/providers.json"), "utf8")).providers;
const sources = JSON.parse(await readFile(path.join(repositoryRoot, "catalog/sources.json"), "utf8")).sources;
const catalog = createAssetCatalog({ providers, sources });
const sourceId = "khronos.avocado-glb";
const root = await mkdtemp(path.join(os.tmpdir(), "gltf-import-proof-"));
try {
  // An optional file is an explicitly acquired candidate, still checked against the catalog pin.
  // With no argument, use the durable storage resolver and verify hydrated canonical bytes.
  const stored = process.argv[2]
    ? await importAssetCatalogSource(root, catalog, sourceId, await readFile(process.argv[2]))
    : await importAssetCatalogStorageSource({
      catalog, sourceId, storageRoot: repositoryRoot, objectStoreRoot: root,
      storage: JSON.parse(await readFile(path.join(repositoryRoot, "catalog/storage.json"), "utf8")),
    });
  const source = stored.asset;
  const invocation = { inputs: { source } };
  const identity = await createGltfImportOperationBuildIdentity(root, invocation);
  const first = await executeGltfImportOperation(root, invocation);
  const second = await executeGltfImportOperation(root, invocation);
  assert.deepEqual(first, second);
  const output = first.outputs.output;
  assert.ok(output && !Array.isArray(output));
  const io = new NodeIO();
  const sourceDocument = await io.readBinary(await resolveAssetObject(root, source));
  const outputDocument = await io.readBinary(await resolveAssetObject(root, output));
  const sourceRoot = sourceDocument.getRoot();
  const outputRoot = outputDocument.getRoot();
  assert.equal(outputRoot.listNodes().length, sourceRoot.listNodes().length);
  for (const [index, node] of sourceRoot.listNodes().entries()) {
    assert.deepEqual(outputRoot.listNodes()[index]!.getWorldMatrix(), node.getWorldMatrix());
  }
  for (const [index, mesh] of sourceRoot.listMeshes().entries()) {
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const candidate = outputRoot.listMeshes()[index]!.listPrimitives()[primitiveIndex]!;
      assert.deepEqual(candidate.getIndices()!.getArray(), primitive.getIndices()!.getArray());
      for (const semantic of primitive.listSemantics()) {
        assert.deepEqual(candidate.getAttribute(semantic)!.getArray(), primitive.getAttribute(semantic)!.getArray());
      }
    }
  }
  assert.equal(outputRoot.listTextures().length, sourceRoot.listTextures().length);
  for (const [index, texture] of sourceRoot.listTextures().entries()) {
    assert.equal(sha256Bytes(outputRoot.listTextures()[index]!.getImage()!), sha256Bytes(texture.getImage()!));
  }
  for (const [index, material] of sourceRoot.listMaterials().entries()) {
    const candidate = outputRoot.listMaterials()[index]!;
    assert.deepEqual(candidate.getBaseColorFactor(), material.getBaseColorFactor());
    assert.equal(candidate.getMetallicFactor(), material.getMetallicFactor());
    assert.equal(candidate.getRoughnessFactor(), material.getRoughnessFactor());
    assert.equal(candidate.getNormalScale(), material.getNormalScale());
    assert.equal(candidate.getAlphaMode(), material.getAlphaMode());
  }
  process.stdout.write(`${JSON.stringify({
    status: "passed", sourceId, sourceSha256: source.sha256, outputSha256: output.sha256,
    identity, observations: first.observations,
  })}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
