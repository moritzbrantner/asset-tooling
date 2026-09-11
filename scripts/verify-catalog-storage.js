import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAssetCatalog } from "../src/catalog.js";
import {
  createAssetCatalogStorageManifest,
  verifyAssetCatalogStorageBytes,
} from "../src/catalog-storage.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function walkFiles(directory, prefix = "") {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolute, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`canonical asset path '${relative}' must be a regular file`);
  }
  return files.sort();
}

const providersDocument = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8"));
const sourcesDocument = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8"));
const storageDocument = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const catalog = createAssetCatalog({
  providers: providersDocument.providers,
  sources: sourcesDocument.sources,
});
const storage = createAssetCatalogStorageManifest({ catalog, entries: storageDocument.entries });

const expectedFiles = storage.entries.map(({ path: storagePath }) =>
  storagePath.replace(/^assets\/canonical\//, ""),
);
const actualFiles = await walkFiles(path.join(root, "assets", "canonical"));
if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
  throw new Error(
    `assets/canonical must match catalog/storage.json exactly; expected ${JSON.stringify(expectedFiles.sort())}, got ${JSON.stringify(actualFiles)}`,
  );
}

for (const entry of storage.entries) {
  const { stdout } = await execFileAsync("git", ["check-attr", "filter", "--", entry.path], { cwd: root });
  if (!stdout.trim().endsWith(": filter: lfs")) {
    throw new Error(`catalog storage path '${entry.path}' is not tracked by Git LFS`);
  }
  const bytes = await readFile(path.join(root, ...entry.path.split("/")));
  verifyAssetCatalogStorageBytes(catalog, entry, bytes);
}

process.stdout.write(
  `${JSON.stringify({ status: "valid", storage: "git-lfs", hydratedEntries: storage.entries.length })}\n`,
);
