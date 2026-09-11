import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyAssetCatalogLfsPromotion } from "../src/catalog-lfs-promotion.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const [sourceId] = process.argv.slice(2);

if (!sourceId) {
  console.error("usage: bun scripts/promote-catalog-lfs-source.js <catalog-source-id>");
  process.exitCode = 2;
} else {
  const providersDocument = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8"));
  const sourcesDocument = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8"));
  const storageDocument = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));

  try {
    const result = await applyAssetCatalogLfsPromotion({
      providersDocument,
      sourcesDocument,
      storageDocument,
      sourceId,
      repositoryRoot: root,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
