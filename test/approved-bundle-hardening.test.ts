/**
 * Regressions for the Codex review of PR #229 (asset.bundle@3, approved-png-v1, #223):
 *   1. payloads are re-verified without following symlinks immediately before the manifest commit;
 *   2. v3 manifest source refs are strict serialized AssetRefs (no defaulted schemaVersion/metadata);
 *   3. a failure before the manifest commit rolls back the payloads/directories the call added.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { storeAssetObject } from "../src/asset-store.js";
import {
  APPROVED_IMAGE_BUNDLE_PROFILE,
  ASSET_BUNDLE_MEDIA_TYPE,
  exportAssetBundle,
  parseApprovedImageBundleManifest,
  verifyAssetBundle,
} from "../src/asset-bundle.js";
import { encodeTestPng } from "./fixtures/comfyui-fake-server.js";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function tree(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) Object.assign(result, await tree(path.join(directory, child.name), relative));
    else result[relative] = child.isSymbolicLink() ? "symlink" : sha256(await readFile(path.join(directory, child.name)));
  }
  return result;
}
const exists = (file: string) => stat(file).then(() => true, () => false);

async function withRoot(run: (root: string, store: (seed: number) => Promise<any>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-approved-hardening-"));
  try {
    await run(root, async (seed) =>
      (await storeAssetObject(root, { bytes: encodeTestPng(32, 32, seed), kind: "image", mediaType: "image/png", metadata: { width: 32, height: 32 } })).asset);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function approved(entries: [string, any][]) {
  return {
    parameters: { profile: APPROVED_IMAGE_BUNDLE_PROFILE, assets: entries.map(([key, ref]) => ({ key, variant: "master", approved: { sha256: ref.sha256 } })) },
    inputs: { assets: entries.map(([, ref]) => ref) },
  };
}

test("an onArtifact that swaps a payload for different bytes fails without committing the manifest", async () => {
  await withRoot(async (root, store) => {
    const a = await store(1);
    const out = path.join(root, "export");
    await assert.rejects(
      exportAssetBundle(root, out, approved([["icon.a", a]]), {
        onArtifact: async ({ path: relative }) => writeFile(path.join(out, relative), encodeTestPng(32, 32, 2)),
      }),
      /approved/i,
    );
    assert.equal(await exists(path.join(out, "manifest.json")), false, "no manifest was committed");
  });
});

test("an onArtifact that swaps a payload for a symlink to the approved bytes fails without committing", async () => {
  await withRoot(async (root, store) => {
    const a = await store(1);
    const out = path.join(root, "export");
    const elsewhere = path.join(root, "elsewhere.png");
    await writeFile(elsewhere, encodeTestPng(32, 32, 1));
    assert.equal(sha256(await readFile(elsewhere)), a.sha256);
    await assert.rejects(
      exportAssetBundle(root, out, approved([["icon.a", a]]), {
        onArtifact: async ({ path: relative }) => {
          const target = path.join(out, relative);
          await rm(target);
          await symlink(elsewhere, target);
        },
      }),
    );
    assert.equal(await exists(path.join(out, "manifest.json")), false, "no manifest was committed");
  });
});

test("a late failure leaves an existing approved export byte-identical and removes the added payloads", async () => {
  await withRoot(async (root, store) => {
    const a = await store(1);
    const b = await store(2);
    const out = path.join(root, "export");
    await exportAssetBundle(root, out, approved([["icon.a", a]]));
    const before = await tree(out);

    await assert.rejects(
      exportAssetBundle(root, out, approved([["icon.a", a], ["icon.b", b]]), {
        onArtifact: async ({ path: relative }) => {
          if (relative.includes(b.sha256)) throw new Error("callback failed");
        },
      }),
      /callback failed/,
    );
    assert.deepEqual(await tree(out), before, "the added payload is rolled back");

    const controller = new AbortController();
    await assert.rejects(
      exportAssetBundle(root, out, approved([["icon.a", a], ["icon.b", b]]), {
        signal: controller.signal,
        onArtifact: async () => controller.abort(),
      }),
    );
    assert.deepEqual(await tree(out), before, "cancellation before the commit rolls back too");
  });
});

test("a late failure on a fresh export leaves no export directory behind", async () => {
  await withRoot(async (root, store) => {
    const a = await store(1);
    const out = path.join(root, "nested", "export");
    await assert.rejects(
      exportAssetBundle(root, out, approved([["icon.a", a]]), { onArtifact: async () => { throw new Error("callback failed"); } }),
      /callback failed/,
    );
    assert.equal(await exists(path.join(root, "nested")), false);
  });
});

test("a v3 manifest whose source ref omits schemaVersion or metadata is rejected", async () => {
  await withRoot(async (root, store) => {
    const a = await store(1);
    const out = path.join(root, "export");
    await exportAssetBundle(root, out, approved([["icon.a", a]]));
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    for (const field of ["schemaVersion", "metadata"]) {
      const forged = structuredClone(manifest);
      delete forged.assets[0].source[field];
      const bytes = Buffer.from(`${canonicalJson(forged)}\n`);
      assert.throws(() => parseApprovedImageBundleManifest(bytes), new RegExp(field), `missing ${field}`);
      await writeFile(path.join(out, "manifest.json"), bytes);
      const ref = (await storeAssetObject(root, { bytes, kind: "asset-bundle", mediaType: ASSET_BUNDLE_MEDIA_TYPE, metadata: {} })).asset;
      await assert.rejects(verifyAssetBundle(out, ref, { profile: APPROVED_IMAGE_BUNDLE_PROFILE }), new RegExp(field));
    }
  });
});
