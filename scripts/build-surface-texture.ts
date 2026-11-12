// Builds one surface recipe file (for example recipe.json from the texture workbench, #127) through
// `asset-tooling/recipes/surface-textures`: four channel PNGs and result.json with every channel's AssetRef.
// The printed canonical sha256 per channel equals the workbench's channel identity for the same recipe.
// Usage: bun scripts/build-surface-texture.ts <recipe.json> [outDir=.artifacts/texture-workbench]
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { executeSurfaceTextureRecipe } from "../src/surface-texture-recipes.js";
import { executeImageEncodePngOperation } from "../src/image-codec-operations.js";
import { resolveAssetObject } from "../src/asset-store.js";
import { createAssetRef } from "../src/operations.js";
import { canonicalJson } from "../src/canonical.js";
import { writeIfChanged } from "../examples/reconcile-file.js";

const [recipeFile, outArgument] = process.argv.slice(2);
if (!recipeFile) {
  console.error("usage: bun scripts/build-surface-texture.ts <recipe.json> [outDir]");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(outArgument ?? path.join(root, ".artifacts", "texture-workbench"));
await mkdir(outDir, { recursive: true });
const result = await executeSurfaceTextureRecipe(root, JSON.parse(await readFile(recipeFile, "utf8")));
const channels: Record<string, { canonicalSha256: string; png: string }> = {};
for (const [channel, source] of Object.entries(result.outputs)) {
  const encoded = await executeImageEncodePngOperation(root, { inputs: { source }, parameters: { compressionLevel: 9 } });
  const png = path.join(outDir, `${channel}.png`);
  await writeIfChanged(png, await resolveAssetObject(root, createAssetRef(encoded.outputs.output)));
  channels[channel] = { canonicalSha256: source!.sha256, png };
}
await writeIfChanged(path.join(outDir, "result.json"), Buffer.from(canonicalJson(result) + "\n"));
console.log(JSON.stringify({ recipeSha256: result.recipeSha256, outDir, channels }, null, 2));
