import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acquireAssetCatalogSource } from "../src/catalog-acquisition.js";
import { createAssetCatalog } from "../src/catalog.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const [sourceId, destinationRoot = ".artifacts/catalog-acquisition"] = process.argv.slice(2);

if (!sourceId) {
  console.error("usage: bun scripts/acquire-catalog-source.js <catalog-source-id> [destination-root]");
  process.exitCode = 2;
} else {
  const providersDocument = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8"));
  const sourcesDocument = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8"));
  const catalog = createAssetCatalog({
    providers: providersDocument.providers,
    sources: sourcesDocument.sources,
  });

  try {
    const result = await acquireAssetCatalogSource({
      catalog,
      sourceId,
      destinationRoot: path.resolve(destinationRoot),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
