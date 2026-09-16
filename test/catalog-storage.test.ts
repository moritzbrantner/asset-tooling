import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { sha256Bytes } from "../src/hash.js";
import { createAssetCatalog } from "../src/catalog.js";
import {
  canonicalAssetStoragePath,
  createAssetCatalogStorageEntry,
  createAssetCatalogStorageManifest,
  importAssetCatalogStorageSource,
  readAssetCatalogStorageSource,
  resolveAssetCatalogStorageEntry,
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
const STORAGE = {
  schemaVersion: 1,
  entries: [
    {
      schemaVersion: 1,
      sourceId: SOURCE.id,
      storage: "git-lfs",
      path: "assets/canonical/example.model/model.glb",
    },
  ],
};

function catalogFor(source = SOURCE, provider = PROVIDER) {
  return createAssetCatalog({ providers: [provider], sources: [source] });
}

async function writeStoredBytes(root, bytes = BYTES) {
  const assetPath = path.join(root, ...STORAGE.entries[0].path.split("/"));
  await mkdir(path.dirname(assetPath), { recursive: true });
  await writeFile(assetPath, bytes);
  return assetPath;
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

test("durable storage entries resolve only through the validated manifest", () => {
  const catalog = catalogFor();
  assert.equal(resolveAssetCatalogStorageEntry(catalog, STORAGE, SOURCE.id).path, STORAGE.entries[0].path);
  assert.throws(
    () => resolveAssetCatalogStorageEntry(catalog, { schemaVersion: 1, entries: [] }, SOURCE.id),
    /is not present in durable storage/,
  );
});

test("consumer reads hydrated Git LFS bytes and verifies the catalog pin", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-read-test-"));
  try {
    await writeStoredBytes(storageRoot);
    const stored = await readAssetCatalogStorageSource({
      catalog: catalogFor(),
      storage: STORAGE,
      sourceId: SOURCE.id,
      storageRoot,
    });
    assert.equal(stored.entry.path, STORAGE.entries[0].path);
    assert.equal(stored.source.id, SOURCE.id);
    assert.deepEqual(stored.bytes, BYTES);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("consumer refuses a pointer-only Git LFS checkout", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-pointer-test-"));
  const pointer = Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${SOURCE.source.sha256}\nsize ${SOURCE.source.byteLength}\n`,
    "utf8",
  );
  try {
    await writeStoredBytes(storageRoot, pointer);
    await assert.rejects(
      readAssetCatalogStorageSource({
        catalog: catalogFor(),
        storage: STORAGE,
        sourceId: SOURCE.id,
        storageRoot,
      }),
      /is not hydrated; Git LFS pointer found/,
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("consumer import bridges durable LFS bytes into the disposable object store idempotently", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-source-test-"));
  const objectStoreRoot = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-object-test-"));
  try {
    await writeStoredBytes(storageRoot);
    const options = {
      catalog: catalogFor(),
      storage: STORAGE,
      sourceId: SOURCE.id,
      storageRoot,
      objectStoreRoot,
    };
    const first = await importAssetCatalogStorageSource(options);
    const second = await importAssetCatalogStorageSource(options);

    assert.equal(first.status, "changed");
    assert.equal(second.status, "unchanged");
    assert.deepEqual(second.asset, first.asset);
    assert.equal(first.asset.sha256, SOURCE.source.sha256);
    assert.equal(first.asset.byteLength, SOURCE.source.byteLength);
    assert.equal(first.asset.metadata.catalog.id, SOURCE.id);
    assert.equal(first.asset.metadata.catalog.license.spdx, SOURCE.license.spdx);

    const objectPath = path.join(
      objectStoreRoot,
      ".asset-tooling",
      "objects",
      "v1",
      "sha256",
      SOURCE.source.sha256.slice(0, 2),
      SOURCE.source.sha256,
    );
    assert.deepEqual(await readFile(objectPath), BYTES);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
    await rm(objectStoreRoot, { recursive: true, force: true });
  }
});

test("consumer import fails closed when durable bytes are missing or drifted", async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-missing-test-"));
  try {
    await assert.rejects(
      readAssetCatalogStorageSource({
        catalog: catalogFor(),
        storage: STORAGE,
        sourceId: SOURCE.id,
        storageRoot,
      }),
      /is missing from durable storage/,
    );

    await writeStoredBytes(storageRoot, Buffer.from("drift", "utf8"));
    await assert.rejects(
      readAssetCatalogStorageSource({
        catalog: catalogFor(),
        storage: STORAGE,
        sourceId: SOURCE.id,
        storageRoot,
      }),
      /hash mismatch/,
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});
