import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { createAssetCatalog, importAssetCatalogSource } from "../src/catalog.js";
import { resolveAssetObject } from "../src/asset-store.js";
import { createGltfProductionImportOperationBuildIdentity, executeGltfProductionImportOperation, executeGltfAnalyzeOperation } from "../src/gltf-production-operations.js";
import { sha256Bytes } from "../src/hash.js";

const [sourceId, filename] = process.argv.slice(2);
if (!sourceId || !filename) throw new Error("usage: bun scripts/check-gltf-production-contract.ts <pinned-catalog-source-id> <explicitly-acquired-file>");
const repositoryRoot = path.resolve(import.meta.dir, "..");
const providers = JSON.parse(await readFile(path.join(repositoryRoot, "catalog/providers.json"), "utf8")).providers;
const sources = JSON.parse(await readFile(path.join(repositoryRoot, "catalog/sources.json"), "utf8")).sources;
const catalog = createAssetCatalog({ providers, sources });
const root = await mkdtemp(path.join(os.tmpdir(), "gltf-production-proof-"));
try {
  const { asset: source } = await importAssetCatalogSource(root, catalog, sourceId, await readFile(filename));
  const invocation = {
    inputs: { source },
    parameters: { policy: { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT"] } },
  };
  const identity = await createGltfProductionImportOperationBuildIdentity(root, invocation);
  const analysis = await executeGltfAnalyzeOperation(root, invocation);
  assert.equal(analysis.observations.accepted, true);
  const first = await executeGltfProductionImportOperation(root, invocation);
  const second = await executeGltfProductionImportOperation(root, invocation);
  assert.deepEqual(first, second);
  const output = first.outputs.output;
  assert.ok(output && !Array.isArray(output));
  const io = new NodeIO();
  const sourceBytes = await resolveAssetObject(root, source);
  const sourceRoot = (source.mediaType === "model/gltf-binary"
    ? await io.readBinary(sourceBytes)
    : await io.readJSON({ json: JSON.parse(sourceBytes.toString("utf8")), resources: {} })).getRoot();
  const outputRoot = (await io.readBinary(await resolveAssetObject(root, output))).getRoot();
  assert.equal(outputRoot.listNodes().length, sourceRoot.listNodes().length);
  // glTF Transform omits near-default TRS components. Bound that normalization explicitly;
  // output byte replay remains exact, while source/output computed transforms use tolerance.
  const matrixComponentTolerance = 1e-5;
  let maxMatrixComponentError = 0;
  for (const [index, node] of sourceRoot.listNodes().entries()) {
    const expected = node.getWorldMatrix();
    const actual = outputRoot.listNodes()[index]!.getWorldMatrix();
    for (const [component, value] of expected.entries()) {
      const error = Math.abs(actual[component]! - value);
      maxMatrixComponentError = Math.max(maxMatrixComponentError, error);
      assert.ok(error <= matrixComponentTolerance, `/nodes/${index} world matrix component ${component} error ${error}`);
    }
  }
  for (const [index, mesh] of sourceRoot.listMeshes().entries()) {
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const candidate = outputRoot.listMeshes()[index]!.listPrimitives()[primitiveIndex]!;
      assert.deepEqual(candidate.getIndices()?.getArray(), primitive.getIndices()?.getArray());
      for (const semantic of primitive.listSemantics()) {
        assert.deepEqual(candidate.getAttribute(semantic)!.getArray(), primitive.getAttribute(semantic)!.getArray());
      }
    }
  }
  assert.equal(outputRoot.listSkins().length, sourceRoot.listSkins().length);
  for (const [index, skin] of sourceRoot.listSkins().entries()) {
    const candidate = outputRoot.listSkins()[index]!;
    assert.deepEqual(candidate.listJoints().map((node) => outputRoot.listNodes().indexOf(node)), skin.listJoints().map((node) => sourceRoot.listNodes().indexOf(node)));
    assert.deepEqual(candidate.getInverseBindMatrices()?.getArray(), skin.getInverseBindMatrices()?.getArray());
  }
  assert.equal(outputRoot.listAnimations().length, sourceRoot.listAnimations().length);
  for (const [index, animation] of sourceRoot.listAnimations().entries()) {
    const candidate = outputRoot.listAnimations()[index]!;
    assert.equal(candidate.getName(), animation.getName());
    assert.equal(candidate.listChannels().length, animation.listChannels().length);
    for (const [channelIndex, channel] of animation.listChannels().entries()) {
      const result = candidate.listChannels()[channelIndex]!;
      assert.equal(result.getTargetPath(), channel.getTargetPath());
      assert.equal(outputRoot.listNodes().indexOf(result.getTargetNode()!), sourceRoot.listNodes().indexOf(channel.getTargetNode()!));
      assert.equal(result.getSampler()!.getInterpolation(), channel.getSampler()!.getInterpolation());
      assert.deepEqual(result.getSampler()!.getInput()!.getArray(), channel.getSampler()!.getInput()!.getArray());
      assert.deepEqual(result.getSampler()!.getOutput()!.getArray(), channel.getSampler()!.getOutput()!.getArray());
    }
  }
  assert.equal(outputRoot.listTextures().length, sourceRoot.listTextures().length);
  for (const [index, texture] of sourceRoot.listTextures().entries()) {
    assert.equal(sha256Bytes(outputRoot.listTextures()[index]!.getImage()!), sha256Bytes(texture.getImage()!));
  }
  const normalizedAnalysis = await executeGltfAnalyzeOperation(root, { ...invocation, inputs: { source: output } });
  for (const field of ["meshes", "materials", "textures", "nodes", "skins", "clips"]) {
    assert.deepEqual(normalizedAnalysis.observations[field], analysis.observations[field]);
  }
  process.stdout.write(`${JSON.stringify({
    status: "passed", sourceId, sourceSha256: source.sha256, outputSha256: output.sha256,
    identity, observations: first.observations,
    transformComparison: { matrixComponentTolerance, maxMatrixComponentError },
  })}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
