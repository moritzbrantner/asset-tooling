import test from "node:test";
import assert from "node:assert/strict";
import { sha256Bytes } from "../src/hash.js";
import { createAssetCatalog } from "../src/catalog.js";
import {
  canonicalAssetStoragePath,
  createAssetCatalogStorageEntry,
  createAssetCatalogStorageManifest,
  verifyAssetCatalogStorageBytes,
} from "../src/catalog-storage.js";

const BYTES = Buffer.from("canonical binary asset", "utf8");
const PROVIDER = {
  schemaVersion: 1,
  id: "example-shared",
  label: "Example Shared",
  homepage: "https://example.com/assets",
  distribution: "shared",
  acceptedLicenses: ["CC0-1.0"],
};
const SOURCE = {
  schemaVersion: 1,
  id: "example.model",
  provider: PROVIDER.id,
  title: "Example Model",
  kind: "mesh",
  mediaType: "model/gltf-binary",
  source: {
    url: "https://example.com/assets/model.glb",
    path: "downloads/model.glb",
    sha256: sha256Bytes(BYTES),
    byteLength: BYTES.byteLength,
  },
  license: {
    spdx: "CC0-1.0",
    evidenceUrl: "https://example.com/assets/license",
  },
  tags: ["testing"],
};

function catalogFor(source = SOURCE, provider = PROVIDER) {
  return createAssetCatalog({ providers: [provider], sources: [source] });
}

test("canonical storage path is derived from source identity and file name", () => {
  assert.equal(
    canonicalAssetStoragePath(SOURCE),
    "assets/canonical/example.model/model.glb",
  );
});

test("storage manifest accepts only pinned shared catalog sources at their canonical paths", () => {
  const catalog = catalogFor();
  const entry = createAssetCatalogStorageEntry(catalog, {
    schemaVersion: 1,
    sourceId: SOURCE.id,
    storage: "git-lfs",
    path: canonicalAssetStoragePath(SOURCE),
  });
  assert.deepEqual(entry, {
    schemaVersion: 1,
    sourceId: SOURCE.id,
    storage: "git-lfs",
    path: "assets/canonical/example.model/model.glb",
  });

  assert.throws(
    () => createAssetCatalogStorageEntry(catalog, { ...entry, path: "assets/model.glb" }),
    /path must be 'assets\/canonical\/example.model\/model.glb'/,
  );
});

test("storage manifest rejects unpinned and project-local sources", () => {
  const unpinned = {
    ...SOURCE,
    source: {
      url: SOURCE.source.url,
      path: SOURCE.source.path,
    },
  };
  assert.throws(
    () =>
      createAssetCatalogStorageEntry(catalogFor(unpinned), {
        sourceId: unpinned.id,
        storage: "git-lfs",
        path: canonicalAssetStoragePath(unpinned),
      }),
    /must be content-pinned before canonical import/,
  );

  const localProvider = { ...PROVIDER, distribution: "project-local" };
  assert.throws(
    () =>
      createAssetCatalogStorageEntry(catalogFor(SOURCE, localProvider), {
        sourceId: SOURCE.id,
        storage: "git-lfs",
        path: canonicalAssetStoragePath(SOURCE),
      }),
    /cannot enter the shared canonical store/,
  );
});

test("storage manifests reject duplicate source ids and verify hydrated bytes", () => {
  const catalog = catalogFor();
  const entry = {
    sourceId: SOURCE.id,
    storage: "git-lfs",
    path: canonicalAssetStoragePath(SOURCE),
  };
  assert.throws(
    () => createAssetCatalogStorageManifest({ catalog, entries: [entry, entry] }),
    /must not duplicate source ids/,
  );

  assert.equal(verifyAssetCatalogStorageBytes(catalog, entry, BYTES).sourceId, SOURCE.id);
  assert.throws(
    () => verifyAssetCatalogStorageBytes(catalog, entry, Buffer.from("drift", "utf8")),
    /hash mismatch/,
  );
});
