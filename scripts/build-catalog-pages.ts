import path from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createCatalogPagesModel,
  renderCatalogAssetHtml,
  renderCatalogGalleryHtml,
} from "../src/catalog-pages-site.js";
import { renderBrowser3DStudioHtml } from "../src/browser-pages-site.js";

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
const html = renderCatalogGalleryHtml(model);

await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "index.html"), html, "utf8");
await writeFile(path.join(outputRoot, "catalog.json"), `${JSON.stringify(model, null, 2)}\n`, "utf8");
await writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");

for (const asset of model.assets) {
  const assetRoot = path.join(outputRoot, "assets", encodeURIComponent(asset.id));
  await mkdir(assetRoot, { recursive: true });
  await writeFile(path.join(assetRoot, "index.html"), renderCatalogAssetHtml(asset), "utf8");
}

const generateRoot = path.join(outputRoot, "generate");
await mkdir(generateRoot, { recursive: true });
await writeFile(
  path.join(generateRoot, "index.html"),
  renderBrowser3DStudioHtml(),
  "utf8",
);
await Promise.all([
  copyFile(
    path.join(root, "licenses", "STABILITY_AI_COMMUNITY_LICENSE.md"),
    path.join(generateRoot, "STABILITY_AI_COMMUNITY_LICENSE.md"),
  ),
  copyFile(
    path.join(root, "licenses", "sf3d-webgpu-source-MIT.txt"),
    path.join(generateRoot, "sf3d-webgpu-source-MIT.txt"),
  ),
  copyFile(
    path.join(root, "THIRD_PARTY_NOTICES.md"),
    path.join(generateRoot, "THIRD_PARTY_NOTICES.md"),
  ),
]);

const browserBuild = await Bun.build({
  entrypoints: [path.join(root, "src", "browser", "pages-3d.ts")],
  outdir: generateRoot,
  target: "browser",
  format: "esm",
  splitting: false,
  minify: false,
  sourcemap: "none",
  naming: "app.js",
  external: [
    "onnxruntime-web",
    "three",
    "three/examples/jsm/exporters/GLTFExporter.js",
  ],
});
if (!browserBuild.success) {
  throw new Error(
    "browser 3D studio bundle failed:\n" +
      browserBuild.logs.map((entry) => entry.message).join("\n"),
  );
}

console.log(JSON.stringify({
  status: "built",
  assets: model.assets.length,
  detailPages: model.assets.length,
  browser3DStudio: true,
  output: "dist/pages",
}));
