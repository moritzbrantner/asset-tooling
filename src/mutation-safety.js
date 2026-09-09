import path from "node:path";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeIfChanged(filePath, bytes) {
  if (await fileExists(filePath)) {
    const current = await readFile(filePath);
    if (current.equals(Buffer.from(bytes))) return false;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return true;
}

async function filesystemIdentity(filePath) {
  let resolved;
  let inode;
  try {
    resolved = await realpath(filePath);
    const metadata = await stat(filePath);
    inode = `${metadata.dev}:${metadata.ino}`;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    const parent = path.dirname(filePath);
    if (parent === filePath) throw error;
    const parentIdentity = await filesystemIdentity(parent);
    resolved = path.join(parentIdentity.canonicalPath, path.basename(filePath));
  }
  const canonicalPath = process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
  return { canonicalPath, inode };
}

async function assertNoSymbolicLinks(root, portablePath, description) {
  let prefix = root;
  for (const segment of portablePath.split("/")) {
    prefix = path.join(prefix, segment);
    try {
      if ((await lstat(prefix)).isSymbolicLink()) {
        throw new Error(`${description} must not contain symbolic links`);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") break;
      throw error;
    }
  }
}

async function assertFileOrMissing(filePath, description) {
  try {
    if (!(await lstat(filePath)).isFile()) {
      throw new Error(`${description} must be a regular file or a missing path`);
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertSafeMutationPaths({
  root,
  specAbsolutePath,
  specDescription,
  outputPortablePath,
  receiptPortablePath,
  resolvePortablePath,
  protectedArtifacts = [],
}) {
  const outputAbsolutePath = resolvePortablePath(root, outputPortablePath);
  const receiptAbsolutePath = resolvePortablePath(root, receiptPortablePath);
  await assertNoSymbolicLinks(root, outputPortablePath, "output path");
  await assertNoSymbolicLinks(root, receiptPortablePath, "receipt path");
  await assertFileOrMissing(outputAbsolutePath, "output path");
  await assertFileOrMissing(receiptAbsolutePath, "receipt path");

  const protectedPaths = [
    { absolutePath: specAbsolutePath, description: specDescription },
    ...protectedArtifacts,
  ];
  const outputIdentity = await filesystemIdentity(outputAbsolutePath);
  const receiptIdentity = await filesystemIdentity(receiptAbsolutePath);

  for (const { absolutePath: protectedPath, description } of protectedPaths) {
    const protectedIdentity = await filesystemIdentity(protectedPath);
    if (
      protectedIdentity.canonicalPath === outputIdentity.canonicalPath ||
      (protectedIdentity.inode !== undefined && protectedIdentity.inode === outputIdentity.inode)
    ) {
      throw new Error(`output path must not collide with ${description}`);
    }
    if (
      protectedIdentity.canonicalPath === receiptIdentity.canonicalPath ||
      (protectedIdentity.inode !== undefined && protectedIdentity.inode === receiptIdentity.inode)
    ) {
      throw new Error(`receipt path must not collide with ${description}`);
    }
  }

  if (
    (outputIdentity.inode !== undefined && outputIdentity.inode === receiptIdentity.inode) ||
    pathsOverlap(outputIdentity.canonicalPath, receiptIdentity.canonicalPath) ||
    pathsOverlap(receiptIdentity.canonicalPath, outputIdentity.canonicalPath)
  ) {
    throw new Error("output and receipt paths must not contain one another");
  }

  return { outputAbsolutePath, receiptAbsolutePath };
}
