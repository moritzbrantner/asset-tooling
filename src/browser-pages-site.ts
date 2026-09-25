import {
  BROWSER_ORT_VERSION,
  BROWSER_SF3D_MODEL,
  BROWSER_THREE_VERSION,
} from "./browser/sf3d-model-manifest.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderBrowser3DStudioHtml(): string {
  const modelGiB = (BROWSER_SF3D_MODEL.totalBytes / 1024 ** 3).toFixed(2);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>3D studio · asset-tooling</title>
  <meta name="description" content="Run Stable Fast 3D locally in the browser with WebGPU.">
  <script type="importmap">
  {
    "imports": {
      "onnxruntime-web": "https://cdn.jsdelivr.net/npm/onnxruntime-web@${escapeHtml(BROWSER_ORT_VERSION)}/dist/ort.webgpu.min.mjs",
      "three": "https://cdn.jsdelivr.net/npm/three@${escapeHtml(BROWSER_THREE_VERSION)}/build/three.module.js",
      "three/": "https://cdn.jsdelivr.net/npm/three@${escapeHtml(BROWSER_THREE_VERSION)}/"
    }
  }
  </script>
  <script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js"></script>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    button, input { font: inherit; }
    button, .button-link {
      min-height: 40px;
      padding: 8px 12px;
      border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas);
      border-radius: 9px;
      background: Canvas;
      color: CanvasText;
      text-decoration: none;
      cursor: pointer;
    }
    button:disabled { opacity: .48; cursor: default; }
    .primary { background: CanvasText; color: Canvas; border-color: CanvasText; font-weight: 700; }
    main { max-width: 1280px; margin: 0 auto; padding: 28px 24px 64px; }
    nav { display: flex; gap: 18px; align-items: center; margin-bottom: 24px; font-size: .9rem; }
    nav a { color: inherit; }
    h1 { margin: 0; font-size: 1.7rem; letter-spacing: -.025em; }
    .title-row { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
    .panel { border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 14px; overflow: hidden; }
    .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-height: 58px; padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); }
    .panel-header h2 { margin: 0; font-size: 1rem; }
    .viewport { position: relative; min-height: 430px; display: grid; place-items: center; background: color-mix(in srgb, CanvasText 4%, Canvas); }
    #source-zone[data-drag="true"] { outline: 2px solid LinkText; outline-offset: -5px; }
    #source-preview { max-width: 100%; max-height: 430px; object-fit: contain; }
    #result-viewer { width: 100%; height: 430px; background: transparent; }
    .empty { max-width: 330px; padding: 28px; text-align: center; color: color-mix(in srgb, CanvasText 62%, Canvas); line-height: 1.5; }
    .controls { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; padding: 14px 16px; align-items: center; border-top: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); }
    input[type="file"] { min-width: 0; }
    .runtime { padding: 14px 16px; border-top: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); display: grid; gap: 10px; }
    progress { width: 100%; height: 8px; }
    #status { margin: 0; min-height: 1.4em; color: color-mix(in srgb, CanvasText 72%, Canvas); font-size: .9rem; }
    #status[data-state="error"] { color: #d14444; }
    #runtime, #result-summary { color: color-mix(in srgb, CanvasText 58%, Canvas); font-size: .8rem; overflow-wrap: anywhere; }
    details { margin-top: 20px; border-top: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); padding-top: 16px; }
    summary { cursor: pointer; font-weight: 650; }
    .details-grid { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 8px 16px; margin-top: 14px; font-size: .88rem; }
    .details-grid dt { color: color-mix(in srgb, CanvasText 58%, Canvas); }
    .details-grid dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
    .license { margin-top: 16px; font-size: .82rem; line-height: 1.5; color: color-mix(in srgb, CanvasText 62%, Canvas); }
    [hidden] { display: none !important; }
    @media (max-width: 850px) {
      .workspace { grid-template-columns: 1fr; }
      .viewport, #result-viewer { min-height: 330px; height: 330px; }
    }
    @media (max-width: 620px) {
      main { padding-inline: 14px; }
      .title-row { display: block; }
      .controls { grid-template-columns: 1fr; }
      .details-grid { grid-template-columns: 1fr; gap: 3px; }
      .details-grid dd { margin-bottom: 8px; }
    }
  </style>
</head>
<body>
<main>
  <nav><a href="../">Asset gallery</a><strong>3D studio</strong></nav>
  <div class="title-row">
    <h1>Image to 3D</h1>
    <span id="runtime">WebGPU · Stable Fast 3D</span>
  </div>

  <section class="workspace" aria-label="Browser 3D generation workspace">
    <article class="panel">
      <div class="panel-header">
        <h2>Source image</h2>
      </div>
      <div class="viewport" id="source-zone">
        <p class="empty" id="source-empty">Choose or drop one isolated object. Transparent PNG works directly; an opaque image with a near-white border uses the same deterministic border matte as the local batch.</p>
        <img id="source-preview" alt="Selected source image" hidden>
      </div>
      <div class="controls">
        <input id="source-image" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose source image">
        <button id="prepare-model" type="button">Prepare model (~${modelGiB} GiB)</button>
        <button id="generate" class="primary" type="button" disabled>Generate GLB</button>
      </div>
    </article>

    <article class="panel">
      <div class="panel-header">
        <h2>Generated mesh</h2>
        <a id="download-glb" class="button-link" hidden>Download GLB</a>
      </div>
      <div class="viewport">
        <p class="empty" id="result-empty">The generated mesh stays in this browser. Prepare the model, choose an image, then generate.</p>
        <model-viewer id="result-viewer" alt="Generated 3D asset" camera-controls auto-rotate shadow-intensity="1" exposure="1" hidden></model-viewer>
      </div>
      <div class="runtime">
        <span id="result-summary"></span>
      </div>
    </article>
  </section>

  <section class="runtime" aria-label="Generation status">
    <progress id="model-progress" max="1" value="0" hidden></progress>
    <p id="status">No model download starts until you choose Prepare model.</p>
  </section>

  <details>
    <summary>Runtime and provenance</summary>
    <dl class="details-grid">
      <dt>Browser backend</dt><dd><code>Stable Fast 3D · ONNX Runtime Web · WebGPU</code></dd>
      <dt>Model repository</dt><dd><code>${escapeHtml(BROWSER_SF3D_MODEL.repository)}</code></dd>
      <dt>Model revision</dt><dd><code>${escapeHtml(BROWSER_SF3D_MODEL.revision)}</code></dd>
      <dt>Model bytes</dt><dd>${BROWSER_SF3D_MODEL.totalBytes.toLocaleString("en-US")} bytes; each artifact is SHA-256 verified before use and again when read from browser cache.</dd>
      <dt>Network boundary</dt><dd>Prepare model acquires model artifacts. Generate performs no model download and sends no source image or mesh to a server.</dd>
      <dt>TRELLIS.2</dt><dd>Local CUDA backend only; it is intentionally not exposed by this static Pages runtime.</dd>
    </dl>
    <p class="license"><strong>Powered by Stability AI.</strong> The browser model artifacts are derivative Stable Fast 3D materials under the Stability AI Community License. <a href="STABILITY_AI_COMMUNITY_LICENSE.md">Read the bundled license</a>. Source-code adaptation notices are in <a href="THIRD_PARTY_NOTICES.md">third-party notices</a>.</p>
    <button id="clear-model-cache" type="button">Clear cached model</button>
  </details>
</main>
<script type="module" src="./app.js"></script>
</body>
</html>
`;
}
