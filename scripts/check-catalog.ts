import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAssetCatalog, isAssetCatalogSourcePinned } from "../src/catalog.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function assertDocument(value, key, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  const allowedKeys = new Set(["schemaVersion", key]);
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.size || keys.some((candidate) => !allowedKeys.has(candidate))) {
    throw new Error(`${location} must contain only schemaVersion and ${key}`);
  }
  if (value.schemaVersion !== 1) throw new Error(`${location}.schemaVersion must be 1`);
  if (!Array.isArray(value[key])) throw new Error(`${location}.${key} must be an array`);
  return value[key];
}

const providersDocument = JSON.parse(await readFile(path.join(root, "catalog/providers.json"), "utf8"));
const sourcesDocument = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8"));
const providers = assertDocument(providersDocument, "providers", "catalog/providers.json");
const sources = assertDocument(sourcesDocument, "sources", "catalog/sources.json");
const catalog = createAssetCatalog({ providers, sources });

console.log(
  JSON.stringify({
    status: "valid",
    providers: catalog.listProviders().map(({ id }) => id),
    sources: catalog.listSources().map((source) => ({
      id: source.id,
      pinned: isAssetCatalogSourcePinned(source),
      provider: source.provider,
      license: source.license.spdx,
    })),
  }),
);
