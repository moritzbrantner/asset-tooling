/**
 * Explicitly acquire the newest stable-branch FFmpeg/FFprobe build for Linux.
 *
 * The publisher's `latest` release contains `nX.Y` release-branch builds as well as
 * development (`master`) builds. Choose the highest numeric release branch, not
 * master, and verify the publisher-supplied SHA-256 before installing anything.
 *
 *   export PATH="$(bun scripts/install-ffmpeg.ts):$PATH"
 *
 * This is an opt-in setup operation. Image generation/verification never downloads
 * a codec implicitly; the build identity already records the actual FFmpeg version.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_API = "https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/latest";
const RELEASE_PREFIX = "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ROOT = path.join(ROOT, ".artifacts", "toolchain", "ffmpeg");

export type StableLinuxAsset = {
  name: string;
  series: string;
  url: string;
  sha256: string;
  size: number;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid FFmpeg release metadata");
  return value as Record<string, unknown>;
}

export function selectStableLinuxAsset(release: unknown, architecture: "x64" | "arm64" = "x64"): StableLinuxAsset {
  const data = record(release);
  if (data.tag_name !== "latest") throw new Error("Expected the publisher's latest release");
  if (data.draft === true || data.prerelease === true) throw new Error("FFmpeg release must be published and stable");
  if (!Array.isArray(data.assets)) throw new Error("FFmpeg release assets are missing");

  const platform = architecture === "arm64" ? "linuxarm64" : "linux64";
  const pattern = new RegExp(`^ffmpeg-n(\\d+)\\.(\\d+)-latest-${platform}-lgpl-\\1\\.\\2\\.tar\\.xz$`);
  const candidates = data.assets.flatMap((value: unknown) => {
    const asset = record(value);
    const match = typeof asset.name === "string" ? pattern.exec(asset.name) : null;
    if (!match) return [];
    return [{ asset, major: Number(match[1]), minor: Number(match[2]) }];
  }).sort((a, b) => b.major - a.major || b.minor - a.minor);

  const selected = candidates[0];
  if (!selected) throw new Error(`No stable Linux ${architecture} FFmpeg release-branch build is available`);
  const { asset, major, minor } = selected;
  const name = asset.name as string;
  if (asset.browser_download_url !== RELEASE_PREFIX + name) throw new Error("Unexpected FFmpeg publisher download URL");
  if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) {
    throw new Error("FFmpeg publisher must supply an archive SHA-256 digest");
  }
  if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 1_000_000 || asset.size > 350_000_000) {
    throw new Error("FFmpeg archive size is outside the supported range");
  }
  return { name, series: `${major}.${minor}`, url: asset.browser_download_url, sha256: asset.digest.slice(7), size: asset.size };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function archivedBinarySha256(archive: string, member: string): Promise<string> {
  // The archive is independently pinned by the publisher's SHA-256. Derive the
  // expected executable hash from those bytes, never from an editable receipt.
  const tar = spawn("tar", ["-xJOf", archive, "--", member], {
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(120_000),
  });
  let stderr = "";
  tar.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const hash = createHash("sha256");
  const output = (async () => {
    for await (const chunk of tar.stdout) hash.update(chunk);
  })();
  const completed = new Promise<void>((resolve, reject) => {
    tar.once("error", reject);
    tar.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Cannot verify FFmpeg archive member ${member}: ${stderr}`));
    });
  });
  try {
    await Promise.all([output, completed]);
    return hash.digest("hex");
  } catch (error) {
    tar.kill();
    throw error;
  }
}

async function downloadArchive(fetcher: typeof fetch, url: string, destination: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(240_000) });
      if (!response.ok) {
        if (response.status !== 408 && response.status !== 429 && response.status < 500) {
          throw new Error(`FFmpeg archive download failed: HTTP ${response.status}`);
        }
        lastError = new Error(`Temporary FFmpeg archive download failure: HTTP ${response.status}`);
      } else {
        // The CDN can reset a connection after returning HTTP 200, during streaming.
        return await Bun.write(destination, response);
      }
    } catch (error) {
      // Only transient transport failures reach here; non-retryable HTTP responses
      // throw the explicit error above and must not be silently retried.
      if (error instanceof Error && /^FFmpeg archive download failed: HTTP /.test(error.message)) throw error;
      lastError = error;
    }
    await rm(destination, { force: true });
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error("FFmpeg archive download failed after 3 attempts", { cause: lastError });
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function validInstall(destination: string, asset: StableLinuxAsset): Promise<boolean> {
  if (!await present(destination)) return false;
  const receiptPath = path.join(destination, "receipt.json");
  try {
    if (!(await lstat(destination)).isDirectory()) throw new Error("not a directory");
    const receipt = record(JSON.parse(await readFile(receiptPath, "utf8")));
    if (receipt.archiveSha256 !== asset.sha256 || receipt.series !== asset.series || receipt.name !== asset.name) {
      throw new Error("cached publisher identity changed");
    }
    const archive = path.join(destination, "archive.tar.xz");
    const archiveInfo = await lstat(archive);
    if (!archiveInfo.isFile() || archiveInfo.size !== asset.size || await sha256(archive) !== asset.sha256) {
      throw new Error("cached archive failed its publisher SHA-256 check");
    }
    for (const name of ["ffmpeg", "ffprobe"] as const) {
      const binary = path.join(destination, "bin", name);
      if (!(await lstat(binary)).isFile()) throw new Error(`cached ${name} is not a regular executable`);
      const actual = await sha256(binary);
      const expected = await archivedBinarySha256(archive, `${asset.name.slice(0, -".tar.xz".length)}/bin/${name}`);
      if (actual !== receipt[`${name}Sha256`] || actual !== expected) {
        throw new Error(`cached ${name} binary failed its SHA-256 check`);
      }
    }
    return true;
  } catch (error) {
    throw new Error(`Refusing to replace invalid FFmpeg installation ${destination}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function installLatestStableFFmpeg({
  installRoot = INSTALL_ROOT,
  fetcher = fetch,
  releaseMetadata,
}: {
  /** Override only for isolated offline installer tests. */
  installRoot?: string;
  fetcher?: typeof fetch;
  /** Explicitly authenticated metadata may be resolved in a preceding CI step. */
  releaseMetadata?: unknown;
} = {}): Promise<string> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("The managed latest-stable FFmpeg installer supports Linux x64/arm64 only");
  }
  const storage = path.resolve(installRoot);
  for (const directory of [path.join(ROOT, ".artifacts"), path.join(ROOT, ".artifacts", "toolchain"), storage]) {
    if (!await present(directory)) continue;
    if (!(await lstat(directory)).isDirectory()) throw new Error(`FFmpeg tool storage must be a real directory: ${directory}`);
  }
  let published = releaseMetadata;
  if (published === undefined) {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "asset-tooling-ffmpeg-installer" };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetcher(RELEASE_API, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot resolve latest published FFmpeg build: HTTP ${response.status}`);
    published = await response.json();
  }
  const asset = selectStableLinuxAsset(published, process.arch as "x64" | "arm64");
  const destination = path.join(storage, asset.sha256);
  if (await validInstall(destination, asset)) return path.join(destination, "bin");

  await mkdir(storage, { recursive: true });
  const staging = await mkdtemp(path.join(storage, ".install-"));
  try {
    const archive = path.join(staging, "ffmpeg.tar.xz");
    if (await downloadArchive(fetcher, asset.url, archive) !== asset.size || await sha256(archive) !== asset.sha256) {
      throw new Error("FFmpeg archive length or SHA-256 does not match the publisher's release metadata");
    }

    const extracted = path.join(staging, "extracted");
    await mkdir(extracted);
    const folder = asset.name.slice(0, -".tar.xz".length);
    // Extract only the two regular executables; no other archive members may
    // create symlinks or write outside the disposable staging directory.
    const tar = spawnSync("tar", ["-xJf", archive, "-C", extracted, "--no-same-owner", "--", `${folder}/bin/ffmpeg`, `${folder}/bin/ffprobe`], { encoding: "utf8", timeout: 120_000 });
    if (tar.error) throw tar.error;
    if (tar.status !== 0) throw new Error(`FFmpeg extraction failed: ${tar.stderr}`);
    const [actualFolder, ...extra] = await readdir(extracted);
    if (actualFolder !== folder || extra.length !== 0 ||
        !(await lstat(path.join(extracted, folder))).isDirectory() ||
        !(await lstat(path.join(extracted, folder, "bin"))).isDirectory()) {
      throw new Error("Unexpected FFmpeg publisher archive layout");
    }

    const payload = path.join(staging, "payload");
    await mkdir(path.join(payload, "bin"), { recursive: true });
    const receipt: Record<string, string> = { archiveSha256: asset.sha256, series: asset.series, name: asset.name };
    for (const name of ["ffmpeg", "ffprobe"] as const) {
      const source = path.join(extracted, folder, "bin", name);
      if (!(await lstat(source)).isFile()) throw new Error(`FFmpeg archive has no regular ${name} executable`);
      const binary = path.join(payload, "bin", name);
      await copyFile(source, binary);
      await chmod(binary, 0o755);
      receipt[`${name}Sha256`] = await sha256(binary);
    }
    // Keep the verified archive so future cache hits can independently prove
    // that both executables are the exact publisher-provided bytes.
    await rename(archive, path.join(payload, "archive.tar.xz"));
    await writeFile(path.join(payload, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    // Another installer may have finished while this archive was being verified.
    if (await validInstall(destination, asset)) return path.join(destination, "bin");
    await rename(payload, destination);
    return path.join(destination, "bin");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--release-metadata")) {
    throw new Error("usage: bun scripts/install-ffmpeg.ts [--release-metadata <json-file>]");
  }
  const releaseMetadata = args.length === 2 ? JSON.parse(await readFile(args[1]!, "utf8")) : undefined;
  const bin = await installLatestStableFFmpeg({ releaseMetadata });
  const receipt = record(JSON.parse(await readFile(path.join(bin, "..", "receipt.json"), "utf8")));
  // Keep stdout machine-readable for PATH setup; identity is diagnostic stderr.
  console.error(`FFmpeg stable branch n${receipt.series}, archive sha256:${receipt.archiveSha256}`);
  console.log(bin);
}
