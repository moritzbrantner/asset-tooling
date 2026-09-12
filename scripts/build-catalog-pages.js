import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCatalogPagesModel, renderCatalogPagesHtml } from "../src/catalog-pages.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = path.join(root, "dist", "pages");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

const [providers, sources, storage] = await Promise.all([
  readJson("catalog/providers.json"),
  readJson("catalog/sources.json"),
  readJson("catalog/storage.json"),
]);
const model = createCatalogPagesModel({ providers, sources, storage });
const html = renderCatalogPagesHtml(model);

await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "index.html"), html, "utf8");
await writeFile(path.join(outputRoot, "catalog.json"), `${JSON.stringify(model, null, 2)}\n`, "utf8");
await writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");

console.log(JSON.stringify({ status: "built", assets: model.assets.length, output: "dist/pages" }));
