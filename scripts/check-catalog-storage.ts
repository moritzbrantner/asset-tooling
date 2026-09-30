import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAssetCatalog } from "../src/catalog.js";
import { createAssetCatalogStorageManifest } from "../src/catalog-storage.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function assertDocument(value, key, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [key, "schemaVersion"].sort();
  if (keys.length !== 2 || keys.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${location} must contain only schemaVersion and ${key}`);
  }
  if (value.schemaVersion !== 1) throw new Error(`${location}.schemaVersion must be 1`);
  if (!Array.isArray(value[key])) throw new Error(`${location}.${key} must be an array`);
  return value[key];
}

const providersDocument = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8"));
const sourcesDocument = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8"));
const storageDocument = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const catalog = createAssetCatalog({
  providers: assertDocument(providersDocument, "providers", "catalog/providers.json"),
  sources: assertDocument(sourcesDocument, "sources", "catalog/sources.json"),
});
const storage = createAssetCatalogStorageManifest({
  catalog,
  entries: assertDocument(storageDocument, "entries", "catalog/storage.json"),
});

process.stdout.write(
  `${JSON.stringify({
    status: "valid",
    storage: "git-lfs",
    entries: storage.entries.map(({ sourceId, path: storagePath }) => ({ sourceId, path: storagePath })),
  })}\n`,
);
