import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { sha256File, sha256Text } from "./hash.js";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));

interface SourceFile {
  relative: string;
  absolute: string;
}

export interface ToolIdentity {
  name: "asset-tooling";
  version: "0.1.0";
  sourceFingerprint: {
    algorithm: "sha256-tree-v1";
    sha256: string;
  };
}

async function sourceFiles(directory: string, prefix = ""): Promise<SourceFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries.sort((left, right) => compareCodeUnitStrings(left.name, right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(absolute, relative)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push({ relative, absolute });
    }
  }
  return files;
}

export async function captureToolIdentity(): Promise<ToolIdentity> {
  const files = await sourceFiles(SOURCE_ROOT);
  const sourceHashes: Record<string, string> = {};
  for (const file of files) {
    sourceHashes[file.relative] = await sha256File(file.absolute);
  }
  return {
    name: "asset-tooling",
    version: "0.1.0",
    sourceFingerprint: {
      algorithm: "sha256-tree-v1",
      sha256: sha256Text(canonicalJson(sourceHashes)),
    },
  };
}

/** The package root, against which a backend names its generation-cache sources. */
const PACKAGE_ROOT = path.dirname(SOURCE_ROOT);

export interface ScopedToolIdentity {
  name: "asset-tooling";
  version: "0.1.0";
  sourceFingerprint: {
    algorithm: "sha256-files-v1";
    sha256: string;
  };
}

/**
 * The tool identity of a generation-cache key scoped to the files that determine one backend's output
 * (docs/cache.md#build-identity): the SHA-256 of each named package-relative file, by path. A missing file fails
 * closed. Receipts and `verify` keep the whole-tree identity of {@link captureToolIdentity}.
 */
export async function captureScopedToolIdentity(files: readonly string[], root: string = PACKAGE_ROOT): Promise<ScopedToolIdentity> {
  const sourceHashes: Record<string, string> = {};
  for (const file of [...files].sort(compareCodeUnitStrings)) {
    if (path.posix.isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`generation-cache source '${file}' must be a package-relative path`);
    }
    sourceHashes[file] = await sha256File(path.join(root, ...file.split("/")));
  }
  return {
    name: "asset-tooling",
    version: "0.1.0",
    sourceFingerprint: {
      algorithm: "sha256-files-v1",
      sha256: sha256Text(canonicalJson(sourceHashes)),
    },
  };
}
