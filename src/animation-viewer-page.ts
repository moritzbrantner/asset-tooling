// Static shell of the rigged source animation viewer (#111), written to
// dist/pages/viewer/index.html. The bundled client (src/browser/animation-viewer.ts,
// emitted as viewer/app.js) resolves `?asset=` against the site's catalog.json
// at runtime and fills in everything asset-specific.
// Contract: docs/animation-viewer.md.

export const ANIMATION_VIEWER_PRESETS = ["Front", "Side", "Back", "Gameplay"] as const;

export function renderAnimationViewerHtml(): string {
  const presets = ANIMATION_VIEWER_PRESETS.map(
    (name) => `<button type="button" class="preset" data-view="${name.toLowerCase()}" aria-pressed="false">${name}</button>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Animation viewer · asset-tooling</title>
  <meta name="description" content="Inspect a pinned rigged catalog source and its animation clips.">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    a { color: LinkText; }
    main { max-width: 1240px; margin: 0 auto; padding: 20px 24px 64px; }
    .back { display: inline-block; margin-bottom: 12px; }
    h1 { margin: 0 0 4px; font-size: clamp(1.5rem, 3.4vw, 2.1rem); letter-spacing: -0.03em; overflow-wrap: anywhere; }
    .eyebrow { margin: 0 0 6px; color: color-mix(in srgb, CanvasText 58%, Canvas); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; font-weight: 700; }
    .id { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: color-mix(in srgb, CanvasText 62%, Canvas); overflow-wrap: anywhere; }
    header { margin-bottom: 16px; }
    #status { margin: 0 0 16px; color: color-mix(in srgb, CanvasText 68%, Canvas); }
    .failure { margin: 0 0 16px; padding: 14px 16px; border: 1px solid color-mix(in srgb, #d22 55%, Canvas); border-radius: 12px; background: color-mix(in srgb, #d22 9%, Canvas); }
    .failure p { margin: 0 0 6px; line-height: 1.45; overflow-wrap: anywhere; }
    .failure strong { display: block; margin-bottom: 4px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    @media (min-width: 900px) { .workspace { grid-template-columns: minmax(0, 1fr) 340px; } }
    .stage { min-width: 0; }
    canvas { display: block; width: 100%; height: clamp(280px, calc(100vh - 230px), 760px); border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 14px; background: color-mix(in srgb, CanvasText 6%, Canvas); touch-action: none; cursor: grab; }
    canvas:active { cursor: grabbing; }
    @media (max-width: 899px) { canvas { height: auto; aspect-ratio: 4 / 3; } }
    .hint { margin: 8px 0 0; font-size: .85rem; color: color-mix(in srgb, CanvasText 62%, Canvas); }
    .panel { display: grid; gap: 14px; min-width: 0; }
    .field { display: grid; gap: 6px; min-width: 0; }
    .field > label, .group-label { font-weight: 650; font-size: .9rem; }
    select, input[type="number"], button { font: inherit; color: CanvasText; background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 10px; }
    select, input[type="number"] { width: 100%; min-width: 0; padding: 9px 10px; }
    input[type="range"] { width: 100%; margin: 0; accent-color: LinkText; }
    button { padding: 9px 14px; cursor: pointer; font-weight: 650; }
    button[aria-pressed="true"] { background: color-mix(in srgb, LinkText 16%, Canvas); border-color: LinkText; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    #play { min-width: 92px; }
    .check { display: inline-flex; gap: 8px; align-items: center; font-weight: 650; font-size: .9rem; }
    .check input { width: 18px; height: 18px; margin: 0; }
    .presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .presets button { flex: 1 1 auto; padding: 8px 10px; }
    :is(select, input, button, canvas, summary, a):focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
    dl { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: .9rem; }
    dt { color: color-mix(in srgb, CanvasText 58%, Canvas); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
    details { border-top: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); padding-top: 10px; font-size: .9rem; }
    summary { cursor: pointer; font-weight: 650; }
    pre { margin: 8px 0 0; padding: 10px; max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 8px; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    .note { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: .88rem; line-height: 1.45; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    [hidden] { display: none !important; }
    @media (max-width: 480px) { main { padding-inline: 16px; } dl { grid-template-columns: 96px minmax(0, 1fr); } }
  </style>
</head>
<body>
<main>
  <a class="back" href="../">← Back to gallery</a>
  <header>
    <p class="eyebrow">Animation viewer · Original source</p>
    <h1 id="viewer-title">Animation viewer</h1>
    <p class="id" id="viewer-asset-id"></p>
  </header>
  <p id="status" role="status" aria-live="polite">Loading…</p>
  <div id="failure" class="failure" hidden></div>
  <div class="workspace" id="workspace" hidden>
    <div class="stage">
      <canvas id="viewer-canvas" tabindex="0" role="img" aria-label="Animated 3D view of the original source. Drag or use the arrow keys to orbit; use the wheel or + and - to zoom."></canvas>
      <p class="hint">Drag to orbit, wheel to zoom. With the view focused: arrow keys orbit, + and - zoom.</p>
    </div>
    <section class="panel" aria-label="Animation controls">
      <div class="field">
        <label for="clip">Clip</label>
        <select id="clip" disabled></select>
      </div>
      <div class="row">
        <button type="button" id="play" disabled>Play</button>
        <label class="check"><input type="checkbox" id="rest" disabled> Rest pose</label>
      </div>
      <div class="field">
        <label for="time">Time (seconds)</label>
        <input id="time" type="number" inputmode="decimal" min="0" step="0.001" value="0" disabled>
        <input id="scrub" type="range" min="0" max="0" step="0.001" value="0" aria-label="Time slider" disabled>
      </div>
      <div class="field" role="group" aria-labelledby="camera-label">
        <span class="group-label" id="camera-label">Camera</span>
        <div class="presets">${presets}</div>
      </div>
      <dl id="identity"></dl>
      <details id="provenance">
        <summary>Provenance</summary>
        <div id="provenance-body"></div>
      </details>
      <p class="note">This view shows the original source only. The Ranger's source-versus-processed comparison is at <a href="../compare/ranger/">compare/ranger/</a>.</p>
    </section>
  </div>
</main>
<script type="module" src="app.js"></script>
</body>
</html>
`;
}

const COMPARISON_PANELS = [
  ["source", "Original Ranger source in rest pose"],
  ["motion", "Source motion: the clip library's mannequin"],
  ["processed", "Processed Ranger bundle"],
  ["archer", "Primitive-built archer"],
] as const;

/** Static shell of the Ranger source-versus-processed comparison (#111), dist/pages/compare/ranger/index.html. */
export function renderRangerComparisonHtml(): string {
  const presets = ANIMATION_VIEWER_PRESETS.map(
    (name) => `<button type="button" class="preset" data-view="${name.toLowerCase()}" aria-pressed="false" disabled>${name}</button>`,
  ).join("");
  const panels = COMPARISON_PANELS.map(([id, label]) => `      <figure class="panel-view">
        <canvas id="canvas-${id}" tabindex="0" role="img" aria-label="${label}. Drag or use the arrow keys to orbit; use the wheel or + and - to zoom."></canvas>
        <figcaption id="caption-${id}"></figcaption>
      </figure>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ranger comparison · asset-tooling</title>
  <meta name="description" content="The original Ranger source, the clip library's source motion, the processed Ranger bundle and the primitive-built archer, side by side.">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    a { color: LinkText; }
    main { max-width: 1480px; margin: 0 auto; padding: 20px 24px 64px; }
    h1 { margin: 0 0 4px; font-size: clamp(1.5rem, 3.4vw, 2.1rem); letter-spacing: -0.03em; }
    .eyebrow { margin: 0 0 6px; color: color-mix(in srgb, CanvasText 58%, Canvas); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; font-weight: 700; }
    header { margin-bottom: 16px; }
    #status { margin: 0 0 16px; color: color-mix(in srgb, CanvasText 68%, Canvas); }
    .failure { margin: 0 0 16px; padding: 14px 16px; border: 1px solid color-mix(in srgb, #d22 55%, Canvas); border-radius: 12px; background: color-mix(in srgb, #d22 9%, Canvas); }
    .failure p { margin: 4px 0 0; overflow-wrap: anywhere; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
    @media (min-width: 1100px) { .workspace { grid-template-columns: minmax(0, 1fr) 300px; } }
    .views { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; }
    @media (min-width: 600px) { .views { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (min-width: 1500px) { .views { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    figure { margin: 0; min-width: 0; }
    canvas { display: block; width: 100%; aspect-ratio: 3 / 4; border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 12px; background: color-mix(in srgb, CanvasText 6%, Canvas); touch-action: none; cursor: grab; }
    figcaption { display: grid; gap: 2px; margin-top: 6px; font-size: .82rem; overflow-wrap: anywhere; }
    figcaption span { color: color-mix(in srgb, CanvasText 62%, Canvas); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .76rem; }
    .panel { display: grid; gap: 14px; min-width: 0; }
    .field { display: grid; gap: 6px; min-width: 0; }
    .field > label, .group-label { font-weight: 650; font-size: .9rem; }
    select, input[type="number"], button { font: inherit; color: CanvasText; background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 10px; }
    select, input[type="number"] { width: 100%; min-width: 0; padding: 9px 10px; }
    input[type="range"] { width: 100%; margin: 0; accent-color: LinkText; }
    button { padding: 9px 14px; cursor: pointer; font-weight: 650; }
    button[aria-pressed="true"] { background: color-mix(in srgb, LinkText 16%, Canvas); border-color: LinkText; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .check { display: inline-flex; gap: 8px; align-items: center; font-weight: 650; font-size: .9rem; }
    .presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .presets button { flex: 1 1 auto; padding: 8px 10px; }
    :is(select, input, button, canvas, a):focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
    .note { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: .88rem; line-height: 1.45; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    [hidden] { display: none !important; }
    @media (max-width: 480px) { main { padding-inline: 16px; } }
  </style>
</head>
<body>
<main>
  <a href="../../">← Back to gallery</a>
  <header>
    <p class="eyebrow">Source-versus-processed comparison</p>
    <h1>Ranger: source, motion, bundle and primitive archer</h1>
  </header>
  <p id="status" role="status" aria-live="polite">Loading…</p>
  <div id="failure" class="failure" hidden></div>
  <div class="workspace" id="workspace" hidden>
    <div class="views">
${panels}
    </div>
    <section class="panel" aria-label="Comparison controls">
      <div class="field">
        <label for="clip">Clip</label>
        <select id="clip" disabled></select>
      </div>
      <div class="row">
        <button type="button" id="play" disabled>Play</button>
        <label class="check"><input type="checkbox" id="rest" disabled> Rest pose</label>
      </div>
      <div class="field">
        <label for="time">Time (seconds)</label>
        <input id="time" type="number" inputmode="decimal" min="0" step="0.001" value="0" disabled>
        <input id="scrub" type="range" min="0" max="0" step="0.001" value="0" aria-label="Time slider" disabled>
      </div>
      <div class="field" role="group" aria-labelledby="camera-label">
        <span class="group-label" id="camera-label">Camera (all views)</span>
        <div class="presets">${presets}</div>
      </div>
      <div class="field" role="group" aria-labelledby="parts-label">
        <span class="group-label" id="parts-label">Original source parts</span>
        <label class="check"><input type="checkbox" id="show-outfit" checked disabled> Male_Ranger outfit</label>
        <label class="check"><input type="checkbox" id="show-body" checked disabled> Universal Base Characters body</label>
      </div>
      <p class="note">All four views share the clip, time and camera. The original source ships no clips, so it always shows its rest pose. The source motion is the clip library's own mannequin, before retargeting. Matching poses do not mean visual approval.</p>
    </section>
  </div>
</main>
<script type="module" src="app.js"></script>
</body>
</html>
`;
}
