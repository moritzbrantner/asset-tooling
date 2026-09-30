import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS } from "../../src/surface-texture-recipes.js";
import { executeImageEncodePngOperation } from "../../src/image-codec-operations.js";
import { resolveAssetObject } from "../../src/asset-store.js";
import { canonicalJson } from "../../src/canonical.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directory = path.join(root, ".artifacts/surface-textures");
await mkdir(directory, { recursive: true });
const builds = {};
for (const [id, recipe] of Object.entries(SURFACE_TEXTURE_PRESETS)) {
  const result = await executeSurfaceTextureRecipe(root, recipe);
  const pngs = {};
  for (const [channel, source] of Object.entries(result.outputs)) {
    const encoded = await executeImageEncodePngOperation(root, {
      inputs: { source }, parameters: { compressionLevel: 9 },
    });
    const output = encoded.outputs.output;
    await writeFile(path.join(directory, `${id}-${channel}.png`), await resolveAssetObject(root,output));
    pngs[channel] = output;
  }
  builds[id] = { ...result, pngs };
}
await writeFile(path.join(directory,"builds.json"), canonicalJson(builds)+"\n");
console.log(JSON.stringify({ directory, variants: Object.keys(builds) }));
