import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { acquireAssetCatalogSource } from "../src/catalog-acquisition.js";
import { createAssetCatalog } from "../src/catalog.js";

const SHARED_PROVIDER = {
  schemaVersion: 1,
  id: "example-shared",
  label: "Example Shared",
  homepage: "https://example.com/assets",
  distribution: "shared",
  acceptedLicenses: ["CC0-1.0"],
};

const SOURCE = {
  schemaVersion: 1,
  id: "example.pack",
  provider: "example-shared",
  title: "Example pack",
  kind: "asset-pack",
  mediaType: "application/zip",
  source: {
    url: "https://example.com/assets/example.zip",
    upstreamId: "example",
    revision: "v1",
    path: "example.zip",
  },
  license: {
    spdx: "CC0-1.0",
    evidenceUrl: "https://example.com/assets/example/license",
  },
  tags: ["testing"],
};

function catalogFor(provider = SHARED_PROVIDER, source = SOURCE) {
  return createAssetCatalog({ providers: [provider], sources: [source] });
}

test("acquisition writes exact bytes and pin evidence without importing them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-acquire-test-"));
  const bytes = Buffer.from("external archive bytes", "utf8");
  const requests = [];
  try {
    const result = await acquireAssetCatalogSource({
      catalog: catalogFor(),
      sourceId: SOURCE.id,
      destinationRoot: root,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(bytes, { status: 200 });
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, SOURCE.source.url);
    assert.equal(requests[0].options.redirect, "follow");
    assert.deepEqual(await readFile(result.filePath), bytes);

    const pin = JSON.parse(await readFile(result.pinPath, "utf8"));
    assert.equal(pin.id, SOURCE.id);
    assert.equal(pin.source.byteLength, bytes.byteLength);
    assert.equal(pin.source.sha256, result.sha256);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition fails closed on HTTP errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-acquire-http-test-"));
  try {
    await assert.rejects(
      acquireAssetCatalogSource({
        catalog: catalogFor(),
        sourceId: SOURCE.id,
        destinationRoot: root,
        fetchImpl: async () => new Response("missing", { status: 404 }),
      }),
      /failed to acquire catalog source 'example.pack' \(404\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition refuses project-local providers", async () => {
  const provider = { ...SHARED_PROVIDER, id: "example-local", distribution: "project-local" };
  const source = { ...SOURCE, id: "example.local", provider: provider.id };
  await assert.rejects(
    acquireAssetCatalogSource({
      catalog: catalogFor(provider, source),
      sourceId: source.id,
      destinationRoot: ".ignored",
      fetchImpl: async () => {
        throw new Error("fetch must not be reached");
      },
    }),
    /cannot be acquired as shared evidence/,
  );
});

test("acquisition re-verifies already pinned sources", async () => {
  const pinned = {
    ...SOURCE,
    source: {
      ...SOURCE.source,
      sha256: "0".repeat(64),
      byteLength: 1,
    },
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-acquire-pin-test-"));
  try {
    await assert.rejects(
      acquireAssetCatalogSource({
        catalog: catalogFor(SHARED_PROVIDER, pinned),
        sourceId: pinned.id,
        destinationRoot: root,
        fetchImpl: async () => new Response(Buffer.from("different bytes"), { status: 200 }),
      }),
      /hash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
