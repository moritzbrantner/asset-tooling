import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import {
  assetObjectPortablePath,
  createAssetRefFromBytes,
  resolveAssetObject,
  storeAssetObject,
} from "../src/asset-store.js";

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-object-store-test-"));
}

test("asset objects are content-addressed, idempotent, and storage-neutral", async () => {
  const root = await workspace();
  try {
    const bytes = Buffer.from("deterministic intermediate asset\n", "utf8");
    const first = await storeAssetObject(root, {
      bytes,
      kind: "image",
      mediaType: "image/png",
      metadata: { width: 16, height: 8 },
    });
    const second = await storeAssetObject(root, {
      bytes,
      kind: "image",
      mediaType: "image/png",
      metadata: { height: 8, width: 16 },
    });

    assert.equal(first.status, "changed");
    assert.equal(second.status, "unchanged");
    assert.deepEqual(second.asset, first.asset);
    assert.equal(Object.hasOwn(first.asset, "path"), false);

    const portablePath = assetObjectPortablePath(first.asset);
    assert.match(
      portablePath,
      /^\.asset-tooling\/objects\/v1\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
    );
    assert.deepEqual(await resolveAssetObject(root, first.asset), bytes);
    assert.deepEqual(
      await readFile(path.join(root, ...portablePath.split("/"))),
      bytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset object resolution fails closed for missing or corrupted bytes", async () => {
  const root = await workspace();
  try {
    const bytes = Buffer.from("abc", "utf8");
    const asset = createAssetRefFromBytes(bytes, {
      kind: "binary",
      mediaType: "application/octet-stream",
    });

    await assert.rejects(() => resolveAssetObject(root, asset), /asset object .* is missing/);

    await storeAssetObject(root, {
      bytes,
      kind: asset.kind,
      mediaType: asset.mediaType,
    });
    const objectPath = path.join(root, ...assetObjectPortablePath(asset).split("/"));
    await writeFile(objectPath, Buffer.from("abd", "utf8"));

    await assert.rejects(() => resolveAssetObject(root, asset), /asset object .* hash mismatch/);
    await assert.rejects(
      () =>
        storeAssetObject(root, {
          bytes,
          kind: asset.kind,
          mediaType: asset.mediaType,
        }),
      /asset object .* hash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset object store refuses symbolic-link escapes", async () => {
  if (process.platform === "win32") return;
  const root = await workspace();
  try {
    const outside = await workspace();
    try {
      await mkdir(path.join(root, ".asset-tooling"), { recursive: true });
      await symlink(outside, path.join(root, ".asset-tooling", "objects"));

      await assert.rejects(
        () =>
          storeAssetObject(root, {
            bytes: Buffer.from("must stay inside store", "utf8"),
            kind: "binary",
            mediaType: "application/octet-stream",
          }),
        /asset object path .* must not contain symbolic links/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
