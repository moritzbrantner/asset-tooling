import { createCatalogPagesModel } from "./catalog-pages.js";

export { createCatalogPagesModel };

const MODEL_VIEWER_MODULE = "https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assetPath(asset) {
  return `assets/${encodeURIComponent(asset.id)}/`;
}

function previewKind(asset) {
  if (asset.mediaType.startsWith("image/") && asset.mediaType !== "image/x-exr") return "image";
  if (asset.mediaType.startsWith("audio/") || asset.kind.includes("audio")) return "audio";
  if (asset.mediaType.startsWith("model/") || asset.kind === "mesh") return "model";
  if (asset.mediaType === "application/zip" || asset.kind.includes("pack")) return "archive";
  return "asset";
}

function iconFor(kind) {
  if (kind === "audio") {
    return `<svg viewBox="0 0 96 64" role="img" aria-label="Audio asset"><path d="M18 36h10l13 11V17L28 28H18z" fill="currentColor"/><path d="M53 26c5 5 5 11 0 16M61 19c9 9 9 23 0 32" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>`;
  }
  if (kind === "model") {
    return `<svg viewBox="0 0 96 64" role="img" aria-label="3D asset"><path d="M48 10 76 25 48 40 20 25zM20 25v20l28 15V40zm56 0v20L48 60V40z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`;
  }
  if (kind === "archive") {
    return `<svg viewBox="0 0 96 64" role="img" aria-label="Asset pack"><rect x="18" y="16" width="60" height="38" rx="5" fill="none" stroke="currentColor" stroke-width="4"/><path d="M28 28h40M28 39h26" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;
  }
  return `<svg viewBox="0 0 96 64" role="img" aria-label="Asset"><path d="M26 18h44v34H26zM34 26h28v18H34z" fill="none" stroke="currentColor" stroke-width="4"/></svg>`;
}

function renderWaveformPreview(asset, { detail }) {
  const className = detail ? "asset-preview audio-preview waveform-preview" : "thumbnail waveform-preview";
  const label = `${asset.title} waveform`;
  const controls = detail
    ? `<audio controls preload="none" src="${escapeHtml(asset.source.url)}"></audio>`
    : "";
  return `<div class="${className}">
    <canvas class="waveform" data-waveform-src="${escapeHtml(asset.source.url)}" role="img" aria-label="${escapeHtml(label)}"></canvas>
    <span class="preview-status" aria-live="polite">Loading waveform…</span>
    ${controls}
  </div>`;
}

function renderModelPreview(asset, { detail }) {
  const className = detail ? "asset-preview model-preview interactive-model" : "thumbnail model-preview";
  const controls = detail ? " camera-controls auto-rotate autoplay" : "";
  const loading = detail ? "eager" : "lazy";
  const hint = detail ? "Drag to orbit · scroll or pinch to zoom" : "Interactive 3D preview";
  return `<div class="${className}">
    <model-viewer src="${escapeHtml(asset.source.url)}" alt="${escapeHtml(asset.title)} 3D preview" loading="${loading}" interaction-prompt="none" shadow-intensity="1" exposure="1"${controls}></model-viewer>
    <span class="preview-status">${hint}</span>
  </div>`;
}

function renderThumbnail(asset, { detail = false } = {}) {
  const kind = previewKind(asset);
  const className = detail ? "asset-preview" : "thumbnail";
  if (kind === "image" && asset.source.url) {
    return `<div class="${className} image-preview"><img src="${escapeHtml(asset.source.url)}" alt="${escapeHtml(asset.title)} preview" loading="lazy"></div>`;
  }
  if (kind === "audio" && asset.source.url) return renderWaveformPreview(asset, { detail });
  if (kind === "model" && asset.source.url) return renderModelPreview(asset, { detail });
  return `<div class="${className} fallback-preview preview-${kind}">${iconFor(kind)}<span>${escapeHtml(kind === "model" ? "3D model" : kind === "archive" ? "Asset pack" : kind)}</span></div>`;
}

function renderTags(tags, limit = tags.length) {
  return tags
    .slice(0, limit)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");
}

function searchableText(asset) {
  return [
    asset.id,
    asset.title,
    asset.kind,
    asset.mediaType,
    asset.provider.label,
    asset.license.spdx,
    asset.license.attribution,
    asset.metadata.purpose,
    ...asset.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function renderCard(asset) {
  const purpose = asset.metadata.purpose
    ? `<p class="purpose">${escapeHtml(asset.metadata.purpose)}</p>`
    : "";
  const tags = asset.tags.length ? `<div class="tags">${renderTags(asset.tags, 4)}</div>` : "";
  return `<article class="asset-card" data-search="${escapeHtml(searchableText(asset))}" data-state="${escapeHtml(asset.state)}" data-kind="${escapeHtml(asset.kind)}" data-provider="${escapeHtml(asset.provider.id)}">
  <a class="thumbnail-link" href="${assetPath(asset)}" aria-label="Open ${escapeHtml(asset.title)}">${renderThumbnail(asset)}</a>
  <div class="card-body">
    <div class="card-heading">
      <div>
        <p class="eyebrow">${escapeHtml(asset.kind)} · ${escapeHtml(asset.provider.label)}</p>
        <h2><a href="${assetPath(asset)}">${escapeHtml(asset.title)}</a></h2>
      </div>
      <span class="state">${escapeHtml(asset.state)}</span>
    </div>
    ${purpose}
    ${tags}
    <a class="details-link" href="${assetPath(asset)}">View asset</a>
  </div>
</article>`;
}

function selectOptions(values) {
  return values.map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
}

function modelViewerModuleScript(enabled) {
  return enabled ? `<script type="module" src="${MODEL_VIEWER_MODULE}"></script>` : "";
}

function waveformRuntimeScript(enabled) {
  if (!enabled) return "";
  return `<script>
(() => {
  const buffers = new Map();
  const rendered = new WeakMap();

  function decoder() {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (Offline) return { context: new Offline(1, 1, 44100), close: false };
    const Realtime = window.AudioContext || window.webkitAudioContext;
    if (!Realtime) throw new Error("Web Audio API unavailable");
    return { context: new Realtime(), close: true };
  }

  function loadBuffer(source) {
    if (!buffers.has(source)) {
      buffers.set(source, (async () => {
        const response = await fetch(source, { mode: "cors" });
        if (!response.ok) throw new Error("Audio preview request failed");
        const bytes = await response.arrayBuffer();
        const { context, close } = decoder();
        try {
          return await context.decodeAudioData(bytes);
        } finally {
          if (close && typeof context.close === "function") context.close().catch(() => {});
        }
      })());
    }
    return buffers.get(source);
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "Waveform";
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const remainder = String(total % 60).padStart(2, "0");
    return minutes + ":" + remainder;
  }

  function draw(canvas, buffer) {
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.floor(width * ratio));
    const pixelHeight = Math.max(1, Math.floor(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = getComputedStyle(canvas).color;
    context.lineWidth = Math.max(1, Math.min(2, width / 320));
    context.globalAlpha = 0.86;

    const bins = Math.max(1, Math.min(720, width));
    const samples = buffer.length;
    const channelCount = buffer.numberOfChannels;
    const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index));
    context.beginPath();
    for (let bin = 0; bin < bins; bin += 1) {
      const start = Math.floor((bin * samples) / bins);
      const end = Math.max(start + 1, Math.floor(((bin + 1) * samples) / bins));
      const stride = Math.max(1, Math.floor((end - start) / 160));
      let minimum = 1;
      let maximum = -1;
      for (const channel of channels) {
        for (let index = start; index < end; index += stride) {
          const sample = channel[index] || 0;
          if (sample < minimum) minimum = sample;
          if (sample > maximum) maximum = sample;
        }
      }
      const x = ((bin + 0.5) / bins) * width;
      const y1 = ((1 - maximum) * height) / 2;
      const y2 = ((1 - minimum) * height) / 2;
      context.moveTo(x, y1);
      context.lineTo(x, y2);
    }
    context.stroke();
    context.globalAlpha = 1;
  }

  async function hydrate(canvas) {
    if (canvas.dataset.waveformState) return;
    canvas.dataset.waveformState = "loading";
    const container = canvas.closest(".waveform-preview");
    const status = container && container.querySelector(".preview-status");
    try {
      const buffer = await loadBuffer(canvas.dataset.waveformSrc);
      rendered.set(canvas, buffer);
      draw(canvas, buffer);
      canvas.dataset.waveformState = "ready";
      if (container) container.dataset.previewState = "ready";
      if (status) status.textContent = formatDuration(buffer.duration);
    } catch {
      canvas.dataset.waveformState = "error";
      if (container) container.dataset.previewState = "error";
      if (status) status.textContent = "Waveform unavailable";
    }
  }

  const canvases = [...document.querySelectorAll("canvas[data-waveform-src]")];
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        hydrate(entry.target);
      }
    }, { rootMargin: "240px" });
    for (const canvas of canvases) observer.observe(canvas);
  } else {
    for (const canvas of canvases) hydrate(canvas);
  }

  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const buffer = rendered.get(entry.target);
        if (buffer) draw(entry.target, buffer);
      }
    });
    for (const canvas of canvases) resizeObserver.observe(canvas);
  }
})();
</script>`;
}

export function renderCatalogGalleryHtml(model) {
  const kinds = [...new Set(model.assets.map((asset) => asset.kind))]
    .sort()
    .map((value) => ({ value, label: value }));
  const providers = model.providers.map((provider) => ({ value: provider.id, label: provider.label }));
  const cards = model.assets.map(renderCard).join("\n");
  const hasAudio = model.assets.some((asset) => previewKind(asset) === "audio" && asset.source.url);
  const hasModel = model.assets.some((asset) => previewKind(asset) === "model" && asset.source.url);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>asset-tooling gallery</title>
  <meta name="description" content="Browse generated and reusable asset-tooling assets as a visual gallery.">
  ${modelViewerModuleScript(hasModel)}
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    a { color: inherit; }
    main { max-width: 1240px; margin: 0 auto; padding: 40px 24px 80px; }
    header { max-width: 760px; margin-bottom: 28px; }
    h1 { margin: 0 0 8px; font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -0.04em; }
    header p { margin: 0; line-height: 1.55; color: color-mix(in srgb, CanvasText 70%, Canvas); }
    .controls { display: grid; grid-template-columns: minmax(240px, 2fr) repeat(3, minmax(140px, 1fr)); gap: 12px; margin: 28px 0 16px; }
    input, select { width: 100%; padding: 11px 12px; border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 10px; background: Canvas; color: CanvasText; font: inherit; }
    #summary { margin: 0 0 18px; color: color-mix(in srgb, CanvasText 64%, Canvas); }
    #results { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; }
    .asset-card { min-width: 0; overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 16px; background: color-mix(in srgb, CanvasText 2%, Canvas); }
    .thumbnail-link { display: block; text-decoration: none; }
    .thumbnail { position: relative; aspect-ratio: 4 / 3; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); background: color-mix(in srgb, CanvasText 5%, Canvas); overflow: hidden; }
    .image-preview { display: grid; place-items: center; overflow: hidden; }
    .image-preview img { width: 100%; height: 100%; object-fit: cover; }
    .waveform-preview { color: color-mix(in srgb, CanvasText 74%, Canvas); background: linear-gradient(180deg, color-mix(in srgb, CanvasText 3%, Canvas), color-mix(in srgb, CanvasText 7%, Canvas)); }
    .waveform { display: block; width: 100%; height: 100%; min-height: 120px; }
    .waveform-preview .preview-status, .model-preview .preview-status { position: absolute; left: 10px; bottom: 9px; padding: 3px 7px; border-radius: 999px; background: color-mix(in srgb, Canvas 82%, transparent); color: color-mix(in srgb, CanvasText 72%, Canvas); font-size: .7rem; line-height: 1.2; }
    .model-preview model-viewer { width: 100%; height: 100%; background: radial-gradient(circle at 50% 44%, color-mix(in srgb, CanvasText 8%, Canvas), color-mix(in srgb, CanvasText 3%, Canvas)); pointer-events: none; }
    .fallback-preview { display: grid; place-items: center; align-content: center; gap: 10px; color: color-mix(in srgb, CanvasText 68%, Canvas); }
    .fallback-preview svg { width: 78px; height: 56px; }
    .fallback-preview span { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
    .card-body { padding: 16px; }
    .card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .eyebrow { margin: 0 0 5px; color: color-mix(in srgb, CanvasText 58%, Canvas); font-size: .76rem; text-transform: uppercase; letter-spacing: .06em; }
    h2 { margin: 0; font-size: 1.1rem; line-height: 1.25; }
    h2 a { text-decoration: none; }
    h2 a:hover, .details-link:hover { text-decoration: underline; }
    .state { flex: 0 0 auto; padding: 3px 7px; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 999px; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
    .purpose { margin: 10px 0 0; color: color-mix(in srgb, CanvasText 74%, Canvas); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .tag { padding: 3px 7px; border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); border-radius: 999px; font-size: .72rem; }
    .details-link { display: inline-block; margin-top: 15px; font-size: .9rem; font-weight: 650; }
    .empty { grid-column: 1 / -1; padding: 32px 0; color: color-mix(in srgb, CanvasText 62%, Canvas); }
    [hidden] { display: none !important; }
    @media (max-width: 760px) { .controls { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 480px) { main { padding-inline: 16px; } .controls { grid-template-columns: 1fr; } #results { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Asset gallery</h1>
    <p>Browse assets visually first. Provenance, hashes, license evidence, source paths, and storage details are kept on each asset's individual page.</p>
  </header>
  <section class="controls" aria-label="Asset filters">
    <input id="search" type="search" placeholder="Search assets…" aria-label="Search assets">
    <select id="state" aria-label="Filter by state"><option value="">All states</option>${selectOptions(["candidate", "pinned", "canonical"].map((value) => ({ value, label: value })))}</select>
    <select id="kind" aria-label="Filter by kind"><option value="">All kinds</option>${selectOptions(kinds)}</select>
    <select id="provider" aria-label="Filter by provider"><option value="">All providers</option>${selectOptions(providers)}</select>
  </section>
  <p id="summary" aria-live="polite"></p>
  <section id="results" aria-label="Asset gallery">${cards}</section>
</main>
${waveformRuntimeScript(hasAudio)}
<script>
const controls = ["search", "state", "kind", "provider"].map((id) => document.getElementById(id));
const [search, state, kind, provider] = controls;
const cards = [...document.querySelectorAll(".asset-card")];
const summary = document.getElementById("summary");
function render() {
  const query = search.value.trim().toLowerCase();
  let visible = 0;
  for (const card of cards) {
    const show = (!query || card.dataset.search.includes(query)) &&
      (!state.value || card.dataset.state === state.value) &&
      (!kind.value || card.dataset.kind === kind.value) &&
      (!provider.value || card.dataset.provider === provider.value);
    card.hidden = !show;
    if (show) visible += 1;
  }
  summary.textContent = visible + (visible === 1 ? " asset" : " assets") + " shown";
  let empty = document.getElementById("empty");
  if (!visible && !empty) {
    empty = document.createElement("p");
    empty.id = "empty";
    empty.className = "empty";
    empty.textContent = "No assets match these filters.";
    document.getElementById("results").append(empty);
  } else if (empty) {
    empty.remove();
  }
}
for (const control of controls) control.addEventListener("input", render);
render();
</script>
</body>
</html>
`;
}

function detailRow(name, value, { code = false, href = null } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const rendered = href
    ? `<a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(value)}</a>`
    : code
      ? `<code>${escapeHtml(value)}</code>`
      : escapeHtml(value);
  return `<dt>${escapeHtml(name)}</dt><dd>${rendered}</dd>`;
}

export function renderCatalogAssetHtml(asset) {
  const details = [
    detailRow("Asset id", asset.id, { code: true }),
    detailRow("Kind", asset.kind),
    detailRow("Media type", asset.mediaType, { code: true }),
    detailRow("State", asset.state),
    detailRow("Provider", `${asset.provider.label} · ${asset.provider.distribution}`),
    detailRow("License", asset.license.spdx, { code: true }),
    detailRow("Attribution", asset.license.attribution),
    detailRow("Purpose", asset.metadata.purpose),
    detailRow("Revision", asset.source.revision, { code: true }),
    detailRow("Source path", asset.source.path, { code: true }),
    detailRow("SHA-256", asset.source.sha256, { code: true }),
    detailRow("Byte length", asset.source.byteLength, { code: true }),
    asset.storage ? detailRow("Canonical storage", `${asset.storage.kind} · ${asset.storage.path}`, { code: true }) : "",
    detailRow("Source", "Open source asset", { href: asset.source.url }),
    detailRow("License evidence", "Open license evidence", { href: asset.license.evidenceUrl }),
    detailRow("Provider", "Open provider", { href: asset.provider.homepage }),
  ].join("");
  const tags = asset.tags.length ? `<div class="tags">${renderTags(asset.tags)}</div>` : "";
  const kind = previewKind(asset);
  const hasAudio = kind === "audio" && Boolean(asset.source.url);
  const hasModel = kind === "model" && Boolean(asset.source.url);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(asset.title)} · asset-tooling</title>
  <meta name="description" content="Preview and provenance details for ${escapeHtml(asset.title)}.">
  ${modelViewerModuleScript(hasModel)}
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 920px; margin: 0 auto; padding: 36px 24px 80px; }
    a { color: LinkText; }
    .back { display: inline-block; margin-bottom: 28px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(260px, .8fr); gap: 28px; align-items: start; }
    h1 { margin: 0 0 6px; font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -0.035em; }
    .id { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: color-mix(in srgb, CanvasText 58%, Canvas); overflow-wrap: anywhere; }
    .asset-preview { position: relative; aspect-ratio: 4 / 3; border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 16px; overflow: hidden; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    .image-preview { display: grid; place-items: center; }
    .image-preview img { width: 100%; height: 100%; object-fit: contain; }
    .fallback-preview { display: grid; place-items: center; align-content: center; gap: 12px; color: color-mix(in srgb, CanvasText 68%, Canvas); }
    .fallback-preview svg { width: 108px; height: 74px; }
    .fallback-preview span { font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
    .waveform-preview { display: grid; grid-template-rows: minmax(0, 1fr) auto; padding: 18px; gap: 12px; color: color-mix(in srgb, CanvasText 78%, Canvas); background: linear-gradient(180deg, color-mix(in srgb, CanvasText 3%, Canvas), color-mix(in srgb, CanvasText 7%, Canvas)); }
    .waveform-preview .waveform { display: block; width: 100%; height: 100%; min-height: 150px; }
    .waveform-preview audio { width: 100%; }
    .waveform-preview .preview-status { position: absolute; top: 14px; right: 14px; padding: 3px 7px; border-radius: 999px; background: color-mix(in srgb, Canvas 82%, transparent); color: color-mix(in srgb, CanvasText 68%, Canvas); font-size: .72rem; }
    .model-preview model-viewer { width: 100%; height: 100%; background: radial-gradient(circle at 50% 44%, color-mix(in srgb, CanvasText 8%, Canvas), color-mix(in srgb, CanvasText 3%, Canvas)); }
    .model-preview .preview-status { position: absolute; left: 14px; bottom: 12px; z-index: 2; padding: 4px 8px; border-radius: 999px; background: color-mix(in srgb, Canvas 82%, transparent); color: color-mix(in srgb, CanvasText 72%, Canvas); font-size: .72rem; pointer-events: none; }
    .state { display: inline-block; margin-top: 16px; padding: 4px 8px; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 999px; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
    .details { margin-top: 34px; padding-top: 26px; border-top: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); }
    h2 { margin: 0 0 18px; font-size: 1.15rem; }
    dl { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 9px 18px; margin: 0; }
    dt { color: color-mix(in srgb, CanvasText 58%, Canvas); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
    .tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 18px; }
    .tag { padding: 3px 8px; border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 999px; font-size: .76rem; }
    @media (max-width: 720px) { .hero { grid-template-columns: 1fr; } dl { grid-template-columns: 120px minmax(0, 1fr); } }
    @media (max-width: 480px) { main { padding-inline: 16px; } dl { grid-template-columns: 1fr; gap: 3px; } dd { margin-bottom: 10px; } }
  </style>
</head>
<body>
<main>
  <a class="back" href="../../">← Back to gallery</a>
  <section class="hero">
    ${renderThumbnail(asset, { detail: true })}
    <div>
      <h1>${escapeHtml(asset.title)}</h1>
      <p class="id">${escapeHtml(asset.id)}</p>
      <span class="state">${escapeHtml(asset.state)}</span>
      ${tags}
    </div>
  </section>
  <section class="details" aria-labelledby="details-heading">
    <h2 id="details-heading">Asset details</h2>
    <dl>${details}</dl>
  </section>
</main>
${waveformRuntimeScript(hasAudio)}
</body>
</html>
`;
}
