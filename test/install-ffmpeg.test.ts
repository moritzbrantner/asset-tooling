import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import { installLatestStableFFmpeg, selectStableLinuxAsset } from "../scripts/install-ffmpeg.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function asset(series: string, variant = "lgpl") {
  const name = `ffmpeg-n${series}-latest-linux64-${variant}-${series}.tar.xz`;
  return {
    name,
    size: 136_000_000,
    digest: DIGEST,
    browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${name}`,
  };
}

test("selects the newest stable FFmpeg release branch, never master or an older series", () => {
  const release = {
    tag_name: "latest",
    draft: false,
    prerelease: false,
    assets: [
      asset("8.1"),
      asset("9.0", "gpl"),
      { ...asset("9.0"), name: "ffmpeg-master-latest-linux64-lgpl.tar.xz" },
      asset("9.0"),
      asset("8.10"),
    ],
  };
  const selected = selectStableLinuxAsset(release);
  assert.equal(selected.series, "9.0");
  assert.equal(selected.name, asset("9.0").name);
  assert.equal(selected.sha256, "a".repeat(64));
  assert.equal(selected.size, 136_000_000);
});

test("sorts release branches numerically, not lexicographically", () => {
  const selected = selectStableLinuxAsset({ tag_name: "latest", assets: [asset("9.9"), asset("10.0")] });
  assert.equal(selected.series, "10.0");
});

test("rejects untrusted release metadata and invalid publisher digests", () => {
  assert.throws(() => selectStableLinuxAsset({ tag_name: "master", assets: [asset("9.0")] }), /latest release/i);
  assert.throws(() => selectStableLinuxAsset({ tag_name: "latest", draft: true, assets: [asset("9.0")] }), /published/i);
  assert.throws(() => selectStableLinuxAsset({ tag_name: "latest", assets: [asset("9.0", "gpl")] }), /stable linux/i);
  assert.throws(() => selectStableLinuxAsset({ tag_name: "latest", assets: [{ ...asset("9.0"), digest: null }] }), /sha-256/i);
  assert.throws(() => selectStableLinuxAsset({ tag_name: "latest", assets: [{ ...asset("9.0"), browser_download_url: "https://evil.example/ffmpeg.tar.xz" }] }), /download URL/i);
  assert.throws(() => selectStableLinuxAsset({ tag_name: "latest", assets: [{ ...asset("9.0"), size: -1 }] }), /size/i);
});

test("offline installer verifies publisher bytes, reuses intact tools, and rejects cache mutation", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-ffmpeg-test-"));
  try {
    const name = asset("9.0").name.replace(/\.tar\.xz$/, "");
    const folder = path.join(root, "source", name, "bin");
    await mkdir(folder, { recursive: true });
    for (const binary of ["ffmpeg", "ffprobe"]) {
      const file = path.join(folder, binary);
      await writeFile(file, `#!/bin/sh\necho '${binary} version n9.0.2-test'\n`);
      await chmod(file, 0o755);
    }
    // A compressed fixture above the lower download size bound exercises the real tar path.
    await writeFile(path.join(root, "source", name, "padding.bin"), randomBytes(1_100_000));
    const archive = path.join(root, "fixture.tar.xz");
    const packed = spawnSync("tar", ["-cJf", archive, "-C", path.join(root, "source"), name], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const bytes = await readFile(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const spec = { ...asset("9.0"), digest: `sha256:${digest}`, size: bytes.length };
    const store = path.join(root, "installed");
    let downloads = 0;
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: "latest", assets: [spec] }));
      assert.equal(String(url), spec.browser_download_url);
      downloads++;
      return new Response(bytes);
    }) as typeof fetch;

    const first = await installLatestStableFFmpeg({ installRoot: store, fetcher });
    assert.equal(spawnSync(path.join(first, "ffmpeg"), ["-version"], { encoding: "utf8" }).status, 0);
    assert.equal(await installLatestStableFFmpeg({ installRoot: store, fetcher }), first);
    assert.equal(downloads, 1, "intact cache does not redownload the same publisher asset");

    await writeFile(path.join(first, "ffmpeg"), "tampered");
    await assert.rejects(installLatestStableFFmpeg({ installRoot: store, fetcher }), /Refusing to replace invalid FFmpeg installation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline installer rejects archive digest mismatch without leaving an installation", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-ffmpeg-test-"));
  try {
    const spec = { ...asset("9.0"), size: 1_100_000 };
    const fetcher = (async (url: string | URL | Request) => String(url).endsWith("/releases/latest")
      ? new Response(JSON.stringify({ tag_name: "latest", assets: [spec] }))
      : new Response(randomBytes(1_100_000))) as typeof fetch;
    const store = path.join(root, "installed");
    await assert.rejects(installLatestStableFFmpeg({ installRoot: store, fetcher }), /SHA-256/i);
    assert.deepEqual(await readdir(store), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
