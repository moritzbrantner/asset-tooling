import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { generateAsset, verifyAsset } from "asset-tooling";
import { resolveAssetObject, storeAssetObject, assetObjectPortablePath } from "asset-tooling/operations/store";
import { executeHeightMaskFlattenOperation, createHeightMaskFlattenOperationBuildIdentity } from "asset-tooling/operations/image/terrain";
import { executeTileableHeightOperation } from "asset-tooling/operations/generation/procedural-textures";
import { executeHeightfieldMeshOperation } from "asset-tooling/operations/generation/procedural-mesh";
import { executeImageEncodePngOperation } from "asset-tooling/operations/image/codecs";
import { prepareRenderDerivativeRecipe, readRenderDerivativeRecipeSource, RENDER_DERIVATIVE_PRESETS } from "asset-tooling/recipes/render-derivatives";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "asset-tooling/image/rgba8";
import { createAssetRef } from "asset-tooling/operations";
import { canonicalJson } from "../../src/canonical.js";
import { sha256Bytes } from "../../src/hash.js";
import { writeIfChanged } from "../reconcile-file.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const destination = path.join(root, ".artifacts/terrain-mask");
await mkdir(destination, { recursive: true });
const recipe = JSON.parse(await readFile(path.join(directory, "recipe.json"), "utf8"));
if (recipe.schemaVersion !== 1 || recipe.mask.path !== "footprint.rgba8.json") throw new Error("unsupported saved terrain example recipe");
const maskBytes = await readFile(path.join(directory, recipe.mask.path));
assert.equal(sha256Bytes(maskBytes), recipe.mask.sha256, "saved mask source pin");
const mask = (await storeAssetObject(root, { bytes: maskBytes, kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
  metadata: { source: "independently-authored-footprint", declaredGrid: recipe.placement } })).asset;
const height = await executeTileableHeightOperation(root, { parameters: recipe.height });
const source = createAssetRef(height.outputs.output);
const invocation = { parameters: recipe.flatten, inputs: { source, mask } };
const build = await createHeightMaskFlattenOperationBuildIdentity(root, invocation);
const edited = await executeHeightMaskFlattenOperation(root, invocation);
const editedHeight = createAssetRef(edited.outputs.output);
const coldRoot = path.join(destination, "cold-replay");
await storeAssetObject(coldRoot, { bytes: await resolveAssetObject(root, source), kind: source.kind, mediaType: source.mediaType, metadata: source.metadata });
await storeAssetObject(coldRoot, { bytes: maskBytes, kind: mask.kind, mediaType: mask.mediaType, metadata: mask.metadata });
const cold = await executeHeightMaskFlattenOperation(coldRoot, invocation);
assert.deepEqual(await resolveAssetObject(coldRoot, createAssetRef(cold.outputs.output)), await resolveAssetObject(root, editedHeight));
const originalPixels = parseRgba8Image(await resolveAssetObject(root, source));
const editedPixels = parseRgba8Image(await resolveAssetObject(root, editedHeight));
const weights = parseRgba8Image(maskBytes);
for (let i = 0; i < weights.pixels.length; i += 4) {
  if (weights.pixels[i] === 0) assert.equal(editedPixels.pixels[i], originalPixels.pixels[i]);
  if (weights.pixels[i] === 255) assert.equal(editedPixels.pixels[i], 128);
}
const exportScript = await readFile(path.join(directory, "export-review-glb.py"));
const renderScript = await readRenderDerivativeRecipeSource();
const outputs: Record<string, unknown> = {};
const sourceMeshes: Record<string, string> = {};
for (const [id, field] of Object.entries({ before: source, after: editedHeight })) {
  const mesh = await executeHeightfieldMeshOperation(root, { parameters: recipe.mesh, inputs: { source: field } });
  const meshRef = createAssetRef(mesh.outputs.output), bytes = await resolveAssetObject(root, meshRef);
  sourceMeshes[id] = bytes.toString("utf8");
  const workspace = path.join(destination, id);
  await mkdir(workspace, { recursive: true });
  await writeIfChanged(path.join(workspace, "height.obj"), bytes);
  await writeIfChanged(path.join(workspace, "export-review-glb.py"), exportScript);
  const exportSpec = { schemaVersion: 1, assetId: `terrain-${id}-review-export`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "export-review-glb.py", sha256: sha256Bytes(exportScript) }, source: { path: "height.obj", sha256: meshRef.sha256 } }, models: {},
    parameters: { blenderVersion: renderScript.blenderVersion, arguments: {} }, output: { path: "review.glb" }, reproducibility: { expected: "approximate" } };
  await writeIfChanged(path.join(workspace, "export.json"), Buffer.from(`${canonicalJson(exportSpec)}\n`));
  const exported = await generateAsset(path.join(workspace, "export.json"));
  const exportVerification = await verifyAsset(path.join(workspace, "export.json"));
  assert.equal(exportVerification.status, "exact", `${id}: native export replay`);
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "review.glb")), kind: "mesh", mediaType: "model/gltf-binary",
    metadata: { sourceSha256: meshRef.sha256, sourceSpecSha256: exported.receipt.spec.sha256, purpose: "native neutral review derivative" } })).asset;
  const render = await prepareRenderDerivativeRecipe(root, { assetId: `terrain-${id}-review`, source: glb, scriptSha256: renderScript.sha256, blenderVersion: renderScript.blenderVersion,
    parameters: { ...RENDER_DERIVATIVE_PRESETS.thumbnail, width: 512, height: 384, samples: 16, viewDirection: [4, 5, 5] } });
  await writeIfChanged(path.join(workspace, "render_static_glb.py"), renderScript.bytes);
  await writeIfChanged(path.join(workspace, "source.glb"), render.sourceBytes);
  await writeIfChanged(path.join(workspace, "render.json"), Buffer.from(`${canonicalJson(render.spec)}\n`));
  const rendered = await generateAsset(path.join(workspace, "render.json"));
  const renderVerification = await verifyAsset(path.join(workspace, "render.json"));
  assert.equal(renderVerification.status, "exact", `${id}: review render replay`);
  outputs[id] = { height: field, mesh: meshRef, review: glb, vertices: mesh.observations.vertexCount, triangles: mesh.observations.triangleCount,
    exportReceipt: exported.receipt, exportVerification, renderReceipt: rendered.receipt, renderVerification,
    canonicalMeshPath: assetObjectPortablePath(meshRef), worldTranslation: [recipe.placement.firstSampleWorldOrigin[0] + (weights.width - 1) * recipe.mesh.cellSize / 2,
      recipe.placement.firstSampleWorldOrigin[1], recipe.placement.firstSampleWorldOrigin[2] + (weights.height - 1) * recipe.mesh.cellSize / 2] };
}
const lines = (value: string) => value.split("\n");
assert.ok(sourceMeshes.before && sourceMeshes.after);
assert.deepEqual(lines(sourceMeshes.before).filter(l => l.startsWith("f ")), lines(sourceMeshes.after).filter(l => l.startsWith("f ")));
const verticesBefore = lines(sourceMeshes.before).filter(l => l.startsWith("v "));
const verticesAfter = lines(sourceMeshes.after).filter(l => l.startsWith("v "));
assert.equal(verticesBefore.length, weights.width * weights.height);
assert.equal(verticesAfter.length, verticesBefore.length);
for (const [i, vertexAfter] of verticesAfter.entries()) {
  const vertexBefore = verticesBefore[i];
  assert.ok(vertexBefore);
  if (weights.pixels[i * 4] === 0) assert.equal(vertexBefore, vertexAfter);
  if (weights.pixels[i * 4] === 255) assert.equal(Number(vertexAfter.split(" ")[2]), 4);
}
for (const [name, image] of Object.entries({ "height-before": originalPixels, mask: weights, "height-after": editedPixels })) {
  const ref = (await storeAssetObject(root, { bytes: encodeRgba8Image(image), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE })).asset;
  const png = await executeImageEncodePngOperation(root, { parameters: { compressionLevel: 9 }, inputs: { source: ref } });
  await writeIfChanged(path.join(destination, `${name}.png`), await resolveAssetObject(root, createAssetRef(png.outputs.output)));
}
await writeIfChanged(path.join(destination, "evidence.json"), Buffer.from(`${canonicalJson({ schemaVersion: 1, recipe, mask, build, edited, outputs,
  coldReplayMatches: true, unmaskedSamplesAndVerticesUnchanged: true, topologyUnchanged: true, flattenedWorldHeight: 4,
  acceptance: "offline footprint artifact proof; no consumer terrain/physics or shared-edge claim" })}\n`));
console.log(JSON.stringify({ directory: destination, ...edited.observations, outputs: Object.keys(outputs), coldReplayMatches: true }));
