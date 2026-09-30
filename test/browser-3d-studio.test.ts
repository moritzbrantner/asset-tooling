import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BROWSER_ORT_VERSION,
  BROWSER_SF3D_MODEL,
  BROWSER_SF3D_SOURCE,
  BROWSER_THREE_VERSION,
} from "../src/browser/sf3d-model-manifest.js";
import { renderBrowser3DStudioHtml } from "../src/browser-pages-site.js";

test("browser SF3D model is immutable and every runtime artifact is hash-pinned", () => {
  assert.equal(
    BROWSER_SF3D_MODEL.revision,
    "56d2f58d27395b0be9c633671b439b4aac482549",
  );
  assert.equal(
    BROWSER_SF3D_SOURCE.revision,
    "751e6642761466dbf15ed1e4c53ef6ed4db12b40",
  );
  assert.notEqual(BROWSER_SF3D_MODEL.revision, "main");
  const assets = Object.values(BROWSER_SF3D_MODEL.assets);
  assert.equal(
    assets.reduce((total, asset) => total + asset.bytes, 0),
    BROWSER_SF3D_MODEL.totalBytes,
  );
  for (const asset of assets) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.bytes > 0);
    assert.ok(!asset.path.startsWith("/"));
  }
});

test("browser runtime verifies cache hits and fails closed to WebGPU", async () => {
  const source = await readFile(
    new URL("../src/browser/sf3d-webgpu.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /executionProviders:\s*\["webgpu"\]/);
  assert.doesNotMatch(source, /executionProviders:\s*\["webgpu",\s*"wasm"\]/);
  assert.match(source, /verifying cached bytes/);
  assert.match(source, /await verifyAssetBytes\(key, bytes\)/);
  assert.match(source, /await cache\.delete\(url\)/);
  assert.match(source, /BROWSER_SF3D_MODEL\.revision/);
  assert.doesNotMatch(source, /method:\s*["']POST["']/);
});

test("browser studio exposes explicit acquisition before local generation", () => {
  const html = renderBrowser3DStudioHtml();
  assert.match(html, /Prepare model \(~1\.61 GiB\)/);
  assert.match(html, /Generate GLB/);
  assert.match(html, /No model download starts until you choose Prepare model/);
  assert.match(html, /Generate performs no model download and sends no source image or mesh to a server/);
  assert.match(html, /Powered by Stability AI/);
  assert.match(html, /STABILITY_AI_COMMUNITY_LICENSE\.md/);
  assert.match(
    html,
    new RegExp(
      "onnxruntime-web@" + BROWSER_ORT_VERSION.replaceAll(".", "\\.") +
        "/dist/ort\\.webgpu\\.min\\.mjs",
    ),
  );
  assert.match(
    html,
    new RegExp("three@" + BROWSER_THREE_VERSION.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(html, /<option[^>]*trellis/i);
});

test("Pages build emits the browser studio bundle and bundled license evidence", async () => {
  const source = await readFile(
    new URL("../scripts/build-catalog-pages.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /renderBrowser3DStudioHtml/);
  assert.match(source, /Bun\.build/);
  assert.match(source, /STABILITY_AI_COMMUNITY_LICENSE\.md/);
  assert.match(source, /THIRD_PARTY_NOTICES\.md/);
  assert.match(source, /onnxruntime-web/);
  assert.match(source, /three\/examples\/jsm\/exporters\/GLTFExporter\.js/);
});
