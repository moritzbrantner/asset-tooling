import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { inspectAssetCatalogSourceBytes, isAssetCatalogArchiveMember } from "./catalog.js";
import { extractZipMember } from "./catalog-zip.js";

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

async function fetchSourceBytes(source, fetchImpl) {
  const response = await fetchImpl(source.source.url, {
    redirect: "follow",
    headers: { "user-agent": "asset-tooling-catalog-acquisition/1" },
  });
  if (!response || response.ok !== true) {
    const status = response && Number.isInteger(response.status) ? ` (${response.status})` : "";
    throw new Error(`failed to acquire catalog source '${source.id}'${status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// Local-file mode (Atlas Decision 6.1.1): the owner downloaded the source once,
// so its bytes come from an absolute path instead of the network. The path is
// checked before anything is written or fetched.
export async function assertAssetCatalogLocalFile(localFile) {
  if (typeof localFile !== "string" || localFile.length === 0) {
    throw new Error("localFile must be a non-empty absolute path");
  }
  if (!path.isAbsolute(localFile)) {
    throw new Error(`localFile must be an absolute path, received '${localFile}'`);
  }
  let info;
  try {
    info = await stat(localFile);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`localFile '${localFile}' does not exist`);
    throw error;
  }
  if (!info.isFile()) throw new Error(`localFile '${localFile}' is not a regular file`);
}

function sourceBytes(source, { fetchImpl, localFile }) {
  return localFile === undefined ? fetchSourceBytes(source, fetchImpl) : readFile(localFile);
}

async function writeEvidence(destinationRoot, pinnedSource, fileName, bytes) {
  const sourceDirectory = path.resolve(destinationRoot, pinnedSource.id);
  const filePath = path.join(sourceDirectory, fileName);
  const pinPath = `${filePath}.pin.json`;
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(filePath, bytes);
  await writeFile(pinPath, `${canonicalJson(pinnedSource)}\n`, "utf8");
  return { filePath, pinPath };
}

// Fetches the archive once (or reads it from the local file), verifies its pin when present, extracts exactly
// one member and verifies the member pin. The archive and its measured pin are
// written as disposable evidence next to the member; nothing is written for a
// member that fails extraction or its pin.
async function acquireArchiveMember({ catalog, source, destinationRoot, fetchImpl, localFile }) {
  const archive = catalog.getSource(source.archiveMember.archive);
  if (!archive) {
    throw new Error(`catalog source '${source.id}' references unregistered archive '${source.archiveMember.archive}'`);
  }
  const archiveBytes = await sourceBytes(archive, { fetchImpl, localFile });
  const pinnedArchive = inspectAssetCatalogSourceBytes(archive, archiveBytes);
  const memberBytes = extractZipMember(archiveBytes, source.archiveMember.path);
  const pinnedMember = inspectAssetCatalogSourceBytes(source, memberBytes);

  const archiveFileName = assertSafeFilename(archive.source.path ?? new URL(archive.source.url).pathname);
  const archiveEvidence = await writeEvidence(destinationRoot, pinnedArchive, archiveFileName, archiveBytes);
  const memberFileName = assertSafeFilename(path.posix.basename(source.archiveMember.path));
  const { filePath, pinPath } = await writeEvidence(destinationRoot, pinnedMember, memberFileName, memberBytes);

  return Object.freeze({
    sourceId: pinnedMember.id,
    filePath,
    pinPath,
    sha256: pinnedMember.source.sha256,
    byteLength: pinnedMember.source.byteLength,
    archive: Object.freeze({
      sourceId: pinnedArchive.id,
      filePath: archiveEvidence.filePath,
      pinPath: archiveEvidence.pinPath,
      sha256: pinnedArchive.source.sha256,
      byteLength: pinnedArchive.source.byteLength,
    }),
  });
}

export async function acquireAssetCatalogSource({
  catalog,
  sourceId,
  destinationRoot,
  fetchImpl = fetch,
  localFile,
}) {
  assertCatalog(catalog);
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new Error("sourceId must be a non-empty string");
  }
  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) {
    throw new Error("destinationRoot must be a non-empty string");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");
  if (localFile !== undefined) await assertAssetCatalogLocalFile(localFile);

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

  if (isAssetCatalogArchiveMember(source)) {
    return acquireArchiveMember({ catalog, source, destinationRoot, fetchImpl, localFile });
  }

  const bytes = await sourceBytes(source, { fetchImpl, localFile });
  const pinnedSource = inspectAssetCatalogSourceBytes(source, bytes);
  const fileName = assertSafeFilename(source.source.path ?? new URL(source.source.url).pathname);
  const { filePath, pinPath } = await writeEvidence(destinationRoot, pinnedSource, fileName, bytes);

  return Object.freeze({
    sourceId: pinnedSource.id,
    filePath,
    pinPath,
    sha256: pinnedSource.source.sha256,
    byteLength: pinnedSource.source.byteLength,
  });
}
