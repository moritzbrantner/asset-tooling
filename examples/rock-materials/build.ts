import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { canonicalJson } from "../../src/canonical.js";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "../../src/asset-store.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import { createRockVariantManifest, type RockVariant } from "../../src/rock-recipes.js";
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS } from "../../src/surface-texture-recipes.js";
import { createImageEncodePngOperationBuildIdentity, executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { createPbrMaterialBundleOperationBuildIdentity, executePbrMaterialBundleOperation } from "../../src/material-operations.js";
import { createGltfBaseColorOperationBuildIdentity, executeGltfBaseColorOperation, type GltfBaseColorParameters } from "../../src/gltf-material-operations.js";
import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, ".artifacts/rock-materials");
const raw: unknown = JSON.parse(await readFile(path.join(root, ".artifacts/rocks/variants.json"), "utf8"));
if (!raw || typeof raw !== "object" || !("variants" in raw) || !Array.isArray(raw.variants)) throw new Error("run examples/rocks/build.ts first");
const masters = raw.variants.map((entry: unknown) => {
  if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" || !("mesh" in entry)) throw new Error("invalid rock master inventory");
  return { id: entry.id, mesh: createAssetRef(entry.mesh) };
});
assert.deepEqual(masters.map(master => master.id).sort(), ["angular", "boulder", "flat", "rounded"]);
const masterMtimes = await Promise.all(masters.map(master => stat(path.join(root, assetObjectPortablePath(master.mesh))).then(info => info.mtimeMs)));
const controls: GltfBaseColorParameters = { materialName: "rock-surface", baseColorFactor: [1, 1, 1, 1], texCoord: 0,
  sampler: { magFilter: "linear", minFilter: "linear", wrapS: "repeat", wrapT: "repeat" }, alpha: { mode: "OPAQUE" } };
const variants: RockVariant[] = [], evidence: Record<string, unknown> = {};
const cold = await mkdtemp(path.join(os.tmpdir(), "rock-material-replay-"));
await mkdir(directory, { recursive: true });
try {
  for (const [palette, recipe] of Object.entries({ gray: SURFACE_TEXTURE_PRESETS["rock-grainy"],
    warm: { ...SURFACE_TEXTURE_PRESETS["rock-grainy"], low: [75, 28, 12], high: [215, 178, 119] } })) {
    const surface = await executeSurfaceTextureRecipe(root, recipe, { channels: ["color"] });
    const color = createAssetRef(surface.outputs.color);
    const encode = { inputs: { source: color }, parameters: { compressionLevel: 9 } };
    const encodeBuild = await createImageEncodePngOperationBuildIdentity(root, encode);
    const png = createAssetRef((await executeImageEncodePngOperation(root, encode)).outputs.output);
    const materialInvocation = { inputs: { "base-color": color } };
    const materialBuild = await createPbrMaterialBundleOperationBuildIdentity(root, materialInvocation);
    const bundle = createAssetRef((await executePbrMaterialBundleOperation(root, materialInvocation)).outputs.output);
    const inputs: Record<string, string> = {};
    for (const master of masters) {
      const invocation = { inputs: { source: master.mesh, "base-color": png }, parameters: controls };
      const build = await createGltfBaseColorOperationBuildIdentity(root, invocation);
      const result = await executeGltfBaseColorOperation(root, invocation), mesh = createAssetRef(result.outputs.output);
      // A separate cold store proves deterministic derivation; no geometry generator is invoked.
      for (const asset of [master.mesh, png]) await storeAssetObject(cold, { ...asset, bytes: await resolveAssetObject(root, asset) });
      assert.deepEqual(await executeGltfBaseColorOperation(cold, invocation), result);
      const before = await new NodeIO().readBinary(await resolveAssetObject(root, master.mesh));
      const bytes = await resolveAssetObject(root, mesh), after = await new NodeIO().readBinary(bytes);
      for (const [i, sourceMesh] of before.getRoot().listMeshes().entries()) for (const [j, primitive] of sourceMesh.listPrimitives().entries()) {
        const derived = after.getRoot().listMeshes()[i]!.listPrimitives()[j]!;
        assert.deepEqual(derived.getIndices()!.getArray(), primitive.getIndices()!.getArray());
        for (const semantic of primitive.listSemantics()) assert.deepEqual(derived.getAttribute(semantic)!.getArray(), primitive.getAttribute(semantic)!.getArray());
      }
      const material = after.getRoot().listMaterials().find(material => material.getName() === "rock-surface");
      assert.ok(material); assert.deepEqual(Buffer.from(material.getBaseColorTexture()!.getImage()!), await resolveAssetObject(root, png));
      const workspace = path.join(directory, palette, master.id); await mkdir(workspace, { recursive: true });
      await writeIfChanged(path.join(workspace, "rock.glb"), bytes);
      inputs[master.id] = `${master.id}/rock.glb`;
      variants.push({ id: `${master.id}-${palette}`, mesh, material: bundle });
      evidence[`${master.id}-${palette}`] = { master: master.mesh, build, result, geometryReused: true, coldReplayMatches: true,
        encodedBytes: bytes.length, pngSha256: png.sha256 };
    }
    await writeIfChanged(path.join(directory, palette, "review-inputs.json"), Buffer.from(`${canonicalJson({ schemaVersion: 1, meshes: inputs })}\n`));
    evidence[palette] = { surface, encodeBuild, png, materialBuild, bundle };
  }
} finally { await rm(cold, { recursive: true, force: true }); }
for (const [i, master] of masters.entries()) assert.equal((await stat(path.join(root, assetObjectPortablePath(master.mesh)))).mtimeMs, masterMtimes[i]);
await writeIfChanged(path.join(directory, "variants.json"), Buffer.from(`${canonicalJson(createRockVariantManifest(variants))}\n`));
await writeIfChanged(path.join(directory, "evidence.json"), Buffer.from(`${canonicalJson(evidence)}\n`));
console.log(JSON.stringify({ directory, variants: variants.length, geometryGeneratorsExecuted: 0,
  sharedPngSources: 2, coldReplays: variants.length, masterObjectsUnchanged: true }));
