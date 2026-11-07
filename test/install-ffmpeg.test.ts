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
    browser_download_url: `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/${name}`,
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

test("offline installer never executes fetched tools, reuses verified archives, and rejects coupled cache tampering", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-ffmpeg-test-"));
  try {
    const name = asset("9.0").name.replace(/\.tar\.xz$/, "");
    const folder = path.join(root, "source", name, "bin");
    await mkdir(folder, { recursive: true });
    const executionMarker = path.join(root, "executed.txt");
    for (const binary of ["ffmpeg", "ffprobe"]) {
      const file = path.join(folder, binary);
      await writeFile(file, `#!/bin/sh\necho '${binary}' >> '${executionMarker}'\necho '${binary} version n9.0.2-test'\n`);
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
    const published = { tag_name: "latest", assets: [spec] };
    const store = path.join(root, "installed");
    let downloads = 0;
    let metadataRequests = 0;
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/releases/latest")) {
        metadataRequests++;
        return new Response(JSON.stringify(published));
      }
      assert.equal(String(url), spec.browser_download_url);
      downloads++;
      if (downloads === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 4096));
            controller.error(new TypeError("simulated CDN connection reset during streaming"));
          },
        }));
      }
      return new Response(bytes);
    }) as typeof fetch;

    const first = await installLatestStableFFmpeg({ installRoot: store, fetcher, releaseMetadata: published });
    await assert.rejects(readFile(executionMarker), { code: "ENOENT" }, "installation must not launch publisher binaries");
    const installedArchive = path.join(first, "..", "archive.tar.xz");
    assert.equal(createHash("sha256").update(await readFile(installedArchive)).digest("hex"), digest);
    assert.equal(spawnSync(path.join(first, "ffmpeg"), ["-version"], { encoding: "utf8" }).status, 0);
    const executed = await readFile(executionMarker, "utf8");
    assert.equal(await installLatestStableFFmpeg({ installRoot: store, fetcher }), first);
    assert.equal(await readFile(executionMarker, "utf8"), executed, "cache validation must not launch publisher binaries");
    assert.equal(downloads, 2, "one interrupted download is retried, intact cache does not redownload");
    assert.equal(metadataRequests, 1, "explicitly resolved metadata skips a second authenticated API request");

    const compromised = path.join(first, "ffmpeg");
    await writeFile(compromised, `#!/bin/sh\necho 'compromised' >> '${executionMarker}'\necho 'ffmpeg version n9.0.2-fake'\n`);
    await chmod(compromised, 0o755);
    const receiptFile = path.join(first, "..", "receipt.json");
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    receipt.ffmpegSha256 = createHash("sha256").update(await readFile(compromised)).digest("hex");
    await writeFile(receiptFile, JSON.stringify(receipt));
    await assert.rejects(installLatestStableFFmpeg({ installRoot: store, fetcher }), /cached ffmpeg binary failed its SHA-256 check/);
    assert.equal(await readFile(executionMarker, "utf8"), executed, "tampered cached executable must never run");

    await writeFile(installedArchive, "corrupt archive");
    await assert.rejects(installLatestStableFFmpeg({ installRoot: store, fetcher }), /cached archive failed its publisher SHA-256 check/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive transport retries are bounded and permanent HTTP failures are not retried", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-ffmpeg-test-"));
  const spec = { ...asset("9.0"), size: 1_100_000 };
  try {
    for (const fail of ["reset", "not-found"] as const) {
      let downloads = 0;
      const fetcher = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: "latest", assets: [spec] }));
        downloads++;
        if (fail === "reset") throw new TypeError("simulated ECONNRESET");
        return new Response("Missing", { status: 404 });
      }) as typeof fetch;
      const store = path.join(root, fail);
      await assert.rejects(installLatestStableFFmpeg({ installRoot: store, fetcher }),
        fail === "reset" ? /after 3 attempts/ : /HTTP 404/);
      assert.equal(downloads, fail === "reset" ? 3 : 1);
      assert.deepEqual(await readdir(store), [], "failed download does not leave a partial installation");
    }
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
