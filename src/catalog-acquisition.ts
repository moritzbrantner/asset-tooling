import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { inspectAssetCatalogSourceBytes } from "./catalog.js";

function assertCatalog(catalog) {
  if (!catalog || typeof catalog.getSource !== "function" || typeof catalog.getProvider !== "function") {
    throw new Error("catalog must be created by createAssetCatalog");
  }
}

function assertSafeFilename(value) {
  const filename = path.basename(value);
  if (!filename || filename === "." || filename === "..") {
    throw new Error("catalog source must provide a usable file path");
  }
  return filename;
}

export async function acquireAssetCatalogSource({
  catalog,
  sourceId,
  destinationRoot,
  fetchImpl = fetch,
}) {
  assertCatalog(catalog);
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new Error("sourceId must be a non-empty string");
  }
  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) {
    throw new Error("destinationRoot must be a non-empty string");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");

  const source = catalog.getSource(sourceId);
  if (!source) throw new Error(`catalog source '${sourceId}' is not registered`);

  const provider = catalog.getProvider(source.provider);
  if (!provider) throw new Error(`catalog source '${sourceId}' references unknown provider '${source.provider}'`);
  if (provider.distribution !== "shared") {
    throw new Error(
      `catalog source '${sourceId}' provider '${provider.id}' is ${provider.distribution} and cannot be acquired as shared evidence`,
    );
  }
  if (!provider.acceptedLicenses.includes(source.license.spdx)) {
    throw new Error(
      `catalog source '${sourceId}' license '${source.license.spdx}' is not accepted for provider '${provider.id}'`,
    );
  }

  const response = await fetchImpl(source.source.url, {
    redirect: "follow",
    headers: { "user-agent": "asset-tooling-catalog-acquisition/1" },
  });
  if (!response || response.ok !== true) {
    const status = response && Number.isInteger(response.status) ? ` (${response.status})` : "";
    throw new Error(`failed to acquire catalog source '${sourceId}'${status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const pinnedSource = inspectAssetCatalogSourceBytes(source, bytes);
  const fileName = assertSafeFilename(source.source.path ?? new URL(source.source.url).pathname);
  const sourceDirectory = path.resolve(destinationRoot, source.id);
  const filePath = path.join(sourceDirectory, fileName);
  const pinPath = `${filePath}.pin.json`;

  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(filePath, bytes);
  await writeFile(pinPath, `${canonicalJson(pinnedSource)}\n`, "utf8");

  return Object.freeze({
    sourceId: pinnedSource.id,
    filePath,
    pinPath,
    sha256: pinnedSource.source.sha256,
    byteLength: pinnedSource.source.byteLength,
  });
}
