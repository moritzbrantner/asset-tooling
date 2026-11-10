// The limestone surface trial (#567), dist/pages/compare/limestone-surface/ from scripts/build-catalog-pages.ts: the
// baked kit and the layered kit side by side on a Greyhaven-like rock scatter, with their costs and frame times.
// The live scene needs both bundle tars (scripts/measure-surface-trial.ts); without them the page shows the measured
// results committed in review/limestone-rocks/surface-trial/. Contract: docs/limestone-rocks.md#layered-surface-trial.
import path from "node:path";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readAssetBundleTar } from "./asset-bundle-pack.js";

export const SURFACE_TRIAL_RESULTS = "review/limestone-rocks/surface-trial";

/**
 * Writes the page's data into `outDir`: the committed results (`results/`), and with both tars `baked/`, `layered/` and
 * `basis/`. Returns whether the live scene has data.
 */
export async function writeSurfaceTrialData({ repositoryRoot, outDir, bakedTar, layeredTar }: {
  repositoryRoot: string; outDir: string; bakedTar?: string; layeredTar?: string;
}): Promise<{ status: "built" } | { status: "unavailable"; reason: string }> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "results"), { recursive: true });
  const results = path.join(repositoryRoot, SURFACE_TRIAL_RESULTS);
  for (const name of await readdir(results).catch(() => [] as string[])) {
    if (name.endsWith(".json") || name.endsWith(".jpg")) await copyFile(path.join(results, name), path.join(outDir, "results", name));
  }
  if (!bakedTar || !layeredTar) return { status: "unavailable", reason: "no limestone bundle tars given (ASSET_TOOLING_LIMESTONE_BAKED_TAR, ASSET_TOOLING_LIMESTONE_LAYERED_TAR)" };
  for (const [name, tar] of [["baked", bakedTar], ["layered", layeredTar]] as const) {
    for (const entry of readAssetBundleTar(await readFile(tar))) {
      const file = path.join(outDir, name, entry.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, entry.bytes);
    }
  }
  await mkdir(path.join(outDir, "basis"), { recursive: true });
  for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
    await copyFile(path.join(repositoryRoot, "node_modules/three/examples/jsm/libs/basis", name), path.join(outDir, "basis", name));
  }
  return { status: "built" };
}

/** Writes the whole page into `outDir`: its data, its shell and the bundled client. */
export async function writeSurfaceTrialPage(options: { repositoryRoot: string; outDir: string; bakedTar?: string; layeredTar?: string }) {
  const result = await writeSurfaceTrialData(options);
  await writeFile(path.join(options.outDir, "index.html"), renderSurfaceTrialHtml(), "utf8");
  const build = await Bun.build({
    entrypoints: [path.join(options.repositoryRoot, "src", "browser", "surface-trial.ts")],
    outdir: options.outDir, target: "browser", format: "esm", splitting: false, minify: true, sourcemap: "none", naming: "app.js",
  });
  if (!build.success) throw new Error("surface trial bundle failed:\n" + build.logs.map((entry) => entry.message).join("\n"));
  return result;
}

/** Static shell of the page; `src/browser/surface-trial.ts` fills it. */
export function renderSurfaceTrialHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Limestone surface trial · asset-tooling</title>
  <meta name="description" content="Baked atlas versus shared materials and masks on the limestone rocks: looks, texture memory, draw calls and frame time.">
  <style>
    :root { color-scheme: dark; --bench: #1f211c; --panel: #2a2c25; --line: #43463b; --ink: #ece7d8; --muted: #aaa892; --accent: #d9a441; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { height: 100%; margin: 0; }
    body { background: var(--bench); color: var(--ink); line-height: 1.35; display: grid; grid-template-columns: minmax(0, 1fr) 420px; }
    a { color: var(--accent); }
    #stage { position: relative; min-height: 0; }
    canvas { display: block; width: 100%; height: 100%; }
    #status { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--muted); pointer-events: none; }
    #gallery { position: absolute; inset: 0; overflow-y: auto; padding: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; align-content: start; }
    #gallery figure { margin: 0; }
    #gallery img { width: 100%; display: block; border: 1px solid var(--line); }
    #gallery figcaption { font-size: .85rem; color: var(--muted); padding: 4px 0; }
    aside { background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; }
    h1 { font-size: 1.4rem; line-height: 1.1; margin: 0; }
    h2 { font-size: .95rem; margin: 0 0 8px; color: var(--accent); }
    .note { color: var(--muted); font-size: .875rem; margin: 4px 0 0; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; }
    button { font: inherit; font-size: .9rem; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 5px 10px; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--muted); }
    button:disabled { opacity: .5; cursor: default; }
    button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #221a08; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    table { border-collapse: collapse; width: 100%; font-size: .85rem; font-variant-numeric: tabular-nums; }
    th, td { text-align: right; padding: 3px 4px; border-bottom: 1px solid var(--line); }
    th:first-child, td:first-child { text-align: left; }
    th { color: var(--muted); font-weight: normal; }
    @media (max-width: 860px) { body { grid-template-columns: minmax(0, 1fr); grid-template-rows: 50vh minmax(0, 1fr); } aside { border-left: 0; border-top: 1px solid var(--line); } }
  </style>
</head>
<body>
  <main id="stage">
    <canvas id="view" aria-label="Limestone rocks on a Greyhaven-like scatter, from the game camera"></canvas>
    <div id="gallery" hidden></div>
    <div id="status" role="status">Loading the limestone kits…</div>
  </main>
  <aside>
    <header>
      <h1>Limestone surface trial</h1>
      <p class="note">The same rocks two ways: <b>baked</b>, today's kit with one atlas, and <b>layered</b>, the same meshes with per-vertex masks over a shared library of tileable limestone, moss and soil, at three weathering levels. The layered blend is a reference shader for this review, not the game's. <a href="../../">Back to the catalog</a></p>
    </header>
    <section id="live" hidden>
      <h2>Surface</h2>
      <div class="row" id="modes"></div>
      <h2 style="margin-top:12px">Camera</h2>
      <div class="row" id="views"></div>
      <h2 style="margin-top:12px">This browser</h2>
      <div class="row"><button type="button" id="measure">Measure frame time</button></div>
      <table id="stats"></table>
      <p class="note" id="gpu"></p>
    </section>
    <section>
      <h2>Measured results</h2>
      <div id="results"><p class="note">No results have been committed yet.</p></div>
    </section>
  </aside>
  <script type="module" src="app.js"></script>
</body>
</html>
`;
}
