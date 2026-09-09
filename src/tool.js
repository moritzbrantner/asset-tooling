import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { sha256File, sha256Text } from "./hash.js";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));

async function sourceFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(absolute, relative)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push({ relative, absolute });
    }
  }
  return files;
}

export async function captureToolIdentity() {
  const files = await sourceFiles(SOURCE_ROOT);
  const sourceHashes = {};
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
