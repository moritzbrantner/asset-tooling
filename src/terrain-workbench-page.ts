// Terrain workbench (#127), dist/pages/workbench/terrain/ from scripts/build-catalog-pages.ts: direct controls over
// one terrain patch recipe (`asset-tooling/recipes/terrain-patches`), built in the browser by the recipe's own
// component build so only affected components rebuild. Contract: docs/terrain-workbench.md.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/** Writes the page shell and its two browser bundles (`app.js`, `worker.js`) into `outDir`. */
export async function writeTerrainWorkbenchPage({ repositoryRoot, outDir }: { repositoryRoot: string; outDir: string }) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.html"), renderTerrainWorkbenchHtml(), "utf8");
  // The recipe module's PNG codec and hashes import node:zlib and node:crypto; the browser gets the same functions.
  const shims: [RegExp, string][] = [
    [/^(node:)?zlib$/, path.join(repositoryRoot, "src", "browser", "node-zlib-shim.ts")],
    [/^(node:)?crypto$/, path.join(repositoryRoot, "src", "browser", "node-crypto-shim.ts")],
    [/^(node:)?(fs|path)$/, path.join(repositoryRoot, "src", "browser", "node-empty-shim.ts")],
  ];
  for (const [entry, naming] of [["terrain-workbench.ts", "app.js"], ["terrain-workbench-worker.ts", "worker.js"]] as const) {
    const build = await Bun.build({
      entrypoints: [path.join(repositoryRoot, "src", "browser", entry)],
      outdir: outDir, target: "browser", format: "esm", splitting: false, minify: true, sourcemap: "none", naming,
      plugins: [{ name: "node-shims", setup(builder) {
        for (const [filter, shim] of shims) builder.onResolve({ filter }, () => ({ path: shim }));
      } }],
    });
    if (!build.success) throw new Error(`terrain workbench ${naming} failed:\n` + build.logs.map((log) => log.message).join("\n"));
  }
}

/** Static shell; `src/browser/terrain-workbench.ts` fills the recipe form, the views and the component list. */
export function renderTerrainWorkbenchHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terrain workbench · asset-tooling</title>
  <meta name="description" content="Adjust one terrain patch recipe with exact inputs, keep or reseed its components, rebuild only what changed and export the recipe.">
  <style>
    :root { color-scheme: dark; --bench: #1b1e1b; --panel: #252923; --line: #40463b; --ink: #ebe8d9; --muted: #a6a893; --accent: #d9a441; --bad: #ef8a6f; --good: #9cc77a; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { margin: 0; min-height: 100%; }
    body { background: var(--bench); color: var(--ink); line-height: 1.35; display: grid; grid-template-columns: minmax(0, 1fr) 430px; min-height: 100vh; }
    a { color: var(--accent); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
    #stage { padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .toolbar .spacer { flex: 1; }
    .views { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; align-items: start; }
    figure { margin: 0; }
    figcaption { font-size: .82rem; color: var(--muted); padding: 4px 0; }
    canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; border: 1px solid var(--line); background: #000; }
    canvas[data-stale="true"] { opacity: .55; }
    aside { background: var(--panel); border-left: 1px solid var(--line); padding: 16px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; max-height: 100vh; position: sticky; top: 0; }
    nav { display: flex; gap: 14px; font-size: .88rem; }
    h1 { font-size: 1.35rem; margin: 0; }
    h2 { font-size: .9rem; margin: 0 0 6px; color: var(--accent); }
    fieldset { border: 0; border-top: 1px solid var(--line); margin: 0; padding: 10px 0 0; display: grid; grid-template-columns: 8.5rem minmax(0, 1fr); gap: 4px 10px; align-items: center; }
    legend { font-size: .9rem; font-weight: 650; color: var(--accent); padding: 0 0 4px; display: flex; gap: 8px; align-items: center; }
    fieldset .error, fieldset .wide { grid-column: 1 / -1; }
    label { font-size: .86rem; color: var(--muted); }
    .input { display: flex; gap: 6px; align-items: center; min-width: 0; }
    .input input, .input select { flex: 1 1 0; width: 100%; min-width: 0; }
    .unit { font-size: .76rem; color: var(--muted); white-space: nowrap; min-width: 3.2rem; }
    input, select, button, textarea { font: inherit; font-size: .88rem; color: var(--ink); background: var(--bench); border: 1px solid var(--line); border-radius: 4px; padding: 4px 7px; }
    input[type="text"], select { width: 100%; min-width: 0; }
    textarea { width: 100%; min-height: 5.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .76rem; resize: vertical; }
    [aria-invalid="true"] { border-color: var(--bad) !important; }
    button { cursor: pointer; background: var(--panel); }
    button:hover:not(:disabled) { border-color: var(--muted); }
    button:disabled { opacity: .45; cursor: default; }
    button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
    button.primary { border-color: var(--accent); }
    button.small { font-size: .78rem; padding: 2px 6px; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .error { color: var(--bad); font-size: .8rem; }
    .error:empty { display: none; }
    #status { margin: 0; font-size: .88rem; color: var(--muted); }
    #status[data-state="error"] { color: var(--bad); }
    #stages { margin: 0; font-size: .8rem; color: var(--muted); }
    #legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: .8rem; color: var(--muted); margin: 0; padding: 0; list-style: none; }
    #legend i { display: inline-block; width: .7rem; height: .7rem; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
    #approval { margin: 0; font-size: .88rem; padding: 8px 10px; border: 1px solid var(--line); border-radius: 4px; }
    #approval[data-state="accepted"] { border-color: var(--good); color: var(--good); }
    #approval[data-state="changed"] { border-color: var(--accent); color: var(--accent); }
    table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    th, td { text-align: left; padding: 3px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 500; }
    td[data-status="executed"] { color: var(--accent); }
    td[data-status="reused"] { color: var(--good); }
    td[data-diff="changed"] { color: var(--accent); }
    tr[data-refused="true"] td:first-child { color: var(--bad); }
    .note { color: var(--muted); font-size: .8rem; margin: 0; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    @media (max-width: 960px) {
      body { grid-template-columns: 1fr; }
      aside { border-left: 0; border-top: 1px solid var(--line); max-height: none; position: static; }
      fieldset { grid-template-columns: 7.5rem minmax(0, 1fr); }
    }
  </style>
</head>
<body>
<main id="stage">
  <nav><a href="../../">Asset gallery</a><a href="../texture/">Texture workbench</a><strong>Terrain workbench</strong></nav>
  <div class="toolbar" role="toolbar" aria-label="Preview">
    <span id="view-buttons" class="row"></span>
    <button type="button" id="overlay" title="Key D">Detail</button>
    <label><input type="checkbox" id="compare" checked> Compare with accepted</label>
    <span class="spacer"></span>
    <button type="button" id="undo" title="Ctrl+Z" disabled>Undo</button>
    <button type="button" id="redo" title="Ctrl+Shift+Z" disabled>Redo</button>
    <button type="button" id="rebuild">Rebuild</button>
    <button type="button" id="cancel" title="Escape" hidden>Cancel</button>
  </div>
  <p id="status" aria-live="polite">Loading…</p>
  <p id="stages"></p>
  <ul id="legend"></ul>
  <div class="views">
    <figure><canvas id="current" width="1" height="1" aria-label="Current patches"></canvas><figcaption id="current-caption">Current</figcaption></figure>
    <figure id="accepted-figure" hidden><canvas id="accepted" width="1" height="1" aria-label="Accepted patches"></canvas><figcaption>Accepted</figcaption></figure>
  </div>
</main>
<aside>
  <div>
    <h1>Terrain workbench</h1>
    <p class="note">One recipe from <code>asset-tooling/recipes/terrain-patches</code>, built here as the CLI's 2×2 patch grid by the recipe's own component build. Only components whose inputs changed rebuild.</p>
  </div>
  <div class="row">
    <select id="preset" aria-label="Load a preset"></select>
    <button type="button" id="save-preset">Save preset</button>
    <button type="button" id="delete-preset" disabled>Delete</button>
  </div>
  <form id="recipe" novalidate></form>
  <div class="row">
    <button type="button" id="add-layer">Add detail layer</button>
    <button type="button" id="reseed-all" title="Key R">Reseed unlocked seeds</button>
  </div>
  <small class="error" id="error-form" aria-live="polite"></small>
  <div>
    <h2>Components</h2>
    <p class="note">Keep a component to refuse any edit that would change it; the build then fails and the last result stays. Counts are over the four patches.</p>
    <table>
      <thead><tr><th scope="col">Component</th><th scope="col">Last build</th><th scope="col">Accepted</th><th scope="col">Keep</th></tr></thead>
      <tbody id="components"></tbody>
    </table>
  </div>
  <div>
    <h2>Review</h2>
    <p id="approval" aria-live="polite">Technical: building…</p>
    <div class="row" style="margin-top:8px">
      <button type="button" id="accept" class="primary" disabled>Accept as baseline</button>
      <button type="button" id="reset" disabled>Reset to accepted</button>
    </div>
    <p class="note" style="margin-top:8px">Accepting marks these exact component outputs as this browser's baseline for comparison. Any changed component loses it. A game adopts terrain only in its own issue or PR (Decision 7.1.6).</p>
  </div>
  <div>
    <h2>Export</h2>
    <div class="row">
      <button type="button" id="export-recipe">Download recipe.json</button>
      <button type="button" id="export-png">Download preview PNG</button>
    </div>
    <p class="note" style="margin-top:8px">The recipe is the editable source. Build the canonical patch files with <code id="cli"></code>; its manifest lists the same component keys, mesh.glb and detail.json hashes.</p>
  </div>
</aside>
<script type="module" src="./app.js"></script>
</body>
</html>
`;
}
