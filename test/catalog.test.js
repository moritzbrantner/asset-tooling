import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  assertAssetCatalogSourceReusable,
  createAssetCatalog,
  createAssetCatalogProvider,
  createAssetCatalogSource,
  importAssetCatalogSource,
  inspectAssetCatalogSourceBytes,
  isAssetCatalogSourcePinned,
} from "../src/catalog.js";

const SHARED_PROVIDER = {
  schemaVersion: 1,
  id: "example-shared",
  label: "Example Shared",
  homepage: "https://example.com/assets",
  distribution: "shared",
  acceptedLicenses: ["CC-BY-4.0", "CC0-1.0"],
};

const SOURCE = {
  schemaVersion: 1,
  id: "example.mesh",
  provider: "example-shared",
  title: "Example mesh",
  kind: "mesh",
  mediaType: "model/gltf-binary",
  source: {
    url: "https://example.com/assets/example.glb",
    upstreamId: "example",
    revision: "v1",
  },
  license: {
    spdx: "CC0-1.0",
    evidenceUrl: "https://example.com/assets/example/license",
  },
  tags: ["testing", "basic"],
};

test("catalog providers and sources normalize deterministically", () => {
  const provider = createAssetCatalogProvider(SHARED_PROVIDER);
  assert.deepEqual(provider.acceptedLicenses, ["CC-BY-4.0", "CC0-1.0"]);

  const source = createAssetCatalogSource(SOURCE);
  assert.deepEqual(source.tags, ["basic", "testing"]);
  assert.equal(isAssetCatalogSourcePinned(source), false);
  assert.throws(
    () => createAssetCatalogSource({ ...SOURCE, source: { ...SOURCE.source, sha256: "a".repeat(64) } }),
    /sha256 and byteLength must be declared together/,
  );
  assert.throws(
    () => createAssetCatalogSource({
      ...SOURCE,
      license: { spdx: "CC-BY-4.0", evidenceUrl: "https://example.com/license" },
    }),
    /explicit attribution text/,
  );
});

test("catalog rejects unknown providers and duplicate ids", () => {
  assert.throws(
    () => createAssetCatalog({ providers: [SHARED_PROVIDER], sources: [{ ...SOURCE, provider: "missing" }] }),
    /unknown provider/,
  );
  assert.throws(
    () => createAssetCatalog({ providers: [SHARED_PROVIDER, SHARED_PROVIDER], sources: [] }),
    /already registered/,
  );
});

test("inspection pins exact source bytes and fails closed on later drift", () => {
  const bytes = Buffer.from("canonical mesh bytes", "utf8");
  const pinned = inspectAssetCatalogSourceBytes(SOURCE, bytes);
  assert.equal(isAssetCatalogSourcePinned(pinned), true);
  assert.equal(pinned.source.byteLength, bytes.byteLength);
  assert.match(pinned.source.sha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () => inspectAssetCatalogSourceBytes(pinned, Buffer.from("different bytes", "utf8")),
    /hash mismatch/,
  );
});

test("canonical import is idempotent and refuses unpinned or project-local sources", async () => {
  const bytes = Buffer.from("canonical mesh bytes", "utf8");
  const pinned = inspectAssetCatalogSourceBytes(SOURCE, bytes);
  const catalog = createAssetCatalog({ providers: [SHARED_PROVIDER], sources: [pinned] });
  assert.equal(assertAssetCatalogSourceReusable(catalog, pinned.id).id, pinned.id);

  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-catalog-test-"));
  try {
    const first = await importAssetCatalogSource(root, catalog, pinned.id, bytes);
    const second = await importAssetCatalogSource(root, catalog, pinned.id, bytes);
    assert.equal(first.status, "changed");
    assert.equal(second.status, "unchanged");
    assert.deepEqual(first.asset, second.asset);
    assert.equal(first.asset.metadata.catalog.license.spdx, "CC0-1.0");
    assert.equal(first.asset.metadata.catalog.source.sha256, pinned.source.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const candidateCatalog = createAssetCatalog({ providers: [SHARED_PROVIDER], sources: [SOURCE] });
  assert.throws(
    () => assertAssetCatalogSourceReusable(candidateCatalog, SOURCE.id),
    /content-pinned/,
  );

  const localProvider = { ...SHARED_PROVIDER, id: "example-local", distribution: "project-local" };
  const localSource = { ...pinned, id: "example.local", provider: localProvider.id };
  const localCatalog = createAssetCatalog({ providers: [localProvider], sources: [localSource] });
  assert.throws(
    () => assertAssetCatalogSourceReusable(localCatalog, localSource.id),
    /cannot enter the shared canonical store/,
  );
});
