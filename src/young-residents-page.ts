// The young residents face page (#556), dist/pages/compare/young/ from scripts/build-catalog-pages.ts: live sliders over
// the kit's morph targets. It copies the bundle tar of the rolling young-residents release and the KTX2 transcoder.
// Contract: docs/young-residents.md#sliders.
import path from "node:path";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readAssetBundleTar } from "./asset-bundle-pack.js";

export const YOUNG_PAGE_DESCRIPTOR = "young-residents-descriptor";

/**
 * Writes the page's data into `outDir`: `bundle/` and `basis/`. Returns `{status: "unavailable", reason}` without writing
 * anything when no bundle tar is given, which is expected until the first release exists.
 */
export async function writeYoungResidentsData({ repositoryRoot, outDir, bundleTar }: { repositoryRoot: string; outDir: string; bundleTar?: string }):
Promise<{ status: "built"; figures: number } | { status: "unavailable"; reason: string }> {
  if (!bundleTar) return { status: "unavailable", reason: "no young-residents bundle tar given (ASSET_TOOLING_YOUNG_BUNDLE_TAR)" };
  const entries = readAssetBundleTar(await readFile(bundleTar));
  const manifestBytes = entries.find((entry) => entry.path === "manifest.json")?.bytes;
  if (!manifestBytes) throw new Error("young residents bundle has no manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { assets: unknown[] };
  await rm(outDir, { recursive: true, force: true });
  for (const entry of entries) {
    const file = path.join(outDir, "bundle", entry.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, entry.bytes);
  }
  await mkdir(path.join(outDir, "basis"), { recursive: true });
  for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
    await copyFile(path.join(repositoryRoot, "node_modules/three/examples/jsm/libs/basis", name), path.join(outDir, "basis", name));
  }
  return { status: "built", figures: manifest.assets.length };
}

/** Static shell of the page; `src/browser/young-residents.ts` fills it from the bundle's descriptor. */
export function renderYoungResidentsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Young resident faces · asset-tooling</title>
  <meta name="description" content="Shape the faces of the young residents kit with live sliders, and play the adult clips on them.">
  <style>
    :root { color-scheme: dark; --bench: #1f211c; --panel: #2a2c25; --line: #43463b; --ink: #ece7d8; --muted: #aaa892; --accent: #d9a441; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { background: var(--bench); color: var(--ink); line-height: 1.35; display: grid; grid-template-columns: minmax(0, 1fr) 380px; }
    a { color: var(--accent); }
    #stage { position: relative; min-height: 0; }
    canvas { display: block; width: 100%; height: 100%; touch-action: none; }
    #status { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; color: #26281f; pointer-events: none; }
    #playback { position: absolute; left: 16px; bottom: 16px; display: flex; flex-wrap: wrap; gap: 8px; }
    aside { background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; }
    h1 { font-size: 1.4rem; line-height: 1.1; margin: 0; }
    h2 { font-size: .95rem; margin: 0 0 8px; color: var(--accent); }
    .note { color: var(--muted); font-size: .875rem; margin: 4px 0 0; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; }
    button { font: inherit; font-size: .9rem; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 5px 10px; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--muted); }
    button:disabled { opacity: .5; cursor: default; }
    button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #221a08; }
    button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .swatch { width: 30px; height: 30px; padding: 0; border-radius: 50%; border: 2px solid var(--line); }
    .swatch[aria-pressed="true"] { border-color: var(--ink); box-shadow: 0 0 0 2px var(--accent); }
    .dial { display: grid; grid-template-columns: 124px minmax(0, 1fr) 40px; align-items: center; gap: 8px; padding: 2px 0; }
    .dial label { font-size: .925rem; }
    .dial input { width: 100%; accent-color: var(--accent); margin: 0; }
    .dial output { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); font-size: .875rem; }
    #dials { display: flex; flex-direction: column; gap: 18px; }
    textarea { width: 100%; height: 86px; background: var(--bench); color: var(--muted); border: 1px solid var(--line); border-radius: 4px; font: 12px/1.3 ui-monospace, monospace; padding: 6px; resize: vertical; }
    @media (max-width: 760px) { body { grid-template-columns: minmax(0, 1fr); grid-template-rows: 46vh minmax(0, 1fr); } aside { border-left: 0; border-top: 1px solid var(--line); } }
  </style>
</head>
<body>
  <main id="stage">
    <canvas id="view" tabindex="0" aria-label="Character preview. Drag to turn it, scroll to zoom."></canvas>
    <div id="status" role="status">Loading the characters…</div>
    <div id="playback" role="group" aria-label="View and motion">
      <button type="button" id="view-face" aria-pressed="true">Face</button>
      <button type="button" id="view-body" aria-pressed="false">Full figure</button>
      <button type="button" id="clip-none" aria-pressed="true">Still</button>
      <button type="button" id="clip-Idle_Loop" aria-pressed="false">Idle</button>
      <button type="button" id="clip-Walk_Loop" aria-pressed="false">Walk</button>
    </div>
  </main>
  <aside>
    <header>
      <h1>Young resident faces</h1>
      <p class="note">Drag a slider and the face changes live. Double-click a slider to put it back. <a href="../../">Back to the catalog</a></p>
    </header>
    <section><h2>Character</h2><div class="row" id="characters"></div></section>
    <section>
      <h2>Peoples</h2>
      <div class="row" id="peoples"></div>
      <p class="note">Starting points for facial structure and skin. The names are placeholders.</p>
    </section>
    <section><h2>Skin</h2><div class="row" id="skins"></div></section>
    <section><h2>Hair</h2><div class="row" id="hairs"></div></section>
    <div id="dials"></div>
    <section>
      <div class="row"><button type="button" id="reset">Reset this character</button><button type="button" id="copy">Copy values</button></div>
      <p class="note" id="copied" role="status"></p>
      <label class="note" for="json">These values, ready to paste into a preset:</label>
      <textarea id="json" readonly></textarea>
    </section>
  </aside>
  <script type="module" src="app.js"></script>
</body>
</html>
`;
}
