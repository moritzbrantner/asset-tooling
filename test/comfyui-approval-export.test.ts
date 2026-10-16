/**
 * Independent acceptance contract for moritzbrantner/asset-tooling#223: candidate versus approved
 * ComfyUI outputs with a verified export.
 *
 * Written by a separate acceptance context before any implementation exists. Spec sources: the
 * #223 issue body, closed #212, #211 (the Warden icon consumer journey), docs/decisions/atlas.md
 * Decisions 4.1.1, 4.1.2, 4.1.3 and 5.1.1, docs/prd-comfyui-provider.md, docs/comfyui-first.md,
 * docs/asset-bundles.md and the existing tests test/asset-bundle.test.ts / atlas-bundle.test.ts.
 *
 * Decision 4.1.3 (owner, 2026-10-17, "least overhead"): approval is naming the exact approved
 * bytes (sha256) in a bundle export's selection. Exporting is the approval act; there is no
 * approval manifest, store or database. A regenerated image has new bytes and is never approved
 * implicitly; unselected candidates stay candidates. Existing bundle versions stay compatible.
 *
 * Every ComfyUI output is therefore a candidate: a plain stored image/png AssetRef (unchanged from
 * #212). It becomes "approved" only inside an export of the new profile below.
 *
 * ─── Seam 1: approved PNG bundle profile (asset-tooling/operations/bundle = src/asset-bundle.ts) ─
 *
 *   APPROVED_IMAGE_BUNDLE_PROFILE   = "approved-png-v1"
 *   APPROVED_IMAGE_BUNDLE_OPERATION = descriptor { id: "asset.bundle", version: "3",
 *       inputs:  [{ id: "assets", assetKinds: ["image"], mediaTypes: ["image/png"], cardinality 1..256 }],
 *       outputs: [{ id: "manifest", assetKinds: ["asset-bundle"], mediaTypes: [ASSET_BUNDLE_MEDIA_TYPE] }] }
 *     exported from the bundle subpath (so it also appears in the workflow bridge projection).
 *
 *   Invocation (same functions as @1/@2: createAssetBundleBuildIdentity, executeAssetBundleOperation,
 *   exportAssetBundle):
 *     parameters: { profile: "approved-png-v1",
 *                   assets: [{ key, variant, approved: { sha256 } }, ...] }   // exactly these fields
 *     inputs:     { assets: [AssetRef, ...] }                                 // one per selection, same order
 *   - `approved.sha256` is 64 lowercase hex characters; `approved` has exactly the field `sha256`.
 *     A selection without `approved`, with extra fields or a malformed sha is rejected.
 *   - Each input ref must be an image/png and its sha256 must equal the selection's approved sha256,
 *     and the stored bytes must re-hash to it. Otherwise the call throws an Error matching /approved/i
 *     before anything is written: a fresh export directory is not created, and an existing export
 *     keeps every file byte-identical (manifest.json is the commit point, as for @1).
 *   - A ref whose bytes are not in the asset store is rejected (no export).
 *
 *   Manifest (schemaVersion 3, canonical JSON + "\n", entries sorted by key then variant):
 *     { schemaVersion: 3, profile: "approved-png-v1",
 *       assets: [{ key, variant, approved: { sha256 }, source: <full AssetRef>, path: "assets/<sha256>.png" }] }
 *   - parseApprovedImageBundleManifest(bytes) parses it and rejects an entry whose approved sha256
 *     differs from source.sha256.
 *   - verifyAssetBundle(directory, manifestRef, { profile: APPROVED_IMAGE_BUNDLE_PROFILE }) verifies
 *     every payload against both pins without the source store; readAssetBundleAsset reads one entry.
 *   - schemas/asset-bundle-v3.schema.json declares the transport shape (v1/v2 stay byte-identical,
 *     test/public-contract.test.ts).
 *
 * ─── Seam 2: @1 / @2 unchanged ──────────────────────────────────────────────────────────────────
 *
 *   The workflow-bridge template hashes of asset.bundle@1 and @2 equal
 *   test/fixtures/workflow-bridge-operations.baseline.json, and a fixed @1 PNG export produces the
 *   manifest bytes measured on main da00761 (sha256 below). The behavioural @1/@2 regression stays
 *   test/asset-bundle.test.ts and test/atlas-bundle.test.ts. Adding asset.bundle@3 to the bundle
 *   subpath makes it a new bridge entry; test/comfyui-package-export.test.ts is updated in this
 *   commit to expect exactly ComfyUI and asset.bundle@3 as additions.
 *
 * The real local run is test/comfyui-approval-local-server.test.ts (skipped without env vars).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { resolveAssetObject, runAssetOperation, storeAssetObject } from "asset-tooling/operations/store";
import * as bundleModule from "asset-tooling/operations/bundle";
import * as workflowBridge from "asset-tooling/operations/workflow";
import { createComfyUiImageGenerateRegistration, probeComfyUiServer } from "asset-tooling/operations/image/comfyui";
import { encodeTestPng, readPngSize, startFakeComfyUi, type FakeComfyUi } from "./fixtures/comfyui-fake-server.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, "test", "fixtures", "comfyui", "sd15-txt2img.api.json");
const BRIDGE_BASELINE_PATH = path.join(REPO_ROOT, "test", "fixtures", "workflow-bridge-operations.baseline.json");
const CHECKPOINT_NAME = "sd15-fixture.safetensors";
const CHECKPOINT_BYTES = Buffer.from("fixture checkpoint bytes, never loaded by anything", "utf8");
const PROFILE = "approved-png-v1";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** sha256 of the @1 manifest for the fixed two-PNG export below, measured on main da00761. */
const STATIC_V1_MANIFEST_SHA256 = "89427307475983b5464578e5b74f3964716997d800771adb532b15e266380ef1";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bundle = bundleModule as Record<string, any>;

function approvedApi() {
  assert.equal(bundle.APPROVED_IMAGE_BUNDLE_PROFILE, PROFILE, "asset-tooling/operations/bundle must export APPROVED_IMAGE_BUNDLE_PROFILE = 'approved-png-v1' (#223)");
  const operation = bundle.APPROVED_IMAGE_BUNDLE_OPERATION;
  assert.ok(operation && typeof operation === "object", "asset-tooling/operations/bundle must export APPROVED_IMAGE_BUNDLE_OPERATION (#223)");
  assert.equal(typeof bundle.parseApprovedImageBundleManifest, "function", "export parseApprovedImageBundleManifest (#223)");
  return {
    operation,
    exportAssetBundle: bundle.exportAssetBundle as (root: string, directory: string, invocation: unknown) => Promise<any>,
    executeAssetBundleOperation: bundle.executeAssetBundleOperation as (root: string, invocation: unknown) => Promise<any>,
    verifyAssetBundle: bundle.verifyAssetBundle as (directory: string, ref: unknown, options?: unknown) => Promise<any>,
    readAssetBundleAsset: bundle.readAssetBundleAsset as (directory: string, manifest: unknown, key: string, variant: string) => Promise<Buffer>,
    parse: bundle.parseApprovedImageBundleManifest as (bytes: Uint8Array) => any,
  };
}

function selection(key: string, approvedSha: string, variant = "master") {
  return { key, variant, approved: { sha256: approvedSha } };
}

function invocation(selections: unknown[], refs: unknown[]) {
  return { parameters: { profile: PROFILE, assets: selections }, inputs: { assets: refs } };
}

/** Every file below `directory`, as relative POSIX path -> sha256 (independent of asset-tooling). */
async function tree(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string, prefix: string) {
    for (const child of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) await walk(path.join(current, child.name), relative);
      else result[relative] = sha256(await readFile(path.join(current, child.name)));
    }
  }
  await walk(directory, "");
  return result;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

interface Harness {
  root: string;
  fake: FakeComfyUi;
  /** Run image.comfyui.generate@1 once against the fake server; returns the candidate AssetRef. */
  generate(seed: number): Promise<any>;
}

async function withComfyUi(run: (h: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-comfyui-approval-"));
  const fake = await startFakeComfyUi({ behaviour: "success", checkpoints: [CHECKPOINT_NAME] });
  try {
    const workflow = (
      await storeAssetObject(root, {
        bytes: await readFile(WORKFLOW_PATH),
        kind: "workflow",
        mediaType: "application/json",
        metadata: { format: "comfyui-api-prompt" },
      })
    ).asset;
    const checkpointDirectory = path.join(root, "comfyui-models", "checkpoints");
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(path.join(checkpointDirectory, CHECKPOINT_NAME), CHECKPOINT_BYTES);
    const checkpoint = {
      name: CHECKPOINT_NAME,
      sha256: sha256(CHECKPOINT_BYTES),
      byteLength: CHECKPOINT_BYTES.byteLength,
      license: "creativeml-openrail-m",
    };
    const server = await probeComfyUiServer({ endpoint: fake.endpoint });
    const registration = createComfyUiImageGenerateRegistration({
      endpoint: fake.endpoint,
      server,
      checkpointDirectory,
      timeoutMs: 10_000,
      pollIntervalMs: 5,
    });
    await run({
      root,
      fake,
      async generate(seed: number) {
        const result = await runAssetOperation(root, registration, {
          parameters: {
            provider: "comfyui",
            checkpoint,
            injections: {
              checkpoint: { node: "4", input: "ckpt_name" },
              seed: { node: "3", input: "seed", value: seed },
              positivePrompt: { node: "6", input: "text", value: "Warden ability: heroic strike, painted fantasy icon" },
              negativePrompt: { node: "7", input: "text", value: "text, watermark" },
              width: { node: "5", input: "width", value: 64 },
              height: { node: "5", input: "height", value: 64 },
            },
            output: { node: "9" },
          },
          inputs: { workflow },
        });
        const image = result.result.outputs.image as any;
        assert.equal(image.mediaType, "image/png");
        assert.equal(image.kind, "image");
        return image;
      },
    });
  } finally {
    await fake.stop();
    await rm(root, { recursive: true, force: true });
  }
}

// ─── 1. Candidates ──────────────────────────────────────────────────────────────────────────────

test("#223: generated outputs are distinct candidates and carry no approval of their own", async () => {
  await withComfyUi(async ({ root, fake, generate }) => {
    const a = await generate(223);
    const b = await generate(224);
    const c = await generate(225);
    assert.equal(fake.submissions.length, 3, "three real submissions to ComfyUI");
    assert.equal(new Set([a.sha256, b.sha256, c.sha256]).size, 3, "different seeds give different candidate bytes");
    for (const ref of [a, b, c]) {
      // A candidate is a plain stored PNG; approval lives only in an export selection (Decision 4.1.3).
      assert.ok(!/approv/i.test(canonicalJson(ref)), "a generated AssetRef must not claim approval");
      const bytes = await resolveAssetObject(root, ref);
      assert.equal(sha256(bytes), ref.sha256);
      assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE);
    }
  });
});

test("#223: a candidate is not exportable under the approved profile without naming its exact sha", async () => {
  await withComfyUi(async ({ root, generate }) => {
    const api = approvedApi();
    const a = await generate(223);
    const out = path.join(root, "export");
    const malformed: unknown[] = [
      { key: "warden.ability.1", variant: "master" }, // no approval at all
      { key: "warden.ability.1", variant: "master", approved: {} },
      { key: "warden.ability.1", variant: "master", approved: { sha256: a.sha256.toUpperCase() } },
      { key: "warden.ability.1", variant: "master", approved: { sha256: a.sha256.slice(0, 63) } },
      { key: "warden.ability.1", variant: "master", approved: { sha256: a.sha256, by: "someone" } },
      { key: "warden.ability.1", variant: "master", approved: { sha256: a.sha256 }, note: "extra" },
      { key: "warden.ability.1", variant: "master", approved: a.sha256 },
    ];
    for (const entry of malformed) {
      await assert.rejects(api.exportAssetBundle(root, out, invocation([entry], [a])), Error, `must reject ${JSON.stringify(entry)}`);
      assert.equal(await exists(out), false, "a rejected export writes nothing");
    }
  });
});

// ─── 2. Approve by exact sha, export, verify independently ──────────────────────────────────────

test("#223: exporting with an approved sha packages exactly that candidate; the export re-hashes independently", async () => {
  await withComfyUi(async ({ root, generate }) => {
    const api = approvedApi();
    const candidates = [await generate(223), await generate(224), await generate(225)];
    const chosen = candidates[1];
    const out = path.join(root, "export");

    const result = await api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", chosen.sha256)], [chosen]));
    assert.equal(result.manifest.kind, "asset-bundle");
    assert.equal(result.assetsVerified, 1);
    assert.deepEqual(result.files, ["assets/" + chosen.sha256 + ".png", "manifest.json"]);

    // Independent check: hash the files on disk, not through asset-tooling.
    const files = await tree(out);
    assert.deepEqual(Object.keys(files).sort(), ["assets/" + chosen.sha256 + ".png", "manifest.json"]);
    assert.equal(files[`assets/${chosen.sha256}.png`], chosen.sha256, "the exported payload re-hashes to the approved sha");
    assert.equal(files["manifest.json"], result.manifest.sha256);
    for (const unselected of [candidates[0], candidates[2]]) {
      assert.ok(!Object.values(files).includes(unselected.sha256), "unselected candidates are not exported");
    }
    const payload = await readFile(path.join(out, "assets", `${chosen.sha256}.png`));
    assert.deepEqual(payload.subarray(0, 8), PNG_SIGNATURE);
    assert.deepEqual(readPngSize(payload), { width: 64, height: 64 });

    const manifestBytes = await readFile(path.join(out, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(manifestBytes.toString("utf8"), `${canonicalJson(manifest)}\n`, "canonical JSON manifest");
    assert.deepEqual(manifest, {
      schemaVersion: 3,
      profile: PROFILE,
      assets: [
        { key: "warden.ability.1", variant: "master", approved: { sha256: chosen.sha256 }, source: chosen, path: `assets/${chosen.sha256}.png` },
      ],
    });
    assert.deepEqual(api.parse(manifestBytes), manifest);

    // Consumer verification without the source store, ComfyUI or network.
    await rm(path.join(root, ".asset-tooling"), { recursive: true, force: true });
    const verified = await api.verifyAssetBundle(out, result.manifest, { profile: PROFILE });
    assert.equal(verified.assetsVerified, 1);
    assert.deepEqual(await api.readAssetBundleAsset(out, verified.manifest, "warden.ability.1", "master"), payload);
    await assert.rejects(api.verifyAssetBundle(out, result.manifest), Error, "the default (static) verification profile does not admit an approved bundle");
  });
});

test("#223: several approved keys export only their named bytes, in stable order, idempotently", async () => {
  await withComfyUi(async ({ root, generate }) => {
    const api = approvedApi();
    const [a, b, c, d] = [await generate(301), await generate(302), await generate(303), await generate(304)];
    const out = path.join(root, "export");
    const selections = [selection("warden.ability.2", c.sha256), selection("warden.ability.1", a.sha256)];
    const first = await api.exportAssetBundle(root, out, invocation(selections, [c, a]));
    const files = await tree(out);
    assert.deepEqual(
      Object.keys(files).sort(),
      [`assets/${a.sha256}.png`, `assets/${c.sha256}.png`, "manifest.json"].sort(),
    );
    for (const ref of [a, c]) assert.equal(files[`assets/${ref.sha256}.png`], ref.sha256);
    for (const ref of [b, d]) assert.ok(!Object.values(files).includes(ref.sha256));
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.assets.map((e: any) => [e.key, e.approved.sha256]), [["warden.ability.1", a.sha256], ["warden.ability.2", c.sha256]]);

    const again = await api.exportAssetBundle(root, out, invocation([...selections].reverse(), [a, c]));
    assert.equal(again.manifest.sha256, first.manifest.sha256);
    assert.equal(again.manifestStatus, "unchanged");
    assert.equal(again.bytesWritten, 0);
    assert.deepEqual(await tree(out), files);

    const executed = await api.executeAssetBundleOperation(root, invocation(selections, [c, a]));
    assert.equal(executed.outputs.manifest.sha256, first.manifest.sha256, "operation and export agree on the manifest");
  });
});

// ─── 3. Mismatch, regeneration and non-candidates are rejected without writing ──────────────────

test("#223: a selection whose source ref does not match its approved sha is rejected with no output", async () => {
  await withComfyUi(async ({ root, generate }) => {
    const api = approvedApi();
    const a = await generate(223);
    const b = await generate(224);
    const fresh = path.join(root, "fresh");
    await assert.rejects(api.exportAssetBundle(root, fresh, invocation([selection("warden.ability.1", a.sha256)], [b])), /approved/i);
    assert.equal(await exists(fresh), false, "no export directory is created");
    await assert.rejects(api.executeAssetBundleOperation(root, invocation([selection("warden.ability.1", a.sha256)], [b])), /approved/i);

    // An existing accepted export is left byte-identical, even when only one of several entries mismatches.
    const out = path.join(root, "export");
    await api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", a.sha256)], [a]));
    const before = await tree(out);
    await assert.rejects(
      api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", a.sha256), selection("warden.ability.2", a.sha256)], [a, b])),
      /approved/i,
    );
    assert.deepEqual(await tree(out), before, "the last accepted export is untouched");
  });
});

test("#223: regenerating gives a new sha, so an earlier approval never applies to the new candidate", async () => {
  await withComfyUi(async ({ root, generate }) => {
    const api = approvedApi();
    const original = await generate(223);
    const out = path.join(root, "export");
    await api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", original.sha256)], [original]));
    const accepted = await tree(out);

    const regenerated = await generate(224); // the same brief, re-rolled
    assert.notEqual(regenerated.sha256, original.sha256, "regeneration yields new bytes");
    await assert.rejects(
      api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", original.sha256)], [regenerated])),
      /approved/i,
      "the old approval does not carry over to a new image",
    );
    assert.deepEqual(await tree(out), accepted, "the last accepted export is untouched");

    // Approving the new bytes is a new, explicit act naming the new sha.
    await api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", regenerated.sha256)], [regenerated]));
    const files = await tree(out);
    assert.equal(files[`assets/${regenerated.sha256}.png`], regenerated.sha256);
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.assets.map((e: any) => e.approved.sha256), [regenerated.sha256]);
  });
});

test("#223: approving a sha that is not a stored candidate is rejected", async () => {
  await withComfyUi(async ({ root, generate }) => {
    const api = approvedApi();
    const a = await generate(223);
    const out = path.join(root, "export");
    // A well-formed ref and approval for bytes that were never stored.
    const foreign = encodeTestPng(64, 64, 99);
    const ghost = { ...a, sha256: sha256(foreign), byteLength: foreign.byteLength };
    await assert.rejects(api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", ghost.sha256)], [ghost])), Error);
    assert.equal(await exists(out), false);
    // A stored object whose bytes were altered after generation no longer matches its approval.
    const objects = path.join(root, ".asset-tooling", "objects");
    const stored = Object.entries(await tree(objects)).find(([, hash]) => hash === a.sha256);
    assert.ok(stored, "the candidate is in the object store");
    await writeFile(path.join(objects, ...stored![0].split("/")), encodeTestPng(64, 64, 1));
    await assert.rejects(api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", a.sha256)], [a])), Error);
    assert.equal(await exists(out), false);
  });
});

test("#223: a tampered approved manifest is rejected by parsing and verification", async () => {
  await withComfyUi(async ({ root, generate }) => {
    const api = approvedApi();
    const a = await generate(223);
    const b = await generate(224);
    const out = path.join(root, "export");
    await api.exportAssetBundle(root, out, invocation([selection("warden.ability.1", a.sha256)], [a]));
    const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    manifest.assets[0].approved.sha256 = b.sha256; // approval no longer names the packaged bytes
    const forged = Buffer.from(`${canonicalJson(manifest)}\n`);
    assert.throws(() => api.parse(forged), /approved/i);
    await writeFile(path.join(out, "manifest.json"), forged);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-forged-"));
    try {
      const forgedRef = (await storeAssetObject(scratch, { bytes: forged, kind: "asset-bundle", mediaType: bundle.ASSET_BUNDLE_MEDIA_TYPE, metadata: {} })).asset;
      await assert.rejects(api.verifyAssetBundle(out, forgedRef, { profile: PROFILE }), Error);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

// ─── 4. Descriptor, schema and @1/@2 compatibility ──────────────────────────────────────────────

test("#223: asset.bundle@3 is the approved PNG operation; @1 and @2 bridge templates are unchanged", async () => {
  const api = approvedApi();
  assert.equal(api.operation.id, "asset.bundle");
  assert.equal(api.operation.version, "3");
  assert.equal(api.operation.inputs.length, 1);
  assert.equal(api.operation.inputs[0].id, "assets");
  assert.deepEqual(api.operation.inputs[0].assetKinds, ["image"]);
  assert.deepEqual(api.operation.inputs[0].mediaTypes, ["image/png"]);
  assert.deepEqual(api.operation.outputs.map((o: any) => [o.id, o.mediaTypes]), [["manifest", [bundle.ASSET_BUNDLE_MEDIA_TYPE]]]);

  const baseline = JSON.parse(await readFile(BRIDGE_BASELINE_PATH, "utf8")) as { templates: Record<string, string> };
  const hash = (descriptor: unknown) => sha256(canonicalJson(workflowBridge.createAssetOperationWorkflowNodeTemplate(descriptor as any)));
  assert.equal(hash(bundle.ASSET_BUNDLE_OPERATION), baseline.templates["asset.bundle@1"], "asset.bundle@1 contract unchanged");
  assert.equal(hash(bundle.SPRITE_ATLAS_BUNDLE_OPERATION), baseline.templates["asset.bundle@2"], "asset.bundle@2 contract unchanged");
  assert.ok(!("asset.bundle@3" in baseline.templates));

  const schema = JSON.parse(await readFile(path.join(REPO_ROOT, "schemas", "asset-bundle-v3.schema.json"), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, 3);
  assert.equal(schema.properties.profile.const, PROFILE);
  assert.ok(schema.properties.assets.items.required.includes("approved"), "the v3 schema requires `approved` on every entry");
});

test("#223: a static @1 PNG export is byte-identical to main and still needs no approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-bundle-v1-"));
  try {
    const a = (await storeAssetObject(root, { bytes: encodeTestPng(32, 32, 7), kind: "image", mediaType: "image/png", metadata: { width: 32, height: 32 } })).asset;
    const b = (await storeAssetObject(root, { bytes: encodeTestPng(16, 16, 9), kind: "image", mediaType: "image/png", metadata: { width: 16, height: 16 } })).asset;
    const out = path.join(root, "out");
    const result = await bundle.exportAssetBundle(root, out, {
      parameters: { profile: bundle.STATIC_ASSET_BUNDLE_PROFILE, assets: [{ key: "warden.ability.1", variant: "master" }, { key: "warden.ability.2", variant: "master" }] },
      inputs: { assets: [a, b] },
    });
    assert.equal(sha256(await readFile(path.join(out, "manifest.json"))), STATIC_V1_MANIFEST_SHA256);
    assert.equal(result.manifest.sha256, STATIC_V1_MANIFEST_SHA256);
    // An @1 selection that names an approval is not part of the @1 contract.
    await assert.rejects(
      bundle.exportAssetBundle(root, path.join(root, "out2"), {
        parameters: { profile: bundle.STATIC_ASSET_BUNDLE_PROFILE, assets: [selection("warden.ability.1", a.sha256)] },
        inputs: { assets: [a] },
      }),
      Error,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
