import { canonicalJson } from "./canonical.js";
import { sha256Bytes } from "./hash.js";
import { storeAssetObject } from "./asset-store.js";

const TOKEN_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SPDX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const DISTRIBUTIONS = new Set(["shared", "project-local", "manual-review"]);

function isObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function assertToken(value, location) {
  const token = assertNonEmptyString(value, location);
  if (!TOKEN_PATTERN.test(token)) throw new Error(`${location} must be a lowercase dotted token`);
  return token;
}

function assertMediaType(value, location) {
  const mediaType = assertNonEmptyString(value, location);
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new Error(`${location} must be a lowercase concrete media type`);
  }
  return mediaType;
}

function assertHttpsUrl(value, location) {
  const text = assertNonEmptyString(value, location);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${location} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${location} must be an absolute HTTPS URL`);
  return parsed.href;
}

function assertSpdx(value, location) {
  const spdx = assertNonEmptyString(value, location);
  if (!SPDX_PATTERN.test(spdx)) throw new Error(`${location} must be a simple SPDX license identifier`);
  return spdx;
}

function canonicalClone(value, location) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new Error(`${location} must contain canonical JSON data: ${error.message}`);
  }
}

function normalizeStringList(value, location, validator = assertNonEmptyString) {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const normalized = value.map((entry, index) => validator(entry, `${location}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${location} must not contain duplicates`);
  return [...normalized].sort();
}

function normalizeSourceLocator(value) {
  const source = assertObject(value, "catalog source.source");
  assertExactKeys(
    source,
    new Set(["url", "upstreamId", "revision", "path", "sha256", "byteLength"]),
    "catalog source.source",
  );
  const normalized = { url: assertHttpsUrl(source.url, "catalog source.source.url") };
  if (source.upstreamId !== undefined) {
    normalized.upstreamId = assertNonEmptyString(source.upstreamId, "catalog source.source.upstreamId");
  }
  if (source.revision !== undefined) {
    normalized.revision = assertNonEmptyString(source.revision, "catalog source.source.revision");
  }
  if (source.path !== undefined) {
    normalized.path = assertNonEmptyString(source.path, "catalog source.source.path");
  }

  const hasSha = source.sha256 !== undefined;
  const hasLength = source.byteLength !== undefined;
  if (hasSha !== hasLength) {
    throw new Error("catalog source.source sha256 and byteLength must be declared together");
  }
  if (hasSha) {
    if (!SHA256_PATTERN.test(source.sha256)) {
      throw new Error("catalog source.source.sha256 must be a lowercase 64-character SHA-256 digest");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
      throw new Error("catalog source.source.byteLength must be a non-negative safe integer");
    }
    normalized.sha256 = source.sha256;
    normalized.byteLength = source.byteLength;
  }
  return normalized;
}

function normalizeLicense(value) {
  const license = assertObject(value, "catalog source.license");
  assertExactKeys(license, new Set(["spdx", "evidenceUrl", "attribution"]), "catalog source.license");
  const normalized = {
    spdx: assertSpdx(license.spdx, "catalog source.license.spdx"),
    evidenceUrl: assertHttpsUrl(license.evidenceUrl, "catalog source.license.evidenceUrl"),
  };
  if (license.attribution !== undefined) {
    normalized.attribution = assertNonEmptyString(license.attribution, "catalog source.license.attribution");
  }
  if (normalized.spdx !== "CC0-1.0" && normalized.attribution === undefined) {
    throw new Error("non-CC0 catalog sources must carry explicit attribution text");
  }
  return normalized;
}

export function createAssetCatalogProvider(value) {
  const provider = assertObject(value, "catalog provider");
  assertExactKeys(
    provider,
    new Set(["schemaVersion", "id", "label", "homepage", "distribution", "acceptedLicenses"]),
    "catalog provider",
  );
  if ((provider.schemaVersion ?? 1) !== 1) throw new Error("catalog provider schemaVersion must be 1");
  if (!DISTRIBUTIONS.has(provider.distribution)) {
    throw new Error("catalog provider distribution must be shared, project-local, or manual-review");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: assertToken(provider.id, "catalog provider.id"),
    label: assertNonEmptyString(provider.label, "catalog provider.label"),
    homepage: assertHttpsUrl(provider.homepage, "catalog provider.homepage"),
    distribution: provider.distribution,
    acceptedLicenses: Object.freeze(
      normalizeStringList(provider.acceptedLicenses, "catalog provider.acceptedLicenses", assertSpdx),
    ),
  });
}

export function createAssetCatalogSource(value) {
  const source = assertObject(value, "catalog source");
  assertExactKeys(
    source,
    new Set(["schemaVersion", "id", "provider", "title", "kind", "mediaType", "source", "license", "tags", "metadata"]),
    "catalog source",
  );
  if ((source.schemaVersion ?? 1) !== 1) throw new Error("catalog source schemaVersion must be 1");
  const metadata = canonicalClone(source.metadata ?? {}, "catalog source.metadata");
  if (!isObject(metadata)) throw new Error("catalog source.metadata must be an object");
  return Object.freeze({
    schemaVersion: 1,
    id: assertToken(source.id, "catalog source.id"),
    provider: assertToken(source.provider, "catalog source.provider"),
    title: assertNonEmptyString(source.title, "catalog source.title"),
    kind: assertToken(source.kind, "catalog source.kind"),
    mediaType: assertMediaType(source.mediaType, "catalog source.mediaType"),
    source: Object.freeze(normalizeSourceLocator(source.source)),
    license: Object.freeze(normalizeLicense(source.license)),
    tags: Object.freeze(normalizeStringList(source.tags ?? [], "catalog source.tags", assertToken)),
    metadata: Object.freeze(metadata),
  });
}

export function isAssetCatalogSourcePinned(value) {
  const source = createAssetCatalogSource(value);
  return source.source.sha256 !== undefined && source.source.byteLength !== undefined;
}

export function inspectAssetCatalogSourceBytes(value, bytesValue) {
  const source = createAssetCatalogSource(value);
  if (!Buffer.isBuffer(bytesValue) && !(bytesValue instanceof Uint8Array)) {
    throw new Error("catalog source bytes must be a Buffer or Uint8Array");
  }
  const bytes = Buffer.from(bytesValue);
  const sha256 = sha256Bytes(bytes);
  const byteLength = bytes.byteLength;
  if (source.source.sha256 !== undefined && source.source.sha256 !== sha256) {
    throw new Error(`catalog source '${source.id}' hash mismatch: expected ${source.source.sha256}, got ${sha256}`);
  }
  if (source.source.byteLength !== undefined && source.source.byteLength !== byteLength) {
    throw new Error(
      `catalog source '${source.id}' byte length mismatch: expected ${source.source.byteLength}, got ${byteLength}`,
    );
  }
  return createAssetCatalogSource({
    ...source,
    source: { ...source.source, sha256, byteLength },
  });
}

export function createAssetCatalog({ providers, sources }) {
  if (!Array.isArray(providers)) throw new Error("catalog providers must be an array");
  if (!Array.isArray(sources)) throw new Error("catalog sources must be an array");

  const providerMap = new Map();
  for (const value of providers) {
    const provider = createAssetCatalogProvider(value);
    if (providerMap.has(provider.id)) throw new Error(`catalog provider '${provider.id}' is already registered`);
    providerMap.set(provider.id, provider);
  }

  const sourceMap = new Map();
  for (const value of sources) {
    const source = createAssetCatalogSource(value);
    if (!providerMap.has(source.provider)) {
      throw new Error(`catalog source '${source.id}' references unknown provider '${source.provider}'`);
    }
    if (sourceMap.has(source.id)) throw new Error(`catalog source '${source.id}' is already registered`);
    sourceMap.set(source.id, source);
  }

  const listProviders = () => [...providerMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const listSources = () => [...sourceMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    getProvider(id) {
      return providerMap.get(id);
    },
    getSource(id) {
      return sourceMap.get(id);
    },
    listProviders,
    listSources,
  });
}

export function assertAssetCatalogSourceReusable(catalog, id) {
  if (!catalog || typeof catalog.getSource !== "function" || typeof catalog.getProvider !== "function") {
    throw new Error("catalog must be created by createAssetCatalog");
  }
  const source = catalog.getSource(id);
  if (!source) throw new Error(`catalog source '${id}' is not registered`);
  const provider = catalog.getProvider(source.provider);
  if (provider.distribution !== "shared") {
    throw new Error(
      `catalog source '${id}' provider '${provider.id}' is ${provider.distribution} and cannot enter the shared canonical store`,
    );
  }
  if (!provider.acceptedLicenses.includes(source.license.spdx)) {
    throw new Error(
      `catalog source '${id}' license '${source.license.spdx}' is not accepted for provider '${provider.id}'`,
    );
  }
  if (!isAssetCatalogSourcePinned(source)) {
    throw new Error(`catalog source '${id}' must be content-pinned before canonical import`);
  }
  return source;
}

export async function importAssetCatalogSource(root, catalog, id, bytesValue) {
  const source = assertAssetCatalogSourceReusable(catalog, id);
  const pinned = inspectAssetCatalogSourceBytes(source, bytesValue);
  const metadata = {
    catalog: {
      id: pinned.id,
      provider: pinned.provider,
      title: pinned.title,
      source: pinned.source,
      license: pinned.license,
      tags: pinned.tags,
      metadata: pinned.metadata,
    },
  };
  return storeAssetObject(root, {
    bytes: Buffer.from(bytesValue),
    kind: pinned.kind,
    mediaType: pinned.mediaType,
    metadata,
  });
}
