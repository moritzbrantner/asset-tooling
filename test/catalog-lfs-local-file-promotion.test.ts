// Acceptance tests for local-file canonical LFS promotion (#109, slice 1).
// Contract: Atlas Decision 6.1.1 (docs/decisions/atlas.md) and the owner
// answers on #109: `catalog:lfs:promote -- <id> --from <file>` promotes bytes
// the owner downloaded once. The SHA-256 and byte-length pin is authoritative,
// the record keeps its page URL / upload id as provenance, and archive-member
// extraction is unchanged.
//
// Library interface under test: `prepareAssetCatalogLfsPromotion` and
// `applyAssetCatalogLfsPromotion` accept an optional absolute `localFile`.
// For a whole source the file holds the source bytes; for an archive member it
// holds the ARCHIVE bytes. `fetchImpl` is never called in local-file mode.
//
// No test touches the network. Every repository root and fixture zip is
// temporary. CLI tests only exercise argument handling that cannot mutate the
// real repository (the script resolves its repository root from its own
// location, so every CLI invocation uses an unregistered source id).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { sha256Bytes } from "../src/hash.js";
import {
  applyAssetCatalogLfsPromotion,
  prepareAssetCatalogLfsPromotion,
} from "../src/catalog-lfs-promotion.js";

// ---------------------------------------------------------------------------
// Minimal zip writer (stored / deflate), same layout as catalog-archive-members.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const UNIX_REGULAR_FILE = (0o100644 << 16) >>> 0;
const UNIX_DIRECTORY = ((0o040755 << 16) | 0x10) >>> 0;
const MADE_BY_UNIX = (3 << 8) | 20;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? Buffer.alloc(0));
    const method = entry.method ?? 8;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.byteLength, 18);
    lh.writeUInt32LE(data.byteLength, 22);
    lh.writeUInt16LE(name.byteLength, 26);
    lh.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([lh, name, payload]);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(MADE_BY_UNIX, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.byteLength, 20);
    ch.writeUInt32LE(data.byteLength, 24);
    ch.writeUInt16LE(name.byteLength, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((entry.externalAttributes ?? UNIX_REGULAR_FILE) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));

    locals.push(localRecord);
    offset += localRecord.byteLength;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

// ---------------------------------------------------------------------------
// Catalog fixtures: an itch.io-style record whose URL is a page, not a payload.
// ---------------------------------------------------------------------------

const PROVIDER = {
  schemaVersion: 1,
  id: "example-shared",
  label: "Example Shared",
  homepage: "https://example.itch.io",
  distribution: "shared",
  acceptedLicenses: ["CC0-1.0"],
};
const PROVIDERS_DOCUMENT = { schemaVersion: 1, providers: [PROVIDER] };
const LICENSE = { spdx: "CC0-1.0", evidenceUrl: "https://example.itch.io/pack/license" };

const PAGE_URL = "https://example.itch.io/universal-pack";
const UPSTREAM_ID = "15861669";
const REVISION = "upload-15861669";

const MODEL_ID = "example.model";
const MODEL_BYTES = Buffer.from("downloaded model bytes from a signed URL", "utf8");

const ARCHIVE_ID = "example.pack";
const MEMBER_ID = "example.pack.body-gltf";
const MEMBER_PATH = "Pack[Standard]/glTF/Body.gltf";
const MEMBER_BYTES = Buffer.from('{"asset":{"version":"2.0"},"body":true}\n'.repeat(8), "utf8");
const SIBLING_BYTES = Buffer.from("sibling buffer bytes", "utf8");

function modelRecord(pin = {}) {
  return {
    schemaVersion: 1,
    id: MODEL_ID,
    provider: PROVIDER.id,
    title: "Example Model",
    kind: "mesh",
    mediaType: "model/gltf-binary",
    source: { url: PAGE_URL, upstreamId: UPSTREAM_ID, revision: REVISION, path: "model.glb", ...pin },
    license: { ...LICENSE },
    tags: ["testing"],
  };
}

function archiveRecord(pin = {}) {
  return {
    schemaVersion: 1,
    id: ARCHIVE_ID,
    provider: PROVIDER.id,
    title: "Example pack",
    kind: "asset-pack",
    mediaType: "application/zip",
    source: { url: PAGE_URL, upstreamId: UPSTREAM_ID, revision: REVISION, path: "pack.zip", ...pin },
    license: { ...LICENSE },
    tags: ["testing"],
  };
}

function memberRecord(pin = {}) {
  return {
    schemaVersion: 2,
    id: MEMBER_ID,
    provider: PROVIDER.id,
    title: "Example pack - body (glTF)",
    kind: "mesh",
    mediaType: "model/gltf+json",
    archiveMember: { archive: ARCHIVE_ID, path: MEMBER_PATH },
    source: { ...pin },
    license: { ...LICENSE },
    tags: ["gltf"],
  };
}

function standardArchive(memberData = MEMBER_BYTES) {
  return zip([
    { name: "Pack[Standard]/", data: Buffer.alloc(0), method: 0, externalAttributes: UNIX_DIRECTORY },
    { name: "Pack[Standard]/glTF/Body.bin", data: SIBLING_BYTES, method: 0 },
    { name: MEMBER_PATH, data: memberData, method: 8 },
  ]);
}

function pinOf(bytes) {
  return { sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
}

function sourcesDocument(sources) {
  return { schemaVersion: 1, sources };
}

const EMPTY_STORAGE = { schemaVersion: 1, entries: [] };

// A fetch spy that fails the test if local-file mode ever reaches the network.
function forbiddenFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    throw new Error(`fetch must not be called in local-file mode (requested ${url})`);
  };
  return { fetchImpl, calls };
}

function serve(bytes) {
  return async (url) => {
    if (url !== PAGE_URL) throw new Error(`unexpected fetch of ${url}`);
    return new Response(bytes, { status: 200 });
  };
}

async function repository(sources, storage = EMPTY_STORAGE) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-local-file-test-"));
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await writeFile(path.join(root, "catalog", "sources.json"), `${JSON.stringify(sourcesDocument(sources), null, 2)}\n`);
  await writeFile(path.join(root, "catalog", "storage.json"), `${JSON.stringify(storage, null, 2)}\n`);
  return root;
}

// The download lives outside the repository root, as an owner's ~/Downloads would.
async function downloadedFile(name, bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-local-file-download-"));
  const filePath = path.join(directory, name);
  await writeFile(filePath, bytes);
  return { directory, filePath };
}

async function listFiles(root) {
  const found = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else found.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return found.sort();
}

// What a promotion is allowed to change: catalog documents and canonical payloads.
async function snapshot(root) {
  const canonical = {};
  for (const file of await listFiles(path.join(root, "assets"))) {
    canonical[file] = sha256Bytes(await readFile(path.join(root, "assets", ...file.split("/"))));
  }
  return {
    sources: await readFile(path.join(root, "catalog", "sources.json"), "utf8"),
    storage: await readFile(path.join(root, "catalog", "storage.json"), "utf8"),
    canonical,
  };
}

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, ...relative.split("/")), "utf8"));
}

function plainPrepared(prepared) {
  return {
    sourceId: prepared.sourceId,
    relativePath: prepared.relativePath,
    sha256: prepared.sha256,
    byteLength: prepared.byteLength,
    bytes: Buffer.from(prepared.bytes),
    sourcesDocument: JSON.parse(JSON.stringify(prepared.sourcesDocument)),
    storageDocument: JSON.parse(JSON.stringify(prepared.storageDocument)),
  };
}

const MISMATCH = /sha-?256|hash mismatch|byte ?length mismatch/i;

async function cleanup(...directories) {
  for (const directory of directories) {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Whole sources
// ---------------------------------------------------------------------------

test("local file: an unpinned whole source is measured and prepared exactly as a network acquisition would be, without fetching", async () => {
  const sources = [modelRecord()];
  const localRoot = await repository(sources);
  const networkRoot = await repository(sources);
  const download = await downloadedFile("model.glb", MODEL_BYTES);
  const spy = forbiddenFetch();
  try {
    const local = await prepareAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MODEL_ID,
      repositoryRoot: localRoot,
      fetchImpl: spy.fetchImpl,
      localFile: download.filePath,
    });
    const network = await prepareAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MODEL_ID,
      repositoryRoot: networkRoot,
      fetchImpl: serve(MODEL_BYTES),
    });

    assert.deepEqual(spy.calls, []);
    assert.deepEqual(plainPrepared(local), plainPrepared(network));
    assert.equal(local.relativePath, `assets/canonical/${MODEL_ID}/model.glb`);
    assert.equal(local.sha256, sha256Bytes(MODEL_BYTES));
    assert.equal(local.byteLength, MODEL_BYTES.byteLength);
    assert.deepEqual(Buffer.from(local.bytes), MODEL_BYTES);

    // Provenance stays: the page URL and upload id are kept next to the pin.
    const pinned = local.sourcesDocument.sources.find(({ id }) => id === MODEL_ID);
    assert.deepEqual({ ...pinned.source }, {
      url: PAGE_URL,
      upstreamId: UPSTREAM_ID,
      revision: REVISION,
      path: "model.glb",
      ...pinOf(MODEL_BYTES),
    });
  } finally {
    await cleanup(localRoot, networkRoot, download.directory);
  }
});

test("local file: applying a whole source writes the same documents and canonical payload as the network path, idempotently", async () => {
  const sources = [modelRecord()];
  const localRoot = await repository(sources);
  const networkRoot = await repository(sources);
  const download = await downloadedFile("model.glb", MODEL_BYTES);
  const spy = forbiddenFetch();
  try {
    const local = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MODEL_ID,
      repositoryRoot: localRoot,
      fetchImpl: spy.fetchImpl,
      localFile: download.filePath,
    });
    const network = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MODEL_ID,
      repositoryRoot: networkRoot,
      fetchImpl: serve(MODEL_BYTES),
    });

    assert.deepEqual(spy.calls, []);
    assert.equal(local.status, "changed");
    assert.deepEqual({ ...local }, { ...network });
    assert.deepEqual(await snapshot(localRoot), await snapshot(networkRoot));
    assert.deepEqual(await listFiles(path.join(localRoot, "assets")), [`canonical/${MODEL_ID}/model.glb`]);
    assert.deepEqual(await readFile(path.join(localRoot, ...local.path.split("/"))), MODEL_BYTES);
    assert.deepEqual(await readJson(localRoot, "catalog/storage.json"), {
      schemaVersion: 1,
      entries: [{ schemaVersion: 1, sourceId: MODEL_ID, storage: "git-lfs", path: local.path }],
    });

    // Re-running against the now pinned documents with the same file changes nothing.
    const before = await snapshot(localRoot);
    const second = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: await readJson(localRoot, "catalog/sources.json"),
      storageDocument: await readJson(localRoot, "catalog/storage.json"),
      sourceId: MODEL_ID,
      repositoryRoot: localRoot,
      fetchImpl: spy.fetchImpl,
      localFile: download.filePath,
    });
    assert.equal(second.status, "unchanged");
    assert.equal(second.sha256, local.sha256);
    assert.deepEqual(await snapshot(localRoot), before);
    assert.deepEqual(spy.calls, []);
  } finally {
    await cleanup(localRoot, networkRoot, download.directory);
  }
});

test("local file: an already pinned whole source accepts a file that matches the pin exactly", async () => {
  const sources = [modelRecord(pinOf(MODEL_BYTES))];
  const root = await repository(sources);
  const download = await downloadedFile("download.bin", MODEL_BYTES);
  const spy = forbiddenFetch();
  try {
    const applied = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MODEL_ID,
      repositoryRoot: root,
      fetchImpl: spy.fetchImpl,
      localFile: download.filePath,
    });
    assert.deepEqual(spy.calls, []);
    assert.equal(applied.status, "changed");
    // The canonical name comes from the record, not from the downloaded file's name.
    assert.equal(applied.path, `assets/canonical/${MODEL_ID}/model.glb`);
    assert.deepEqual(await readFile(path.join(root, ...applied.path.split("/"))), MODEL_BYTES);
    const pinned = (await readJson(root, "catalog/sources.json")).sources.find(({ id }) => id === MODEL_ID);
    assert.deepEqual(pinned.source, modelRecord(pinOf(MODEL_BYTES)).source);
  } finally {
    await cleanup(root, download.directory);
  }
});

test("local file: an already pinned whole source rejects a file with a different hash or length and writes nothing", async () => {
  const sources = [modelRecord(pinOf(MODEL_BYTES))];
  const sameLength = Buffer.from(MODEL_BYTES);
  sameLength[0] ^= 0xff;
  const cases = [
    ["same length, different bytes", sameLength],
    ["different length", Buffer.concat([MODEL_BYTES, Buffer.from("!")])],
  ];
  for (const [label, bytes] of cases) {
    const root = await repository(sources);
    const download = await downloadedFile("model.glb", bytes);
    const spy = forbiddenFetch();
    try {
      const before = await snapshot(root);
      for (const operation of [prepareAssetCatalogLfsPromotion, applyAssetCatalogLfsPromotion]) {
        await assert.rejects(
          operation({
            providersDocument: PROVIDERS_DOCUMENT,
            sourcesDocument: sourcesDocument(sources),
            storageDocument: EMPTY_STORAGE,
            sourceId: MODEL_ID,
            repositoryRoot: root,
            fetchImpl: spy.fetchImpl,
            localFile: download.filePath,
          }),
          MISMATCH,
          `${label}: ${operation.name} must reject on a pin mismatch`,
        );
      }
      assert.deepEqual(spy.calls, [], `${label}: no fetch`);
      assert.deepEqual(await snapshot(root), before, `${label}: nothing written`);
      assert.deepEqual(await listFiles(path.join(root, "assets")), [], `${label}: no canonical payload`);
    } finally {
      await cleanup(root, download.directory);
    }
  }
});

// ---------------------------------------------------------------------------
// Archive members
// ---------------------------------------------------------------------------

test("local file: a member is extracted from the local ARCHIVE, pinning archive and member exactly as the network path does", async () => {
  const sources = [archiveRecord(), memberRecord()];
  const archive = standardArchive();
  const localRoot = await repository(sources);
  const networkRoot = await repository(sources);
  const download = await downloadedFile("Universal Pack[Standard].zip", archive);
  const spy = forbiddenFetch();
  const expectedPath = `assets/canonical/${MEMBER_ID}/Body.gltf`;
  try {
    const prepared = await prepareAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MEMBER_ID,
      repositoryRoot: localRoot,
      fetchImpl: spy.fetchImpl,
      localFile: download.filePath,
    });
    const preparedNetwork = await prepareAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MEMBER_ID,
      repositoryRoot: networkRoot,
      fetchImpl: serve(archive),
    });
    assert.deepEqual(plainPrepared(prepared), plainPrepared(preparedNetwork));
    assert.equal(prepared.relativePath, expectedPath);
    assert.deepEqual(Buffer.from(prepared.bytes), MEMBER_BYTES);
    const byId = new Map(prepared.sourcesDocument.sources.map((source) => [source.id, source]));
    assert.deepEqual({ ...byId.get(ARCHIVE_ID).source }, archiveRecord(pinOf(archive)).source);
    assert.deepEqual({ ...byId.get(MEMBER_ID).source }, pinOf(MEMBER_BYTES));

    const applied = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MEMBER_ID,
      repositoryRoot: localRoot,
      fetchImpl: spy.fetchImpl,
      localFile: download.filePath,
    });
    const appliedNetwork = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MEMBER_ID,
      repositoryRoot: networkRoot,
      fetchImpl: serve(archive),
    });
    assert.deepEqual(spy.calls, []);
    assert.equal(applied.status, "changed");
    assert.deepEqual({ ...applied }, { ...appliedNetwork });
    assert.deepEqual(await snapshot(localRoot), await snapshot(networkRoot));
    // Only the member is stored; the archive is pinned in sources but has no storage entry.
    assert.deepEqual(await listFiles(path.join(localRoot, "assets")), [`canonical/${MEMBER_ID}/Body.gltf`]);
    assert.deepEqual(await readFile(path.join(localRoot, ...expectedPath.split("/"))), MEMBER_BYTES);
    assert.deepEqual(await readJson(localRoot, "catalog/storage.json"), {
      schemaVersion: 1,
      entries: [{ schemaVersion: 1, sourceId: MEMBER_ID, storage: "git-lfs", path: expectedPath }],
    });

    const before = await snapshot(localRoot);
    const second = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: await readJson(localRoot, "catalog/sources.json"),
      storageDocument: await readJson(localRoot, "catalog/storage.json"),
      sourceId: MEMBER_ID,
      repositoryRoot: localRoot,
      fetchImpl: spy.fetchImpl,
      localFile: download.filePath,
    });
    assert.equal(second.status, "unchanged");
    assert.deepEqual(await snapshot(localRoot), before);
    assert.deepEqual(spy.calls, []);
  } finally {
    await cleanup(localRoot, networkRoot, download.directory);
  }
});

test("local file: a member with a pinned archive accepts the matching archive and rejects a changed one without writing", async () => {
  const archive = standardArchive();
  const sources = [archiveRecord(pinOf(archive)), memberRecord()];
  const root = await repository(sources);
  // Same member bytes, but a repacked archive: the archive pin must catch it.
  const repacked = zip([
    { name: MEMBER_PATH, data: MEMBER_BYTES, method: 8 },
    { name: "Pack[Standard]/README.txt", data: Buffer.from("new upstream file"), method: 0 },
  ]);
  const changed = await downloadedFile("pack.zip", repacked);
  const matching = await downloadedFile("pack.zip", archive);
  const spy = forbiddenFetch();
  try {
    const before = await snapshot(root);
    for (const operation of [prepareAssetCatalogLfsPromotion, applyAssetCatalogLfsPromotion]) {
      await assert.rejects(
        operation({
          providersDocument: PROVIDERS_DOCUMENT,
          sourcesDocument: sourcesDocument(sources),
          storageDocument: EMPTY_STORAGE,
          sourceId: MEMBER_ID,
          repositoryRoot: root,
          fetchImpl: spy.fetchImpl,
          localFile: changed.filePath,
        }),
        MISMATCH,
      );
    }
    assert.deepEqual(await snapshot(root), before);

    const applied = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MEMBER_ID,
      repositoryRoot: root,
      fetchImpl: spy.fetchImpl,
      localFile: matching.filePath,
    });
    assert.equal(applied.status, "changed");
    assert.equal(applied.sha256, sha256Bytes(MEMBER_BYTES));
    assert.deepEqual(await listFiles(path.join(root, "assets")), [`canonical/${MEMBER_ID}/Body.gltf`]);
    assert.deepEqual(spy.calls, []);
  } finally {
    await cleanup(root, changed.directory, matching.directory);
  }
});

test("local file: a pinned member rejects an archive whose member bytes changed, without writing", async () => {
  const sources = [archiveRecord(), memberRecord(pinOf(MEMBER_BYTES))];
  const root = await repository(sources);
  const download = await downloadedFile("pack.zip", standardArchive(Buffer.from("changed body bytes")));
  const spy = forbiddenFetch();
  try {
    const before = await snapshot(root);
    await assert.rejects(
      applyAssetCatalogLfsPromotion({
        providersDocument: PROVIDERS_DOCUMENT,
        sourcesDocument: sourcesDocument(sources),
        storageDocument: EMPTY_STORAGE,
        sourceId: MEMBER_ID,
        repositoryRoot: root,
        fetchImpl: spy.fetchImpl,
        localFile: download.filePath,
      }),
      MISMATCH,
    );
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(spy.calls, []);
  } finally {
    await cleanup(root, download.directory);
  }
});

test("local file: for a member id the file is the archive, so the bare member bytes are not accepted", async () => {
  const sources = [archiveRecord(), memberRecord()];
  const root = await repository(sources);
  const download = await downloadedFile("Body.gltf", MEMBER_BYTES);
  const spy = forbiddenFetch();
  try {
    const before = await snapshot(root);
    await assert.rejects(
      applyAssetCatalogLfsPromotion({
        providersDocument: PROVIDERS_DOCUMENT,
        sourcesDocument: sourcesDocument(sources),
        storageDocument: EMPTY_STORAGE,
        sourceId: MEMBER_ID,
        repositoryRoot: root,
        fetchImpl: spy.fetchImpl,
        localFile: download.filePath,
      }),
    );
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(spy.calls, []);
  } finally {
    await cleanup(root, download.directory);
  }
});

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

test("local file: a relative or missing path rejects before any write or fetch", async () => {
  const sources = [modelRecord()];
  const root = await repository(sources);
  const download = await downloadedFile("model.glb", MODEL_BYTES);
  const spy = forbiddenFetch();
  // A relative path that would even resolve to a real file from the current directory.
  const relative = path.relative(process.cwd(), download.filePath);
  assert.equal(path.isAbsolute(relative), false);
  const cases = [
    ["relative path", relative],
    ["bare file name", "model.glb"],
    ["missing absolute path", path.join(download.directory, "missing.glb")],
  ];
  try {
    const before = await snapshot(root);
    for (const [label, localFile] of cases) {
      for (const operation of [prepareAssetCatalogLfsPromotion, applyAssetCatalogLfsPromotion]) {
        await assert.rejects(
          operation({
            providersDocument: PROVIDERS_DOCUMENT,
            sourcesDocument: sourcesDocument(sources),
            storageDocument: EMPTY_STORAGE,
            sourceId: MODEL_ID,
            repositoryRoot: root,
            fetchImpl: spy.fetchImpl,
            localFile,
          }),
          (error) => {
            assert.ok(error instanceof Error, `${label}: expected an Error`);
            assert.doesNotMatch(error.message, /fetch must not be called/, `${label}: must not fall back to fetch`);
            return true;
          },
          `${label}: ${operation.name} must reject`,
        );
      }
    }
    assert.deepEqual(spy.calls, []);
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(await listFiles(path.join(root, "assets")), []);
  } finally {
    await cleanup(root, download.directory);
  }
});

test("without localFile, promotion still acquires through fetchImpl", async () => {
  const sources = [modelRecord()];
  const root = await repository(sources);
  const requests = [];
  try {
    const applied = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: EMPTY_STORAGE,
      sourceId: MODEL_ID,
      repositoryRoot: root,
      fetchImpl: async (url) => {
        requests.push(url);
        return new Response(MODEL_BYTES, { status: 200 });
      },
    });
    assert.deepEqual(requests, [PAGE_URL]);
    assert.equal(applied.sha256, sha256Bytes(MODEL_BYTES));
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// CLI argument handling (no repository mutation: unregistered ids only)
// ---------------------------------------------------------------------------

const SCRIPT = fileURLToPath(new URL("../scripts/promote-catalog-lfs-source.ts", import.meta.url));
const UNREGISTERED_ID = "acceptance.unregistered-source-109";

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("CLI: unknown flags are usage errors (exit 2)", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-local-file-cli-"));
  try {
    for (const args of [
      [UNREGISTERED_ID, "--bogus"],
      [UNREGISTERED_ID, "--from-file", "/tmp/x.zip"],
      [UNREGISTERED_ID, "--bogus=1"],
    ]) {
      const result = runCli(args, cwd);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage/i, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
    }
  } finally {
    await cleanup(cwd);
  }
});

test("CLI: --from without a value is a usage error (exit 2)", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-local-file-cli-"));
  try {
    for (const args of [[UNREGISTERED_ID, "--from"], [UNREGISTERED_ID, "--from="]]) {
      const result = runCli(args, cwd);
      assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /usage/i, args.join(" "));
    }
  } finally {
    await cleanup(cwd);
  }
});

test("CLI: --from <file> and --from=<file> are accepted, and a relative path is not a usage error", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-lfs-local-file-cli-"));
  try {
    await writeFile(path.join(cwd, "pack.zip"), standardArchive());
    for (const args of [
      [UNREGISTERED_ID, "--from", path.join(cwd, "pack.zip")],
      [UNREGISTERED_ID, `--from=${path.join(cwd, "pack.zip")}`],
      [UNREGISTERED_ID, "--from", "pack.zip"],
      [UNREGISTERED_ID, "--from=pack.zip"],
    ]) {
      const result = runCli(args, cwd);
      // The id is unregistered, so promotion fails (exit 1), but the arguments parse.
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /usage/i, args.join(" "));
      assert.doesNotMatch(result.stderr, /absolute/i, `${args.join(" ")}: relative --from resolves against cwd`);
    }
  } finally {
    await cleanup(cwd);
  }
});
