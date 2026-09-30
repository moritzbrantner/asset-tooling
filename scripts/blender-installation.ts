import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

type Release = { url: string; sha256: string; executable: string };

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function treeIdentity(root: string, directory = root): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const filePath = path.join(directory, name);
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      const target = await readlink(filePath);
      const resolved = path.relative(root, path.resolve(directory, target));
      if (path.isAbsolute(resolved) || resolved === ".." || resolved.startsWith(`..${path.sep}`)) {
        throw new Error(`Blender installation link escapes its tree: ${relative}`);
      }
      entries.push(JSON.stringify([relative, "link", target]));
    } else if (stat.isDirectory()) {
      entries.push(JSON.stringify([relative, "directory"]));
      entries.push(...await treeIdentity(root, filePath));
    } else if (stat.isFile()) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(filePath)) hash.update(chunk);
      entries.push(JSON.stringify([relative, "file", stat.mode & 0o111, hash.digest("hex")]));
    } else {
      throw new Error(`Unsupported Blender installation entry: ${relative}`);
    }
  }
  return entries;
}

export async function installPinnedBlender(installDirectory: string, release: Release): Promise<string> {
  const destination = path.resolve(installDirectory);
  for (const protectedPath of [process.cwd(), os.homedir()]) {
    const relative = path.relative(destination, protectedPath);
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
      throw new Error("Blender installation destination must not contain the workspace or home directory");
    }
  }
  if (!/^[0-9a-f]{64}$/.test(release.sha256)) throw new Error("Blender archive pin must be a SHA-256");
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(release.executable) || release.executable.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Blender executable must be a portable relative path");
  }
  const executable = path.join(destination, release.executable);
  const present = await exists(destination);
  if (present && (!(await lstat(destination)).isDirectory() || !await exists(executable))) {
    throw new Error("Refusing to replace a destination that is not a Blender installation");
  }
  const cache = path.join(os.tmpdir(), `asset-tooling-blender-${release.sha256}.archive`);
  let bytes: Buffer;
  if (await exists(cache)) {
    bytes = await readFile(cache);
  } else {
    const response = await fetch(release.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Blender download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== release.sha256) throw new Error(`Blender archive sha256 ${actual} does not match pinned ${release.sha256}`);
  // Cache only verified archive bytes; installations and cache entries never establish trust.
  if (!await exists(cache)) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-blender-cache-"));
    try {
      await writeFile(path.join(temporary, "archive"), bytes);
      await rename(path.join(temporary, "archive"), cache);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), ".blender-install-"));
  const payload = path.join(staging, "payload");
  try {
    await mkdir(payload);
    const archive = path.join(staging, "archive");
    await writeFile(archive, bytes);
    const extraction = spawnSync("tar", ["-xf", archive, "-C", payload], { encoding: "utf8", timeout: 120_000 });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) throw new Error(`Blender archive extraction failed: ${extraction.stderr}`);
    if (!await exists(path.join(payload, release.executable))) throw new Error("Blender archive does not contain its declared executable");
    const expected = await treeIdentity(payload);
    if (present && JSON.stringify(await treeIdentity(destination)) === JSON.stringify(expected)) return executable;
    const previous = path.join(staging, "previous");
    if (present) await rename(destination, previous);
    try {
      await rename(payload, destination);
    } catch (error) {
      if (present) await rename(previous, destination);
      throw error;
    }
    return executable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
