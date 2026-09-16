import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { applyAssetCatalogLfsPromotion } from "../src/catalog-lfs-promotion.js";

const PROVIDERS = {
  schemaVersion: 1,
  providers: [
    {
      schemaVersion: 1,
      id: "example-shared",
      label: "Example Shared",
      homepage: "https://example.com/assets",
      distribution: "shared",
      acceptedLicenses: ["CC0-1.0"],
    },
  ],
};
const SOURCES = {
  schemaVersion: 1,
  sources: [
    {
      schemaVersion: 1,
      id: "example.model",
      provider: "example-shared",
      title: "Example Model",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      source: {
        url: "https://example.com/model.glb",
        path: "model.glb",
      },
      license: {
        spdx: "CC0-1.0",
        evidenceUrl: "https://example.com/license",
      },
      tags: ["testing"],
    },
  ],
};
const STORAGE = { schemaVersion: 1, entries: [] };

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-promotion-test-"));
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await writeFile(path.join(root, "catalog", "sources.json"), `${JSON.stringify(SOURCES, null, 2)}\n`);
  await writeFile(path.join(root, "catalog", "storage.json"), `${JSON.stringify(STORAGE, null, 2)}\n`);
  return root;
}

test("promotion pins candidate bytes and writes the canonical storage payload idempotently", async () => {
  const root = await workspace();
  const bytes = Buffer.from("real model bytes", "utf8");
  const fetchImpl = async () => new Response(bytes, { status: 200 });
  try {
    const first = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS,
      sourcesDocument: SOURCES,
      storageDocument: STORAGE,
      sourceId: "example.model",
      repositoryRoot: root,
      fetchImpl,
    });
    assert.equal(first.status, "changed");
    assert.equal(first.path, "assets/canonical/example.model/model.glb");
    assert.deepEqual(await readFile(path.join(root, ...first.path.split("/"))), bytes);

    const pinnedSources = JSON.parse(await readFile(path.join(root, "catalog", "sources.json"), "utf8"));
    const storage = JSON.parse(await readFile(path.join(root, "catalog", "storage.json"), "utf8"));
    assert.equal(pinnedSources.sources[0].source.sha256, first.sha256);
    assert.equal(pinnedSources.sources[0].source.byteLength, bytes.byteLength);
    assert.deepEqual(storage.entries, [
      {
        schemaVersion: 1,
        sourceId: "example.model",
        storage: "git-lfs",
        path: first.path,
      },
    ]);

    const second = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS,
      sourcesDocument: pinnedSources,
      storageDocument: storage,
      sourceId: "example.model",
      repositoryRoot: root,
      fetchImpl,
    });
    assert.equal(second.status, "unchanged");
    assert.equal(second.sha256, first.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion refuses to overwrite canonical bytes that do not match the pinned source", async () => {
  const root = await workspace();
  const bytes = Buffer.from("expected model bytes", "utf8");
  const fetchImpl = async () => new Response(bytes, { status: 200 });
  try {
    const first = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS,
      sourcesDocument: SOURCES,
      storageDocument: STORAGE,
      sourceId: "example.model",
      repositoryRoot: root,
      fetchImpl,
    });
    await writeFile(path.join(root, ...first.path.split("/")), Buffer.from("tampered", "utf8"));

    const pinnedSources = JSON.parse(await readFile(path.join(root, "catalog", "sources.json"), "utf8"));
    const storage = JSON.parse(await readFile(path.join(root, "catalog", "storage.json"), "utf8"));
    await assert.rejects(
      applyAssetCatalogLfsPromotion({
        providersDocument: PROVIDERS,
        sourcesDocument: pinnedSources,
        storageDocument: storage,
        sourceId: "example.model",
        repositoryRoot: root,
        fetchImpl,
      }),
      /hash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion validates existing storage before performing network acquisition", async () => {
  const root = await workspace();
  let fetched = false;
  try {
    await assert.rejects(
      applyAssetCatalogLfsPromotion({
        providersDocument: PROVIDERS,
        sourcesDocument: SOURCES,
        storageDocument: {
          schemaVersion: 1,
          entries: [
            {
              sourceId: "example.model",
              storage: "git-lfs",
              path: "assets/canonical/example.model/model.glb",
            },
          ],
        },
        sourceId: "example.model",
        repositoryRoot: root,
        fetchImpl: async () => {
          fetched = true;
          return new Response("must not be fetched", { status: 200 });
        },
      }),
      /must be content-pinned before canonical import/,
    );
    assert.equal(fetched, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
