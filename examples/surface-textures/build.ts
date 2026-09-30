import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS } from "../../src/surface-texture-recipes.js";
import { executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { resolveAssetObject } from "../../src/asset-store.js";
import { createAssetRef, type AssetRef } from "../../src/operations.js";
import { canonicalJson } from "../../src/canonical.js";

import { writeIfChanged } from "../reconcile-file.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, ".artifacts/surface-textures");
await mkdir(directory, { recursive: true });
const builds: Record<string, Awaited<ReturnType<typeof executeSurfaceTextureRecipe>> & { pngs: Record<string,AssetRef> }> = {};
for (const [id, recipe] of Object.entries(SURFACE_TEXTURE_PRESETS)) {
  const result = await executeSurfaceTextureRecipe(root, recipe);
  const pngs: Record<string,AssetRef> = {};
  for (const [channel, source] of Object.entries(result.outputs)) {
    const encoded = await executeImageEncodePngOperation(root, {
      inputs: { source }, parameters: { compressionLevel: 9 },
    });
    const output = createAssetRef(encoded.outputs.output);
    await writeIfChanged(path.join(directory, `${id}-${channel}.png`), await resolveAssetObject(root,output));
    pngs[channel] = output;
  }
  builds[id] = { ...result, pngs };
}
await writeIfChanged(path.join(directory,"builds.json"), Buffer.from(canonicalJson(builds)+"\n"));
console.log(JSON.stringify({ directory, variants: Object.keys(builds) }));
