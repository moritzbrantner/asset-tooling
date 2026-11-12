// Texture workbench (#127), dist/pages/workbench/texture/ from scripts/build-catalog-pages.ts: direct controls over one
// tileable surface recipe (`asset-tooling/recipes/surface-textures`), previewed in the browser with the recipe's own
// kernels. Contract: docs/texture-workbench.md.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { WORKBENCH_MAX_DIMENSION } from "./browser/texture-workbench-state.js";

/** Writes the page shell and its two browser bundles (`app.js`, `worker.js`) into `outDir`. */
export async function writeTextureWorkbenchPage({ repositoryRoot, outDir }: { repositoryRoot: string; outDir: string }) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.html"), renderTextureWorkbenchHtml(), "utf8");
  for (const [entry, naming] of [["texture-workbench.ts", "app.js"], ["texture-workbench-worker.ts", "worker.js"]] as const) {
    const build = await Bun.build({
      entrypoints: [path.join(repositoryRoot, "src", "browser", entry)],
      outdir: outDir, target: "browser", format: "esm", splitting: false, minify: true, sourcemap: "none", naming,
    });
    if (!build.success) throw new Error(`texture workbench ${naming} failed:\n` + build.logs.map((log) => log.message).join("\n"));
  }
}

function numberField(name: string, label: string, unit: string, min: number, max: number) {
  return `<label for="f-${name}">${label}</label>
      <div class="input"><input id="f-${name}" name="${name}" type="number" inputmode="numeric" step="1" min="${min}" max="${max}" required aria-describedby="error-${name}"><span class="unit">${unit}</span></div>
      <small class="error" id="error-${name}" aria-live="polite"></small>`;
}

function colorField(name: string, label: string) {
  return `<label for="f-${name}">${label}</label>
      <div class="input"><input id="f-${name}" name="${name}" type="text" pattern="#?[0-9a-fA-F]{6}" spellcheck="false" aria-describedby="error-${name}"><input id="${name}-swatch" type="color" aria-label="${label} picker"></div>
      <small class="error" id="error-${name}" aria-live="polite"></small>`;
}

/** Static shell; `src/browser/texture-workbench.ts` fills it. */
export function renderTextureWorkbenchHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Texture workbench · asset-tooling</title>
  <meta name="description" content="Adjust one tileable surface recipe with exact inputs, preview its channels tiled, accept a baseline and export the recipe.">
  <style>
    :root { color-scheme: dark; --bench: #1d1f1b; --panel: #272924; --line: #42453c; --ink: #ece7d8; --muted: #a9a792; --accent: #d9a441; --bad: #ef8a6f; --good: #9cc77a; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { margin: 0; min-height: 100%; }
    body { background: var(--bench); color: var(--ink); line-height: 1.35; display: grid; grid-template-columns: minmax(0, 1fr) 400px; min-height: 100vh; }
    a { color: var(--accent); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
    #stage { padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .toolbar .spacer { flex: 1; }
    .views { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; align-items: start; }
    figure { margin: 0; }
    figcaption { font-size: .82rem; color: var(--muted); padding: 4px 0; }
    canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; border: 1px solid var(--line); background: #000; }
    canvas[data-stale="true"] { opacity: .55; }
    aside { background: var(--panel); border-left: 1px solid var(--line); padding: 16px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; max-height: 100vh; position: sticky; top: 0; }
    nav { display: flex; gap: 14px; font-size: .88rem; }
    h1 { font-size: 1.35rem; margin: 0; }
    h2 { font-size: .9rem; margin: 0 0 6px; color: var(--accent); }
    fieldset { border: 0; border-top: 1px solid var(--line); margin: 0; padding: 10px 0 0; display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); gap: 4px 10px; align-items: center; }
    legend { font-size: .9rem; font-weight: 650; color: var(--accent); padding: 0 0 4px; }
    fieldset .error, fieldset .wide { grid-column: 1 / -1; }
    label { font-size: .86rem; color: var(--muted); }
    .input { display: flex; gap: 6px; align-items: center; }
    .unit { font-size: .78rem; color: var(--muted); white-space: nowrap; min-width: 5.5rem; }
    input, select, button { font: inherit; font-size: .9rem; color: var(--ink); background: var(--bench); border: 1px solid var(--line); border-radius: 4px; padding: 4px 7px; }
    input[type="number"], input[type="text"] { width: 100%; min-width: 0; }
    input[type="color"] { width: 40px; padding: 1px; height: 30px; }
    input[aria-invalid="true"] { border-color: var(--bad); }
    button { cursor: pointer; background: var(--panel); }
    button:hover:not(:disabled) { border-color: var(--muted); }
    button:disabled { opacity: .45; cursor: default; }
    button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
    button.primary { border-color: var(--accent); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .error { color: var(--bad); font-size: .8rem; min-height: 0; }
    .error:empty { display: none; }
    #status { margin: 0; font-size: .88rem; color: var(--muted); }
    #status[data-state="error"] { color: var(--bad); }
    #stages { margin: 0; font-size: .8rem; color: var(--muted); }
    #approval { margin: 0; font-size: .88rem; padding: 8px 10px; border: 1px solid var(--line); border-radius: 4px; }
    #approval[data-state="accepted"] { border-color: var(--good); color: var(--good); }
    #approval[data-state="changed"] { border-color: var(--accent); color: var(--accent); }
    dl { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: 3px 8px; margin: 0; font-size: .8rem; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .note { color: var(--muted); font-size: .8rem; margin: 0; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; }
    @media (max-width: 900px) {
      body { grid-template-columns: 1fr; }
      aside { border-left: 0; border-top: 1px solid var(--line); max-height: none; position: static; }
      fieldset { grid-template-columns: 8rem minmax(0, 1fr); }
    }
  </style>
</head>
<body>
<main id="stage">
  <nav><a href="../../">Asset gallery</a><strong>Texture workbench</strong></nav>
  <div class="toolbar" role="toolbar" aria-label="Preview">
    <button type="button" data-channel="color" title="Key 1">Color</button>
    <button type="button" data-channel="height" title="Key 2">Height</button>
    <button type="button" data-channel="normal" title="Key 3">Normal</button>
    <button type="button" data-channel="roughness" title="Key 4">Roughness</button>
    <button type="button" id="tile" title="Key T">Tile 3×3</button>
    <label><input type="checkbox" id="compare" checked> Compare with accepted</label>
    <span class="spacer"></span>
    <button type="button" id="undo" title="Ctrl+Z" disabled>Undo</button>
    <button type="button" id="redo" title="Ctrl+Shift+Z" disabled>Redo</button>
    <button type="button" id="rebuild">Rebuild</button>
    <button type="button" id="cancel" title="Escape" hidden>Cancel</button>
  </div>
  <p id="status" aria-live="polite">Loading…</p>
  <p id="stages"></p>
  <div class="views">
    <figure><canvas id="current" width="1" height="1" aria-label="Current output"></canvas><figcaption>Current</figcaption></figure>
    <figure id="accepted-figure" hidden><canvas id="accepted" width="1" height="1" aria-label="Accepted output"></canvas><figcaption>Accepted</figcaption></figure>
  </div>
</main>
<aside>
  <div>
    <h1>Texture workbench</h1>
    <p class="note">One tileable surface recipe from <code>asset-tooling/recipes/surface-textures</code>, built here with the recipe's own kernels. Channel hashes equal the CLI build's.</p>
  </div>
  <div class="row">
    <select id="preset" aria-label="Load a preset"></select>
    <button type="button" id="save-preset">Save preset</button>
    <button type="button" id="delete-preset" disabled>Delete</button>
  </div>
  <form id="recipe" novalidate>
    <fieldset>
      <legend>Seed and size</legend>
      <label for="f-seed">Seed</label>
      <div class="input"><input id="f-seed" name="seed" type="text" inputmode="numeric" pattern="0|[1-9][0-9]*" spellcheck="false" required aria-describedby="error-seed"><span class="unit">decimal</span></div>
      <small class="error" id="error-seed" aria-live="polite"></small>
      <div class="wide row"><label><input type="checkbox" id="seed-lock"> Lock seed</label><button type="button" id="reseed" title="Key R">Reseed</button></div>
      ${numberField("width", "Width", "px", 1, WORKBENCH_MAX_DIMENSION)}
      ${numberField("height", "Height", "px", 1, WORKBENCH_MAX_DIMENSION)}
    </fieldset>
    <fieldset>
      <legend>Frequency and detail</legend>
      ${numberField("gridX", "Coarse X", "cycles / tile", 1, 256)}
      ${numberField("gridY", "Coarse Y", "cycles / tile", 1, 256)}
      ${numberField("detailGridX", "Detail X", "cycles / tile", 1, 256)}
      ${numberField("detailGridY", "Detail Y", "cycles / tile", 1, 256)}
      ${numberField("detailWeight", "Detail weight", "0–255", 0, 255)}
      ${numberField("heightMin", "Height min", "0–255", 0, 255)}
      ${numberField("heightMax", "Height max", "0–255", 0, 255)}
    </fieldset>
    <fieldset>
      <legend>Furrows</legend>
      <div class="wide"><label><input type="checkbox" id="furrows"> Regular furrows</label></div>
      <label for="f-furrowAxis">Axis</label>
      <div class="input"><select id="f-furrowAxis" name="furrowAxis" aria-describedby="error-furrowAxis"><option value="x">x (vertical rows)</option><option value="y">y (horizontal rows)</option></select></div>
      <small class="error" id="error-furrowAxis" aria-live="polite"></small>
      ${numberField("furrowCount", "Count", "cycles / tile", 1, 64)}
      ${numberField("furrowDepth", "Depth", "0–255 blend", 0, 255)}
      ${numberField("furrowSoftness", "Softness", "profile samples", 0, 3)}
    </fieldset>
    <fieldset>
      <legend>Palette and material</legend>
      ${colorField("low", "Low color")}
      ${colorField("high", "High color")}
      ${numberField("normalStrength", "Normal strength", "1–1024", 1, 1024)}
      ${numberField("roughnessMin", "Roughness min", "0–255", 0, 255)}
      ${numberField("roughnessMax", "Roughness max", "0–255", 0, 255)}
    </fieldset>
    <small class="error" id="error-form" aria-live="polite"></small>
  </form>
  <div>
    <h2>Review</h2>
    <p id="approval" aria-live="polite">Technical: building…</p>
    <div class="row" style="margin-top:8px">
      <button type="button" id="accept" class="primary" disabled>Accept as baseline</button>
      <button type="button" id="reset" disabled>Reset to accepted</button>
    </div>
    <p class="note" style="margin-top:8px">Accepting marks these exact channel bytes as this browser's baseline for comparison. Any changed channel loses it. A game adopts a texture only in its own issue or PR (Decision 7.1.6).</p>
  </div>
  <div>
    <h2>Channel identity</h2>
    <dl id="identity"></dl>
  </div>
  <div>
    <h2>Export</h2>
    <div class="row">
      <button type="button" id="export-recipe">Download recipe.json</button>
      <button type="button" id="export-png">Download preview PNG</button>
    </div>
    <p class="note" style="margin-top:8px">The recipe is the editable source. Build the canonical channels and PNGs with <code id="cli"></code>; it prints the same channel hashes.</p>
  </div>
</aside>
<script type="module" src="./app.js"></script>
</body>
</html>
`;
}
