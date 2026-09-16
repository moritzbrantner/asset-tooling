import { createAssetCatalog } from "./catalog.js";
import { createAssetCatalogStorageManifest } from "./catalog-storage.js";

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function providerMap(document) {
  plainObject(document, "providers document");
  if (document.schemaVersion !== 1 || !Array.isArray(document.providers)) {
    throw new Error("providers document must be schemaVersion 1 with a providers array");
  }
  return new Map(document.providers.map((provider) => [provider.id, provider]));
}

function storageMap(document) {
  plainObject(document, "storage document");
  if (document.schemaVersion !== 1 || !Array.isArray(document.entries)) {
    throw new Error("storage document must be schemaVersion 1 with an entries array");
  }
  return new Map(document.entries.map((entry) => [entry.sourceId, entry]));
}

function sourceState(source, storage) {
  if (storage) return "canonical";
  if (source.source?.sha256 && Number.isSafeInteger(source.source?.byteLength)) return "pinned";
  return "candidate";
}

function normalizedMetadata(metadata) {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
  return JSON.parse(JSON.stringify(metadata));
}

export function createCatalogPagesModel({ providers, sources, storage }) {
  const providersById = providerMap(providers);
  const storageById = storageMap(storage);
  plainObject(sources, "sources document");
  if (sources.schemaVersion !== 1 || !Array.isArray(sources.sources)) {
    throw new Error("sources document must be schemaVersion 1 with a sources array");
  }

  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  createAssetCatalogStorageManifest({ catalog, entries: storage.entries });

  const assets = sources.sources.map((source) => {
    const provider = providersById.get(source.provider);
    if (!provider) throw new Error(`catalog source '${source.id}' references unknown provider '${source.provider}'`);
    const durable = storageById.get(source.id) ?? null;
    return {
      id: source.id,
      title: source.title,
      kind: source.kind,
      mediaType: source.mediaType,
      provider: {
        id: provider.id,
        label: provider.label,
        homepage: provider.homepage,
        distribution: provider.distribution,
      },
      state: sourceState(source, durable),
      license: {
        spdx: source.license?.spdx ?? null,
        attribution: source.license?.attribution ?? null,
        evidenceUrl: source.license?.evidenceUrl ?? null,
      },
      source: {
        url: source.source?.url ?? null,
        upstreamId: source.source?.upstreamId ?? null,
        revision: source.source?.revision ?? null,
        path: source.source?.path ?? null,
        sha256: source.source?.sha256 ?? null,
        byteLength: source.source?.byteLength ?? null,
      },
      storage: durable ? { kind: durable.storage, path: durable.path } : null,
      tags: Array.isArray(source.tags) ? [...source.tags].sort(compareText) : [],
      metadata: normalizedMetadata(source.metadata),
    };
  });
  assets.sort((left, right) => compareText(left.id, right.id));

  return {
    schemaVersion: 1,
    assets,
    providers: [...providersById.values()]
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        distribution: provider.distribution,
      }))
      .sort((left, right) => compareText(left.id, right.id)),
  };
}

function safeEmbeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

export function renderCatalogPagesHtml(model) {
  const data = safeEmbeddedJson(model);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>asset-tooling catalog</title>
  <meta name="description" content="Browse the asset-tooling canonical source catalog and provenance evidence.">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 1100px; margin: 0 auto; padding: 40px 24px 80px; }
    header { margin-bottom: 32px; }
    h1 { margin: 0 0 8px; font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -0.04em; }
    header p { max-width: 760px; margin: 0; line-height: 1.55; color: color-mix(in srgb, CanvasText 72%, Canvas); }
    .controls { display: grid; grid-template-columns: minmax(220px, 2fr) repeat(3, minmax(140px, 1fr)); gap: 12px; margin: 28px 0 20px; }
    input, select { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 8px; background: Canvas; color: CanvasText; font: inherit; }
    #summary { margin: 0 0 14px; color: color-mix(in srgb, CanvasText 68%, Canvas); }
    #results { border-top: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); }
    article { padding: 22px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); }
    .asset-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h2 { margin: 0; font-size: 1.18rem; }
    .id { margin: 4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; color: color-mix(in srgb, CanvasText 62%, Canvas); overflow-wrap: anywhere; }
    .state { font-size: .78rem; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; }
    dl { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 7px 14px; margin: 16px 0 0; }
    dt { color: color-mix(in srgb, CanvasText 62%, Canvas); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; overflow-wrap: anywhere; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
    .tag { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 999px; padding: 3px 8px; font-size: .78rem; }
    .preview { margin-top: 16px; max-width: 480px; }
    .preview img { display: block; max-width: 100%; max-height: 300px; object-fit: contain; }
    .preview audio { width: 100%; }
    a { color: LinkText; }
    .empty { padding: 32px 0; color: color-mix(in srgb, CanvasText 62%, Canvas); }
    @media (max-width: 760px) { .controls { grid-template-columns: 1fr 1fr; } dl { grid-template-columns: 110px minmax(0, 1fr); } }
    @media (max-width: 480px) { .controls { grid-template-columns: 1fr; } .asset-head { display: block; } .state { display: inline-block; margin-top: 8px; } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Asset catalog</h1>
    <p>Browse reusable source assets by exact provenance. Candidate, pinned, and canonical storage state comes directly from the checked-in catalog manifests; this page never treats a preview or Git LFS pointer as content evidence.</p>
  </header>
  <section class="controls" aria-label="Catalog filters">
    <input id="search" type="search" placeholder="Search title, id, tag, purpose…" aria-label="Search catalog">
    <select id="state" aria-label="Filter by state"><option value="">All states</option></select>
    <select id="kind" aria-label="Filter by kind"><option value="">All kinds</option></select>
    <select id="provider" aria-label="Filter by provider"><option value="">All providers</option></select>
  </section>
  <p id="summary" aria-live="polite"></p>
  <section id="results" aria-label="Catalog assets"></section>
</main>
<script>
const DATA = ${data};
const byId = (id) => document.getElementById(id);
const controls = { search: byId("search"), state: byId("state"), kind: byId("kind"), provider: byId("provider") };
const results = byId("results");
const summary = byId("summary");

function addOptions(select, values) {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value.value;
    option.textContent = value.label;
    select.append(option);
  }
}

addOptions(controls.state, ["candidate", "pinned", "canonical"].map((value) => ({ value, label: value })));
addOptions(controls.kind, [...new Set(DATA.assets.map((asset) => asset.kind))].sort().map((value) => ({ value, label: value })));
addOptions(controls.provider, DATA.providers.map((provider) => ({ value: provider.id, label: provider.label })));

function text(parent, name, value, code) {
  if (value === null || value === undefined || value === "") return;
  const dt = document.createElement("dt");
  dt.textContent = name;
  const dd = document.createElement("dd");
  const node = code ? document.createElement("code") : document.createElement("span");
  node.textContent = String(value);
  dd.append(node);
  parent.append(dt, dd);
}

function link(parent, name, href, label) {
  if (!href) return;
  const dt = document.createElement("dt");
  dt.textContent = name;
  const dd = document.createElement("dd");
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.rel = "noreferrer";
  anchor.textContent = label || href;
  dd.append(anchor);
  parent.append(dt, dd);
}

function previewFor(asset) {
  if (!asset.source.url || !asset.source.sha256) return null;
  const container = document.createElement("div");
  container.className = "preview";
  if (asset.mediaType.startsWith("image/") && asset.mediaType !== "image/x-exr") {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = asset.title + " preview from pinned upstream source";
    image.src = asset.source.url;
    container.append(image);
    return container;
  }
  if (asset.mediaType.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = asset.source.url;
    container.append(audio);
    return container;
  }
  return null;
}

function renderAsset(asset) {
  const article = document.createElement("article");
  const head = document.createElement("div");
  head.className = "asset-head";
  const title = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = asset.title;
  const id = document.createElement("p");
  id.className = "id";
  id.textContent = asset.id;
  title.append(h2, id);
  const state = document.createElement("span");
  state.className = "state";
  state.textContent = asset.state;
  head.append(title, state);
  article.append(head);

  const details = document.createElement("dl");
  text(details, "Kind", asset.kind);
  text(details, "Media type", asset.mediaType, true);
  text(details, "Provider", asset.provider.label + " · " + asset.provider.distribution);
  text(details, "License", asset.license.spdx, true);
  text(details, "Attribution", asset.license.attribution);
  text(details, "Revision", asset.source.revision, true);
  text(details, "Source path", asset.source.path, true);
  text(details, "SHA-256", asset.source.sha256, true);
  text(details, "Byte length", asset.source.byteLength, true);
  if (asset.storage) text(details, "Canonical storage", asset.storage.kind + " · " + asset.storage.path, true);
  if (asset.metadata.purpose) text(details, "Purpose", asset.metadata.purpose);
  link(details, "Source", asset.source.url, "Open pinned/source URL");
  link(details, "License evidence", asset.license.evidenceUrl, "Open license evidence");
  link(details, "Provider", asset.provider.homepage, "Open provider");
  article.append(details);

  if (asset.tags.length) {
    const tags = document.createElement("div");
    tags.className = "tags";
    for (const value of asset.tags) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = value;
      tags.append(tag);
    }
    article.append(tags);
  }
  const preview = previewFor(asset);
  if (preview) article.append(preview);
  return article;
}

function searchable(asset) {
  return [asset.id, asset.title, asset.kind, asset.mediaType, asset.provider.label, asset.license.spdx, asset.license.attribution, asset.metadata.purpose, ...asset.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function render() {
  const query = controls.search.value.trim().toLowerCase();
  const filtered = DATA.assets.filter((asset) =>
    (!query || searchable(asset).includes(query)) &&
    (!controls.state.value || asset.state === controls.state.value) &&
    (!controls.kind.value || asset.kind === controls.kind.value) &&
    (!controls.provider.value || asset.provider.id === controls.provider.value)
  );
  results.replaceChildren();
  summary.textContent = filtered.length + (filtered.length === 1 ? " asset" : " assets") + " shown";
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No catalog assets match these filters.";
    results.append(empty);
    return;
  }
  for (const asset of filtered) results.append(renderAsset(asset));
}

for (const control of Object.values(controls)) control.addEventListener("input", render);
render();
</script>
</body>
</html>
`;
}
