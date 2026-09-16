import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAssetCatalog, inspectAssetCatalogSourceBytes } from "../src/catalog.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const [sourceId, filePath] = process.argv.slice(2);

if (!sourceId || !filePath) {
  console.error("usage: bun scripts/pin-catalog-source.js <catalog-source-id> <local-file>");
  process.exitCode = 2;
} else {
  const providersDocument = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8"));
  const sourcesDocument = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8"));
  const catalog = createAssetCatalog({
    providers: providersDocument.providers,
    sources: sourcesDocument.sources,
  });
  const source = catalog.getSource(sourceId);
  if (!source) {
    console.error(`catalog source '${sourceId}' is not registered`);
    process.exitCode = 2;
  } else {
    const bytes = await readFile(path.resolve(filePath));
    const pinned = inspectAssetCatalogSourceBytes(source, bytes);
    process.stdout.write(`${JSON.stringify(pinned, null, 2)}\n`);
  }
}
