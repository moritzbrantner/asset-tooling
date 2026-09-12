import test from "node:test";
import assert from "node:assert/strict";
import { renderCatalogAssetHtml, renderCatalogGalleryHtml } from "../src/catalog-pages-site.js";

function asset(overrides = {}) {
  return {
    id: "example.texture",
    title: "Example Texture",
    kind: "texture",
    mediaType: "image/png",
    provider: {
      id: "shared",
      label: "Shared Provider",
      homepage: "https://example.com/provider",
      distribution: "shared",
    },
    state: "pinned",
    license: {
      spdx: "CC0-1.0",
      attribution: "Example Artist",
      evidenceUrl: "https://example.com/license",
    },
    source: {
      url: "https://example.com/texture.png",
      upstreamId: "texture",
      revision: "abc123",
      path: "texture.png",
      sha256: "a".repeat(64),
      byteLength: 128,
    },
    storage: null,
    tags: ["material", "texture"],
    metadata: { purpose: "Gallery preview fixture" },
    ...overrides,
  };
}

function model(assets = [asset()]) {
  return {
    schemaVersion: 1,
    assets,
    providers: [{ id: "shared", label: "Shared Provider", distribution: "shared" }],
  };
}

test("gallery renders compact linked cards with image thumbnails and no provenance details", () => {
  const html = renderCatalogGalleryHtml(model());
  assert.match(html, /class="asset-card"/);
  assert.match(html, /class="thumbnail image-preview"/);
  assert.match(html, /src="https:\/\/example\.com\/texture\.png"/);
  assert.match(html, /href="assets\/example\.texture\/"/);
  assert.match(html, /View asset/);
  assert.match(html, /Gallery preview fixture/);
  assert.doesNotMatch(html, /SHA-256/);
  assert.doesNotMatch(html, /Source path/);
  assert.doesNotMatch(html, /abc123/);
});

test("gallery renders audio waveforms and lazy 3D model previews", () => {
  const html = renderCatalogGalleryHtml(model([
    asset({
      id: "example.mesh",
      title: "Example Mesh",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      source: { ...asset().source, url: "https://example.com/model.glb" },
    }),
    asset({
      id: "example.audio",
      title: "Example Audio",
      kind: "audio",
      mediaType: "audio/wav",
      source: { ...asset().source, url: "https://example.com/audio.wav" },
    }),
  ]));
  assert.match(html, /<model-viewer src="https:\/\/example\.com\/model\.glb"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /@google\/model-viewer@4\.3\.1\/dist\/model-viewer\.min\.js/);
  assert.match(html, /<canvas class="waveform" data-waveform-src="https:\/\/example\.com\/audio\.wav"/);
  assert.match(html, /new IntersectionObserver/);
  assert.match(html, /decodeAudioData/);
});

test("individual audio pages render waveform plus native playback and hidden provenance details", () => {
  const audio = asset({
    id: "example.audio",
    title: "Example Audio",
    kind: "audio",
    mediaType: "audio/wav",
    source: { ...asset().source, url: "https://example.com/audio.wav" },
    storage: { kind: "git-lfs", path: "assets/canonical/example.audio/audio.wav" },
  });
  const html = renderCatalogAssetHtml(audio);
  assert.match(html, /Asset details/);
  assert.match(html, /SHA-256/);
  assert.match(html, /Source path/);
  assert.match(html, /abc123/);
  assert.match(html, /git-lfs · assets\/canonical\/example\.audio\/audio\.wav/);
  assert.match(html, /<canvas class="waveform" data-waveform-src="https:\/\/example\.com\/audio\.wav"/);
  assert.match(html, /<audio controls preload="none" src="https:\/\/example\.com\/audio\.wav"><\/audio>/);
  assert.match(html, /href="\.\.\/\.\.\/">← Back to gallery<\/a>/);
});

test("individual 3D pages render an interactive pinned model-viewer", () => {
  const mesh = asset({
    id: "example.mesh",
    title: "Example Mesh",
    kind: "mesh",
    mediaType: "model/gltf-binary",
    source: { ...asset().source, url: "https://example.com/model.glb" },
  });
  const html = renderCatalogAssetHtml(mesh);
  assert.match(html, /@google\/model-viewer@4\.3\.1\/dist\/model-viewer\.min\.js/);
  assert.match(html, /<model-viewer src="https:\/\/example\.com\/model\.glb"/);
  assert.match(html, /loading="eager"/);
  assert.match(html, /camera-controls auto-rotate autoplay/);
  assert.match(html, /Drag to orbit · scroll or pinch to zoom/);
});

test("archive assets retain a deterministic fallback visualization", () => {
  const html = renderCatalogGalleryHtml(model([
    asset({
      id: "example.pack",
      title: "Example Pack",
      kind: "asset-pack",
      mediaType: "application/zip",
      source: { ...asset().source, url: "https://example.com/archive.zip" },
    }),
  ]));
  assert.match(html, /preview-archive/);
  assert.match(html, />Asset pack</);
});

test("gallery and asset pages escape catalog strings in HTML attributes and text", () => {
  const hostile = asset({
    id: "example.hostile",
    title: '"><script>alert(1)</script>',
    metadata: { purpose: '<img src=x onerror="alert(2)">' },
  });
  const gallery = renderCatalogGalleryHtml(model([hostile]));
  const detail = renderCatalogAssetHtml(hostile);
  for (const html of [gallery, detail]) {
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(html, /<img src=x onerror=/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }
});
