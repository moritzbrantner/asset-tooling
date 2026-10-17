// Acceptance for the approved Warden ability-icon export (#211, Decision Atlas 4.1.3).
//
// Owner selection (2026-10-17, #211): "I pick warden.ability.1.candidate.flux2-klein-tight-01,
// warden.ability.2.candidate.flux2-klein-tight-01, warden.ability.3.candidate.flux2-klein-tight-01,
// warden.ability.4.candidate.flux2-klein-tight-02".
//
// review/warden-icons/export-selection.json records that selection and names the exact sha256 of every
// master and derivative; review/warden-icons/approved/ is the committed approved-png-v1 bundle and
// approved/export.ref.json is the manifest AssetRef consumers pin. Payload checks need a Git LFS-hydrated
// checkout; ASSET_TOOLING_REQUIRE_REVIEW_LFS=1 makes hydration mandatory.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sha256Bytes } from "../src/hash.js";
import { canonicalJson } from "../src/canonical.js";
import { storeAssetObject } from "../src/asset-store.js";
import {
  APPROVED_IMAGE_BUNDLE_PROFILE,
  exportAssetBundle,
  parseApprovedImageBundleManifest,
  verifyAssetBundle,
} from "../src/asset-bundle.js";
import { createAssetRef } from "../src/operations.js";
import {
  WARDEN_EXPORT_VARIANTS,
  loadApprovedWardenExport,
  parseWardenExportSelection,
} from "../src/warden-icon-export.js";
import { exportApprovedWardenIcons } from "../src/warden-icon-derive.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW = "review/warden-icons";
const REVIEW_DIR = path.join(ROOT, ...REVIEW.split("/"));
const BUNDLE_DIR = path.join(REVIEW_DIR, "approved");
const OWNER_MESSAGE = "I pick warden.ability.1.candidate.flux2-klein-tight-01, warden.ability.2.candidate.flux2-klein-tight-01, warden.ability.3.candidate.flux2-klein-tight-01, warden.ability.4.candidate.flux2-klein-tight-02";
const PICKED = [
  "warden.ability.1.candidate.flux2-klein-tight-01",
  "warden.ability.2.candidate.flux2-klein-tight-01",
  "warden.ability.3.candidate.flux2-klein-tight-01",
  "warden.ability.4.candidate.flux2-klein-tight-02",
];
const SIZES: Record<string, number> = { "512": 512, "64": 64, "48": 48, "32": 32 };
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"));
}

function gitAttribute(relativePath: string, attribute: string) {
  const result = spawnSync("git", ["-C", ROOT, "check-attr", attribute, "--", relativePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(": ").at(-1);
}

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { timeout: 30_000 }).status === 0 && spawnSync("ffprobe", ["-version"], { timeout: 30_000 }).status === 0;
}

async function bundleHydrated(): Promise<boolean> {
  const manifest = await readJson(path.join(BUNDLE_DIR, "manifest.json"));
  for (const entry of manifest.assets) {
    const bytes = await readFile(path.join(BUNDLE_DIR, ...entry.path.split("/")));
    if (bytes.toString("utf8", 0, LFS_POINTER_PREFIX.length) === LFS_POINTER_PREFIX) return false;
  }
  return true;
}

/** The parts of a verified review that the selection parser reads, built from candidates.json alone. */
async function reviewStub(): Promise<any> {
  const manifest = await readJson(path.join(REVIEW_DIR, "candidates.json"));
  return { sets: manifest.sets, candidates: manifest.candidates };
}

test("export selection: the owner's four picks from the current FLUX.2 [klein] tight set, with their pinned master bytes", async () => {
  const selection = await readJson(path.join(REVIEW_DIR, "export-selection.json"));
  const candidates = await readJson(path.join(REVIEW_DIR, "candidates.json"));
  assert.equal(selection.profile, APPROVED_IMAGE_BUNDLE_PROFILE);
  assert.equal(selection.ownerSelection.message, OWNER_MESSAGE);
  assert.equal(selection.ownerSelection.date, "2026-10-17");
  assert.equal(selection.ownerSelection.candidateSet, "warden.v3.flux2-klein-tight");
  const currentSet = candidates.sets.find((set: any) => set.status === "current");
  assert.equal(currentSet.id, selection.ownerSelection.candidateSet);
  assert.deepEqual(selection.selections.map((entry: any) => entry.key), ["warden.ability.1", "warden.ability.2", "warden.ability.3", "warden.ability.4"]);
  assert.deepEqual(selection.selections.map((entry: any) => entry.candidate), PICKED);
  for (const entry of selection.selections) {
    const candidate = candidates.candidates.find((item: any) => item.id === entry.candidate);
    assert.equal(candidate.model, "flux2-klein-4b");
    assert.equal(entry.variants.master, candidate.sha256, `${entry.key} master is the candidate's exact bytes`);
    assert.deepEqual(Object.keys(entry.variants).sort(), [...WARDEN_EXPORT_VARIANTS].sort());
  }
  const parsed = parseWardenExportSelection(selection, await reviewStub());
  assert.equal(parsed.selections.length, 4);
});

test("export selection parser fails closed on a changed master, a superseded candidate or an unnamed pick", async () => {
  const review = await reviewStub();
  const base = await readJson(path.join(REVIEW_DIR, "export-selection.json"));
  const sd15 = review.candidates.find((candidate: any) => candidate.set === "warden.v1.sd15" && candidate.ability === "warden.ability.1");
  const cases: [string, (selection: any) => void, RegExp][] = [
    ["changed master sha", (selection) => { selection.selections[0].variants.master = "0".repeat(64); }, /master sha256/],
    ["SD 1.5 candidate", (selection) => {
      selection.selections[0].candidate = sd15.id;
      selection.selections[0].variants.master = sd15.sha256;
      selection.ownerSelection.message += ` ${sd15.id}`;
    }, /not in the selected set/],
    ["pick not named by the owner", (selection) => { selection.ownerSelection.message = "I pick something else"; }, /does not name/],
    ["missing ability", (selection) => { selection.selections.pop(); }, /exactly 4/],
  ];
  for (const [label, mutate, error] of cases) {
    const selection = structuredClone(base);
    mutate(selection);
    assert.throws(() => parseWardenExportSelection(selection, review), error, label);
  }
});

test("committed approved-png-v1 bundle names exactly the selection; no SD 1.5 or unselected candidate bytes", async () => {
  const selection = await readJson(path.join(REVIEW_DIR, "export-selection.json"));
  const candidates = await readJson(path.join(REVIEW_DIR, "candidates.json"));
  const manifestBytes = await readFile(path.join(BUNDLE_DIR, "manifest.json"));
  const manifest = parseApprovedImageBundleManifest(manifestBytes);
  const ref = createAssetRef(await readJson(path.join(BUNDLE_DIR, "export.ref.json")));
  assert.equal(ref.sha256, sha256Bytes(manifestBytes), "export.ref.json pins the committed manifest");
  assert.equal(ref.byteLength, manifestBytes.length);
  assert.equal(gitAttribute(`${REVIEW}/approved/manifest.json`, "filter"), "unspecified", "the manifest stays plain JSON");

  const expected = selection.selections.flatMap((entry: any) => WARDEN_EXPORT_VARIANTS.map((variant) => `${entry.key}/${variant}=${entry.variants[variant]}`)).sort();
  assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}=${entry.approved.sha256}`).sort(), expected);

  const selectedMasters = new Set(selection.selections.map((entry: any) => entry.variants.master));
  const otherCandidates = candidates.candidates.filter((candidate: any) => !selectedMasters.has(candidate.sha256));
  assert.equal(otherCandidates.length, candidates.candidates.length - 4);
  const exported = new Set(manifest.assets.map((entry) => entry.approved.sha256));
  for (const candidate of otherCandidates) assert(!exported.has(candidate.sha256), `${candidate.id} must not be in the approved export`);
  for (const sd15 of candidates.candidates.filter((candidate: any) => candidate.model === "sd15")) {
    assert(!manifestBytes.toString("utf8").includes(sd15.sha256), `SD 1.5 bytes ${sd15.sha256} appear nowhere in the approved manifest`);
  }

  const files = (await readdir(path.join(BUNDLE_DIR, "assets"))).map((file) => `assets/${file}`).sort();
  assert.deepEqual(files, [...new Set(manifest.assets.map((entry) => entry.path))].sort(), "the bundle holds exactly the manifest's payloads");
  for (const entry of manifest.assets) {
    assert.equal(gitAttribute(`${REVIEW}/approved/${entry.path}`, "filter"), "lfs", `${entry.path} is Git LFS-tracked`);
    const metadata: any = entry.source.metadata;
    assert.match(metadata.license.attribution, /FLUX\.2 \[klein\] 4B.*Apache-2\.0/);
    if (entry.variant === "master") {
      assert.equal(metadata.generation.checkpoint.license, "apache-2.0");
      assert.equal(metadata.review.candidate, selection.selections.find((item: any) => item.key === entry.key).candidate);
    } else {
      assert.equal(metadata.width, SIZES[entry.variant]);
      assert.equal(metadata.derivedFrom.sha256, selection.selections.find((item: any) => item.key === entry.key).variants.master);
      assert.deepEqual(metadata.derivation.map((step: any) => step.operation).filter((op: string) => op !== "image.resize@1"), ["image.decode@1", "image.encode.png@1"]);
    }
  }
});

test("committed bundle verifies offline from its pinned manifest (no ComfyUI, FFmpeg, store or network)", { timeout: 60_000 }, async (t) => {
  if (!(await bundleHydrated())) {
    if (process.env.ASSET_TOOLING_REQUIRE_REVIEW_LFS === "1") assert.fail("the approved bundle must be hydrated: git lfs pull --include=\"review/**\"");
    t.skip("approved bundle PNGs are unhydrated Git LFS pointers");
    return;
  }
  const loaded = await loadApprovedWardenExport(REVIEW_DIR, await reviewStub());
  assert.equal(loaded.images.length, 20);
  for (const image of loaded.images) {
    assert.equal(sha256Bytes(image.bytes), image.sha256);
    assert.equal(image.width, image.variant === "master" ? 1024 : SIZES[image.variant]);
  }

  const base = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-warden-export-"));
  try {
    // Idempotent re-export from the exact payloads: nothing is rewritten and the manifest is unchanged.
    const copy = path.join(base, "bundle");
    await cp(BUNDLE_DIR, copy, { recursive: true });
    const store = base;
    for (const entry of loaded.manifest.assets) {
      const bytes = await readFile(path.join(BUNDLE_DIR, ...entry.path.split("/")));
      const stored = await storeAssetObject(store, { bytes, kind: entry.source.kind, mediaType: entry.source.mediaType, metadata: entry.source.metadata });
      assert.equal(canonicalJson(stored.asset), canonicalJson(entry.source));
    }
    const again = await exportAssetBundle(store, copy, {
      parameters: { profile: APPROVED_IMAGE_BUNDLE_PROFILE, assets: loaded.manifest.assets.map(({ key, variant, approved }) => ({ key, variant, approved })) },
      inputs: { assets: loaded.manifest.assets.map((entry) => entry.source) },
    });
    assert.equal(again.manifest.sha256, loaded.manifestRef.sha256);
    assert.equal(again.bytesWritten, 0);

    // A corrupted payload fails verification against the pinned manifest.
    const victim = loaded.manifest.assets.find((entry) => entry.variant === "32")!;
    const file = path.join(copy, ...victim.path.split("/"));
    const bytes = await readFile(file);
    bytes[bytes.length - 20]! ^= 0xff;
    await writeFile(file, bytes);
    await assert.rejects(verifyAssetBundle(copy, loaded.manifestRef, { profile: APPROVED_IMAGE_BUNDLE_PROFILE }), /hash|pin/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a fresh export from the hydrated candidates reproduces the committed manifest", { timeout: 300_000 }, async (t) => {
  if (!hasFfmpeg() || !(await bundleHydrated())) {
    t.skip("needs FFmpeg and a hydrated review folder");
    return;
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-warden-export-"));
  try {
    const run = await exportApprovedWardenIcons({ root: base, reviewDirectory: REVIEW_DIR, outputDirectory: path.join(base, "bundle") });
    const committed = createAssetRef(await readJson(path.join(BUNDLE_DIR, "export.ref.json")));
    assert.equal(run.manifestRef!.sha256, committed.sha256);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("review page leads with the approved set, read from the verified export at 512/64/48/32 px", { timeout: 300_000 }, async (t) => {
  if (!hasFfmpeg() || !(await bundleHydrated())) {
    t.skip("needs FFmpeg and a hydrated review folder");
    return;
  }
  const { buildWardenReviewPage } = await import("../src/warden-icon-review.js");
  const base = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-warden-page-"));
  try {
    const output = path.join(base, "out");
    const result = await buildWardenReviewPage({ root: base, reviewDirectory: REVIEW_DIR, outputDirectory: output });
    const committed = createAssetRef(await readJson(path.join(BUNDLE_DIR, "export.ref.json")));
    assert.equal(result.approved?.manifestSha256, committed.sha256);
    assert.equal(result.approved?.images.length, 20);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const section = html.indexOf('id="approved-heading"');
    assert(section >= 0 && section < html.indexOf('class="candidates-heading"'), "the approved set comes before the candidates");
    assert(html.includes(OWNER_MESSAGE.replaceAll("'", "&#39;")), "the page quotes the owner's selection");
    for (const image of result.approved!.images) {
      const bytes = await readFile(path.join(output, ...image.url.split("/")));
      assert.equal(sha256Bytes(bytes), image.sha256, `${image.url} is the exported bytes`);
    }
    for (const size of [64, 48, 32]) {
      for (const key of ["warden.ability.1", "warden.ability.2", "warden.ability.3", "warden.ability.4"]) {
        assert.match(html, new RegExp(`<img src="images/approved/${key.replaceAll(".", "\\.")}\\.${size}\\.png" width="${size}" height="${size}"`));
      }
    }
    for (const id of PICKED) assert.match(html, new RegExp(`${id.replaceAll(".", "\\.")}</code></h5><span class="badge">candidate</span><a class="badge approved"`));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
