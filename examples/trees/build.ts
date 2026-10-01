import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { generateAsset, verifyAsset } from "asset-tooling";
import { storeAssetObject } from "asset-tooling/operations/store";
import { type AssetRef } from "asset-tooling/operations";
import { createTreeAssetSpec, TREE_PRESETS, SAPLING_TREE_SOURCE, readTreeRecipeSource } from "asset-tooling/recipes/trees";
import { prepareRenderDerivativeRecipe, readRenderDerivativeRecipeSource, RENDER_DERIVATIVE_PRESETS } from "asset-tooling/recipes/render-derivatives";
import { canonicalJson } from "../../src/canonical.js";
import { sha256Bytes } from "../../src/hash.js";
import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const destination = path.join(root, ".artifacts/trees");
// This is an explicit input-file selection; the example does not acquire or install anything.
const archivePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, ".artifacts/sapling/sapling-0.3.7.zip");
const archive = await readFile(archivePath);
assert.equal(archive.byteLength, SAPLING_TREE_SOURCE.byteLength);
assert.equal(sha256Bytes(archive), SAPLING_TREE_SOURCE.sha256);
const source = await readTreeRecipeSource(), renderer = await readRenderDerivativeRecipeSource();
const assets: Record<string, AssetRef> = {}, evidence: Record<string, unknown> = {};
for (const [presetId, parameters] of Object.entries(TREE_PRESETS)) {
  let acceptedGeometry: unknown;
  for (const component of ["composed", "trunk", "branches", "foliage"] as const) {
    const id = `${presetId}.${component}`, directory = path.join(destination, presetId, component);
    await mkdir(directory, { recursive: true });
    await writeIfChanged(path.join(directory, "tree.py"), source.bytes);
    await writeIfChanged(path.join(directory, "sapling.zip"), archive);
    const spec = createTreeAssetSpec({ assetId: `tree.${id}`, parameters: { ...parameters, component }, scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
    const specPath = path.join(directory, "asset.json");
    await writeIfChanged(specPath, Buffer.from(`${canonicalJson(spec)}\n`));
    const generated = await generateAsset(specPath), verified = await verifyAsset(specPath);
    assert.equal(verified.status, "exact", `${id}: tree replay`);
    const geometry = generated.receipt.observations.script.componentGeometrySha256;
    if (component === "composed") acceptedGeometry = geometry;
    else assert.deepEqual(geometry, acceptedGeometry, "native components match the composed family");
    const mesh = (await storeAssetObject(root, { bytes: await readFile(path.join(directory, "tree.glb")), kind: "mesh", mediaType: "model/gltf-binary",
      metadata: { sourceSpecSha256: generated.receipt.spec.sha256, generator: "external.blender.script@1", recipe: "sapling-tree-v1", source: SAPLING_TREE_SOURCE,
        component, family: parameters.family, ...(presetId === parameters.family ? {} : { presetId }), unit: "meter", axes: "right-handed-y-up", origin: "native-root-ground-anchor", geometry: generated.receipt.observations.script } })).asset;
    assert.equal(mesh.metadata.family, generated.receipt.observations.script.parameters.family);
    assets[id] = mesh;
    const render = await prepareRenderDerivativeRecipe(root, { assetId: `tree-review.${id}`, source: mesh, scriptSha256: renderer.sha256,
      blenderVersion: renderer.blenderVersion, parameters: { ...RENDER_DERIVATIVE_PRESETS.thumbnail, width: 384, height: 512, samples: 16 } });
    await writeIfChanged(path.join(directory, "render_static_glb.py"), renderer.bytes);
    await writeIfChanged(path.join(directory, "source.glb"), render.sourceBytes);
    await writeIfChanged(path.join(directory, "render.json"), Buffer.from(`${canonicalJson(render.spec)}\n`));
    const rendered = await generateAsset(path.join(directory, "render.json")), renderVerified = await verifyAsset(path.join(directory, "render.json"));
    assert.equal(renderVerified.status, "exact", `${id}: thumbnail replay`);
    evidence[id] = { receipt: generated.receipt, verified, renderReceipt: rendered.receipt, renderVerified };
    console.log(JSON.stringify({ id, bytes: mesh.byteLength, geometry: generated.receipt.observations.script.componentCounts }));
  }
}
await writeIfChanged(path.join(destination, "assets.json"), Buffer.from(`${canonicalJson({ schemaVersion: 1, assets })}\n`));
await writeIfChanged(path.join(destination, "evidence.json"), Buffer.from(`${canonicalJson({ source: SAPLING_TREE_SOURCE, evidence,
  work: { declaredFullFamilySpecs: Object.keys(assets).length, cacheIndependentTreeReplays: Object.keys(assets).length,
    cacheIndependentThumbnailReplays: Object.keys(assets).length, componentHashesMatchComposition: true } })}\n`));
