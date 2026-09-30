import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { canonicalJson } from "../../src/canonical.js";
import { createAssetCatalog } from "../../src/catalog.js";
import { importAssetCatalogStorageSource } from "../../src/catalog-storage.js";
import { resolveAssetObject, storeAssetObject } from "../../src/asset-store.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import { generateAsset, verifyAsset } from "../../src/core.js";
import { prepareRenderDerivativeRecipe, readRenderDerivativeRecipeSource, RENDER_DERIVATIVE_PRESETS } from "../../src/render-derivative-recipes.js";
import { createImageDecodeOperationBuildIdentity, executeImageDecodeOperation, createImageEncodePngOperationBuildIdentity, executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { executeSpriteAtlasOperation } from "../../src/sprite-atlas-operations.js";
import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, ".artifacts/render-derivatives");
const providers = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8")).providers;
const sources = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8")).sources;
const catalog = createAssetCatalog({ providers, sources });
const avocado = await importAssetCatalogStorageSource({ catalog, sourceId: "khronos.avocado-glb", storageRoot: root, objectStoreRoot: root,
  storage: JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8")) });
const rocks = JSON.parse(await readFile(path.join(root, ".artifacts/rocks/variants.json"), "utf8"));
const rounded = rocks.variants.find((variant: { id: string }) => variant.id === "rounded");
if (!rounded) throw new Error("run examples/rocks/build.ts first to prepare the rounded rock source");
const renderer = await readRenderDerivativeRecipeSource();
const outputs: { id: string; image: AssetRef }[] = [];
const evidence: Record<string, unknown> = {};
for (const [sourceId, source] of [["avocado", avocado.asset], ["rock", createAssetRef(rounded.mesh)]] as const) {
  for (const [presetId, parameters] of Object.entries(RENDER_DERIVATIVE_PRESETS)) {
    const id = `${sourceId}-${presetId}`, workspace = path.join(directory, id);
    await mkdir(workspace, { recursive: true });
    const prepared = await prepareRenderDerivativeRecipe(root, { assetId: `asset-tooling.render.${id}`, source, parameters,
      scriptSha256: renderer.sha256, blenderVersion: renderer.blenderVersion });
    await writeIfChanged(path.join(workspace, "render_static_glb.py"), renderer.bytes);
    await writeIfChanged(path.join(workspace, "source.glb"), prepared.sourceBytes);
    const specPath = path.join(workspace, "asset.json");
    await writeIfChanged(specPath, Buffer.from(`${canonicalJson(prepared.spec)}\n`));
    const generated = await generateAsset(specPath), verified = await verifyAsset(specPath);
    if (verified.status !== "exact") throw new Error(`${id}: render replay did not match on this runtime`);
    const image = (await storeAssetObject(root, { kind: "image", mediaType: "image/png", bytes: await readFile(path.join(workspace, "render.png")),
      metadata: { source, sourceSpecSha256: generated.receipt.spec.sha256, scriptSha256: renderer.sha256, render: generated.receipt.observations.script } })).asset;
    outputs.push({ id, image });
    evidence[id] = { sourceSummary: prepared.sourceSummary, resources: prepared.resources, receipt: generated.receipt, verified };
  }
}
// Atlas assembly remains the existing selected-image operation. Both icons stay usable alone.
const icons = outputs.filter(output => output.id.endsWith("-icon"));
const decoded = [];
for (const icon of icons) {
  const invocation = { inputs: { source: icon.image } };
  const build = await createImageDecodeOperationBuildIdentity(root, invocation);
  const result = await executeImageDecodeOperation(root, invocation);
  decoded.push(createAssetRef(result.outputs.output));
  evidence[`${icon.id}-decode`] = { build, result };
}
const atlas = await executeSpriteAtlasOperation(root, { parameters: { width: 512, maxHeight: 512, padding: 2, extrusion: 1, trim: true,
  sprites: icons.map(icon => ({ id: icon.id, pivot: { x: 128, y: 128 } })) }, inputs: { sprites: decoded } });
const encode = { inputs: { source: createAssetRef(atlas.outputs.image) }, parameters: { compressionLevel: 9 } };
const atlasEncodeBuild = await createImageEncodePngOperationBuildIdentity(root, encode);
const atlasPng = createAssetRef((await executeImageEncodePngOperation(root, encode)).outputs.output);
await writeIfChanged(path.join(directory, "icons.png"), await resolveAssetObject(root, atlasPng));
await writeIfChanged(path.join(directory, "icons-atlas.json"), await resolveAssetObject(root, atlas.outputs.manifest));
evidence.atlas = { atlas, encodeBuild: atlasEncodeBuild, png: atlasPng };
await writeIfChanged(path.join(directory, "outputs.json"), Buffer.from(`${canonicalJson({ schemaVersion: 1, outputs })}\n`));
await writeIfChanged(path.join(directory, "evidence.json"), Buffer.from(`${canonicalJson(evidence)}\n`));
console.log(JSON.stringify({ directory, outputs: outputs.map(o => o.id) }));
