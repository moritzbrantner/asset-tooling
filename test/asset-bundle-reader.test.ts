import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createAssetRef } from "../src/operations.js";
import { sha256Bytes } from "../src/hash.js";
import { createAssetBundleReader, readAssetBundleAsset, STATIC_ASSET_BUNDLE_PROFILE, type AssetBundleEntry, type AssetBundleManifest } from "../src/asset-bundle.js";

test("snapshot reader indexes pinned selections without aliasing the caller's mutable manifest", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bundle-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "assets"));
  const makeEntry = async (key: string, bytes: Buffer): Promise<AssetBundleEntry> => {
    const source = createAssetRef({ kind: "image", mediaType: "image/png", byteLength: bytes.length,
      sha256: sha256Bytes(bytes), metadata: { license: "CC0-1.0" } });
    const assetPath = `assets/${source.sha256}.png`;
    await writeFile(path.join(directory, assetPath), bytes);
    return { key, variant: "default", source, path: assetPath };
  };
  const first = Buffer.from("fixture-a"), second = Buffer.from("fixture-b");
  const a = await makeEntry("a", first), b = await makeEntry("b", second);
  const manifest: AssetBundleManifest = { schemaVersion: 1, profile: STATIC_ASSET_BUNDLE_PROFILE, assets: [a, b] };
  const reader = createAssetBundleReader(directory, manifest);
  assert.deepEqual(await reader.readAsset("a", "default"), first);
  assert.deepEqual(await reader.readAsset("b", "default"), second);
  await assert.rejects(reader.readAsset("missing", "default"), /does not contain/);

  // An existing reader is an immutable snapshot; the uncached API and a new snapshot see changed input.
  manifest.assets[0] = { ...a, source: b.source, path: b.path };
  assert.deepEqual(await reader.readAsset("a", "default"), first);
  assert.deepEqual(await readAssetBundleAsset(directory, manifest, "a", "default"), second);
  assert.deepEqual(await createAssetBundleReader(directory, manifest).readAsset("a", "default"), second);
  manifest.assets[0] = { ...a, path: "../escape.png" };
  assert.throws(() => createAssetBundleReader(directory, manifest), /path/);
  assert.deepEqual(await reader.readAsset("a", "default"), first);

  // Snapshot lookup never caches bytes: it re-reads pins and rejects tampering or links.
  await writeFile(path.join(directory, a.path), Buffer.from("fixture-x"));
  await assert.rejects(reader.readAsset("a", "default"), /hash/);
  await rm(path.join(directory, a.path));
  await symlink(path.join(directory, b.path), path.join(directory, a.path));
  await assert.rejects(reader.readAsset("a", "default"), /regular file/);
  assert.deepEqual(await readFile(path.join(directory, b.path)), second);
});
