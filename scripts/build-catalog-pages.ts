import path from "node:path";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createCatalogPagesModel,
  renderCatalogAssetHtml,
  renderCatalogGalleryHtml,
} from "../src/catalog-pages-site.js";
import { renderBrowser3DStudioHtml } from "../src/browser-pages-site.js";
import { renderAnimationViewerHtml, renderRangerComparisonHtml } from "../src/animation-viewer-page.js";
import { writeRangerComparisonData } from "../src/ranger-comparison.js";
import { renderYoungResidentsHtml, writeYoungResidentsData } from "../src/young-residents-page.js";
import { writeSurfaceTrialPage } from "../src/surface-trial-page.js";
import { attachGeneratedGalleryPreviews, extendCatalogGalleryModel } from "../src/generated-gallery-assets.js";

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
const catalogModel = createCatalogPagesModel({ providers, sources, storage });
let galleryModel = extendCatalogGalleryModel(catalogModel);
const previewIndex = path.join(outputRoot, "previews", "index.json");
const previewsExist = await stat(previewIndex).then(
  () => true,
  (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  },
);
if (previewsExist) {
  const previews = JSON.parse(await readFile(previewIndex, "utf8"));
  galleryModel = attachGeneratedGalleryPreviews(galleryModel, previews);
  // Refuse to deploy broken media links even if the preview index itself is present.
  for (const item of Object.values(previews.assets)) {
    const urls = item.previewUrl ? [item.previewUrl] : item.previewMembers.map((member) => member.url);
    for (const url of urls) {
      const media = await stat(path.join(outputRoot, ...url.split("/")));
      if (!media.isFile() || media.size === 0) throw new Error("missing generated Pages media: " + url);
    }
  }
}
const html = renderCatalogGalleryHtml(galleryModel);

await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "index.html"), html, "utf8");
await writeFile(path.join(outputRoot, "catalog.json"), `${JSON.stringify(catalogModel, null, 2)}\n`, "utf8");
await writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");

for (const asset of galleryModel.assets) {
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

// Rigged source animation viewer (#111): a self-contained bundle of the client,
// three.js and the commit-pinned 3d-lab renderer. No CDN at runtime.
const viewerRoot = path.join(outputRoot, "viewer");
await mkdir(viewerRoot, { recursive: true });
await writeFile(path.join(viewerRoot, "index.html"), renderAnimationViewerHtml(), "utf8");
const viewerBuild = await Bun.build({
  entrypoints: [path.join(root, "src", "browser", "animation-viewer.ts")],
  outdir: viewerRoot,
  target: "browser",
  format: "esm",
  splitting: false,
  minify: true,
  sourcemap: "none",
  naming: "app.js",
});
if (!viewerBuild.success) {
  throw new Error(
    "animation viewer bundle failed:\n" +
      viewerBuild.logs.map((entry) => entry.message).join("\n"),
  );
}
// Ranger source-versus-processed comparison (#111). Its data needs the hydrated humanoid payloads and the
// pinned release tar (ASSET_TOOLING_RANGER_BUNDLE_TAR); without them the page reports that it has no data,
// unless ASSET_TOOLING_REQUIRE_RANGER_COMPARISON=1 (the Pages workflow) makes that a build failure.
const comparisonRoot = path.join(outputRoot, "compare", "ranger");
const comparison = await writeRangerComparisonData({
  repositoryRoot: root, outDir: comparisonRoot, bundleTar: process.env.ASSET_TOOLING_RANGER_BUNDLE_TAR || undefined,
  bundleLabel: process.env.ASSET_TOOLING_RANGER_BUNDLE_LABEL || undefined,
  require: process.env.ASSET_TOOLING_REQUIRE_RANGER_COMPARISON === "1",
});
await mkdir(comparisonRoot, { recursive: true });
await writeFile(path.join(comparisonRoot, "index.html"), renderRangerComparisonHtml(), "utf8");
const comparisonBuild = await Bun.build({
  entrypoints: [path.join(root, "src", "browser", "ranger-comparison.ts")],
  outdir: comparisonRoot, target: "browser", format: "esm", splitting: false, minify: true, sourcemap: "none", naming: "app.js",
});
if (!comparisonBuild.success) {
  throw new Error("ranger comparison bundle failed:\n" + comparisonBuild.logs.map((entry) => entry.message).join("\n"));
}

// Young resident faces (#556): sliders over the rolling young-residents release. Without its tar the page says it has no data.
const youngRoot = path.join(outputRoot, "compare", "young");
const young = await writeYoungResidentsData({ repositoryRoot: root, outDir: youngRoot, bundleTar: process.env.ASSET_TOOLING_YOUNG_BUNDLE_TAR || undefined });
await mkdir(youngRoot, { recursive: true });
await writeFile(path.join(youngRoot, "index.html"), renderYoungResidentsHtml(), "utf8");
const youngBuild = await Bun.build({
  entrypoints: [path.join(root, "src", "browser", "young-residents.ts")],
  outdir: youngRoot, target: "browser", format: "esm", splitting: false, minify: true, sourcemap: "none", naming: "app.js",
});
if (!youngBuild.success) {
  throw new Error("young residents bundle failed:\n" + youngBuild.logs.map((entry) => entry.message).join("\n"));
}

// Limestone surface trial (#567): baked versus layered rocks. Without both tars the page shows the committed results.
const surfaceTrial = await writeSurfaceTrialPage({
  repositoryRoot: root, outDir: path.join(outputRoot, "compare", "limestone-surface"),
  bakedTar: process.env.ASSET_TOOLING_LIMESTONE_BAKED_TAR || undefined, layeredTar: process.env.ASSET_TOOLING_LIMESTONE_LAYERED_TAR || undefined,
});

console.log(JSON.stringify({
  status: "built",
  limestoneSurfaceTrial: surfaceTrial.status === "built" ? "built" : `results only: ${surfaceTrial.reason}`,
  rangerComparison: comparison.status === "built" ? "built" : `unavailable: ${comparison.reason}`,
  youngResidents: young.status === "built" ? "built" : `unavailable: ${young.reason}`,
  assets: galleryModel.assets.length,
  detailPages: galleryModel.assets.length,
  browser3DStudio: true,
  animationViewer: true,
  output: "dist/pages",
}));
