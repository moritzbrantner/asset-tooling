// Acceptance tests for archive-member catalog sources (#118, owner option B).
// Contract: docs/catalog.md, section "Archive-member sources".
//
// Every zip archive is built in-test by a minimal writer below, so headers are
// controlled byte-for-byte. No test touches the network: acquisition and
// promotion receive an injected `fetchImpl`.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { sha256Bytes } from "../src/hash.js";
import { createAssetCatalog, createAssetCatalogSource } from "../src/catalog.js";
import { acquireAssetCatalogSource } from "../src/catalog-acquisition.js";
import {
  applyAssetCatalogLfsPromotion,
  prepareAssetCatalogLfsPromotion,
} from "../src/catalog-lfs-promotion.js";
import {
  canonicalAssetStoragePath,
  createAssetCatalogStorageManifest,
  importAssetCatalogStorageSource,
  readAssetCatalogStorageSource,
  verifyAssetCatalogStorageBytes,
} from "../src/catalog-storage.js";

// ---------------------------------------------------------------------------
// Minimal zip writer (stored / deflate) with per-entry header overrides.
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
const UNIX_SYMLINK = (0o120777 << 16) >>> 0;
const MADE_BY_UNIX = (3 << 8) | 20;

// Header fields that may be overridden independently in the local and central headers.
// name: string | Buffer (raw bytes), method, flags, crc, compressedSize, uncompressedSize, extra.
// Central-only: externalAttributes, versionMadeBy, diskStart.
function zip(entries, { eocd = {} } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? Buffer.alloc(0));
    const method = entry.method ?? 8;
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(data) : data);
    const base = {
      name: Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, "utf8"),
      method,
      flags: entry.flags ?? 0,
      crc: entry.crc ?? crc32(data),
      compressedSize: entry.compressedSize ?? payload.byteLength,
      uncompressedSize: entry.uncompressedSize ?? data.byteLength,
      extra: entry.extra ?? Buffer.alloc(0),
    };
    const local = { ...base, ...(entry.local ?? {}) };
    if (typeof local.name === "string") local.name = Buffer.from(local.name, "utf8");
    const central = { ...base, ...(entry.central ?? {}) };
    if (typeof central.name === "string") central.name = Buffer.from(central.name, "utf8");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(local.flags, 6);
    lh.writeUInt16LE(local.method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(local.crc >>> 0, 14);
    lh.writeUInt32LE(local.compressedSize >>> 0, 18);
    lh.writeUInt32LE(local.uncompressedSize >>> 0, 22);
    lh.writeUInt16LE(local.name.byteLength, 26);
    lh.writeUInt16LE(local.extra.byteLength, 28);
    const localRecord = Buffer.concat([lh, local.name, local.extra, payload]);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(entry.versionMadeBy ?? MADE_BY_UNIX, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(central.flags, 8);
    ch.writeUInt16LE(central.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(central.crc >>> 0, 16);
    ch.writeUInt32LE(central.compressedSize >>> 0, 20);
    ch.writeUInt32LE(central.uncompressedSize >>> 0, 24);
    ch.writeUInt16LE(central.name.byteLength, 28);
    ch.writeUInt16LE(central.extra.byteLength, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(entry.diskStart ?? 0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((entry.externalAttributes ?? UNIX_REGULAR_FILE) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, central.name, central.extra]));

    locals.push(localRecord);
    offset += localRecord.byteLength;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(eocd.disk ?? 0, 4);
  end.writeUInt16LE(eocd.centralDirectoryDisk ?? 0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function zip64ExtraField(uncompressedSize, compressedSize) {
  const extra = Buffer.alloc(4 + 16);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  return extra;
}

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

const PROVIDER = {
  schemaVersion: 1,
  id: "example-shared",
  label: "Example Shared",
  homepage: "https://example.com/assets",
  distribution: "shared",
  acceptedLicenses: ["CC0-1.0", "CC-BY-4.0"],
};
const OTHER_PROVIDER = { ...PROVIDER, id: "other-shared", label: "Other Shared" };

const LICENSE = { spdx: "CC0-1.0", evidenceUrl: "https://example.com/assets/pack/license" };

const ARCHIVE_ID = "example.pack";
const ARCHIVE_URL = "https://example.com/assets/pack.zip";
const MEMBER_ID = "example.pack.door-gltf";
const MEMBER_PATH = "Pack[Standard]/glTF/Door.gltf";
const MEMBER_BYTES = Buffer.from('{"asset":{"version":"2.0"},"door":true}\n'.repeat(8), "utf8");
const SIBLING_BYTES = Buffer.from("sibling texture bytes", "utf8");

function archiveRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: ARCHIVE_ID,
    provider: PROVIDER.id,
    title: "Example pack",
    kind: "asset-pack",
    mediaType: "application/zip",
    source: { url: ARCHIVE_URL, path: "pack.zip" },
    license: { ...LICENSE },
    tags: ["testing"],
    ...overrides,
  };
}

function memberRecord(overrides = {}) {
  return {
    schemaVersion: 2,
    id: MEMBER_ID,
    provider: PROVIDER.id,
    title: "Example pack - door (glTF)",
    kind: "mesh",
    mediaType: "model/gltf+json",
    archiveMember: { archive: ARCHIVE_ID, path: MEMBER_PATH },
    source: {},
    license: { ...LICENSE },
    tags: ["gltf"],
    ...overrides,
  };
}

function catalogOf(sources, providers = [PROVIDER]) {
  return createAssetCatalog({ providers, sources });
}

function sourcesDocument(sources) {
  return { schemaVersion: 1, sources };
}

const PROVIDERS_DOCUMENT = { schemaVersion: 1, providers: [PROVIDER] };

function standardArchive(memberData = MEMBER_BYTES) {
  return zip([
    { name: "Pack[Standard]/", data: Buffer.alloc(0), method: 0, externalAttributes: UNIX_DIRECTORY },
    { name: "Pack[Standard]/glTF/Door.bin", data: SIBLING_BYTES, method: 0 },
    { name: MEMBER_PATH, data: memberData, method: 8 },
  ]);
}

function serve(bytes, requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    if (url !== ARCHIVE_URL) throw new Error(`unexpected fetch of ${url}`);
    return new Response(bytes, { status: 200 });
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A v2 record rejected only because the implementation does not know schema
// version 2 or the archiveMember field yet does not count as enforcing a rule.
function assertRejectsForRule(fn, label) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof Error, `${label}: expected an Error`);
      assert.doesNotMatch(
        error.message,
        /schemaVersion must be 1|unknown field 'archiveMember'/,
        `${label}: rejected only because schema version 2 is unsupported`,
      );
      return true;
    },
    label,
  );
}

async function tempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `asset-tooling-archive-member-${prefix}-`));
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

// Reads a provenance field from AssetRef metadata. The doc says the import
// metadata "records" these fields without fixing their nesting; accept them
// either next to the other catalog provenance or at the metadata top level.
function provenanceField(metadata, key) {
  if (metadata?.catalog && Object.hasOwn(metadata.catalog, key)) return metadata.catalog[key];
  if (metadata && Object.hasOwn(metadata, key)) return metadata[key];
  return undefined;
}

// ---------------------------------------------------------------------------
// Sanity: the fixture zip writer produces a structurally valid archive.
// ---------------------------------------------------------------------------

test("fixture zip writer: end-of-central-directory points at a central directory listing every entry", () => {
  const bytes = standardArchive();
  const eocd = bytes.byteLength - 22;
  assert.equal(bytes.readUInt32LE(eocd), 0x06054b50);
  assert.equal(bytes.readUInt16LE(eocd + 10), 3);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  assert.equal(bytes.readUInt32LE(cdOffset), 0x02014b50);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

test("record shape: a schema version 2 member record normalizes with its archiveMember and member-only source", () => {
  const catalog = catalogOf([archiveRecord(), memberRecord()]);
  const member = catalog.getSource(MEMBER_ID);
  assert.ok(member, "member source is registered");
  assert.equal(member.schemaVersion, 2);
  assert.deepEqual({ ...member.archiveMember }, { archive: ARCHIVE_ID, path: MEMBER_PATH });
  assert.equal(member.source.url, undefined);
  assert.equal(member.source.sha256, undefined);
  assert.equal(member.source.byteLength, undefined);

  const pinned = createAssetCatalogSource(
    memberRecord({ source: { sha256: sha256Bytes(MEMBER_BYTES), byteLength: MEMBER_BYTES.byteLength } }),
  );
  assert.equal(pinned.source.sha256, sha256Bytes(MEMBER_BYTES));
  assert.equal(pinned.source.byteLength, MEMBER_BYTES.byteLength);
});

test("record shape: version 2 requires archiveMember and forbids url, upstreamId, revision and path in source", () => {
  const { archiveMember: _omit, ...withoutArchiveMember } = memberRecord();
  assertRejectsForRule(() => catalogOf([archiveRecord(), withoutArchiveMember]), "missing archiveMember");
  for (const [field, value] of [
    ["url", "https://example.com/assets/pack.zip"],
    ["upstreamId", "door"],
    ["revision", "v1"],
    ["path", "Door.gltf"],
  ]) {
    assertRejectsForRule(
      () => catalogOf([archiveRecord(), memberRecord({ source: { [field]: value } })]),
      `source.${field}`,
    );
  }
});

test("record shape: version 2 rejects unknown fields and a split sha256/byteLength pin", () => {
  assertRejectsForRule(
    () => catalogOf([archiveRecord(), memberRecord({ unexpected: true })]),
    "unknown top-level field",
  );
  assertRejectsForRule(
    () =>
      catalogOf([
        archiveRecord(),
        memberRecord({ archiveMember: { archive: ARCHIVE_ID, path: MEMBER_PATH, sha256: "0".repeat(64) } }),
      ]),
    "unknown archiveMember field",
  );
  assertRejectsForRule(
    () => catalogOf([archiveRecord(), memberRecord({ source: { mirror: "https://example.com" } })]),
    "unknown source field",
  );
  assertRejectsForRule(
    () => catalogOf([archiveRecord(), memberRecord({ source: { sha256: sha256Bytes(MEMBER_BYTES) } })]),
    "sha256 without byteLength",
  );
  assertRejectsForRule(
    () => catalogOf([archiveRecord(), memberRecord({ source: { byteLength: 3 } })]),
    "byteLength without sha256",
  );
});

test("record shape: version 1 records are unchanged and cannot carry archiveMember", () => {
  const { schemaVersion: _omit, ...implicitV1 } = archiveRecord();
  const catalog = catalogOf([implicitV1]);
  assert.equal(catalog.getSource(ARCHIVE_ID).schemaVersion, 1);
  assert.equal(catalog.getSource(ARCHIVE_ID).source.url, ARCHIVE_URL);
  assert.equal(Object.hasOwn(catalog.getSource(ARCHIVE_ID), "archiveMember"), false);

  assert.throws(
    () =>
      createAssetCatalogSource({
        ...archiveRecord({ id: "example.v1-member" }),
        archiveMember: { archive: ARCHIVE_ID, path: MEMBER_PATH },
      }),
    /unknown field 'archiveMember'/,
  );
  assert.throws(() => createAssetCatalogSource(memberRecord({ schemaVersion: 3 })));
});

// ---------------------------------------------------------------------------
// The referenced archive
// ---------------------------------------------------------------------------

test("archive reference: must be registered, version 1, application/zip, same provider, identical license", () => {
  // Positive control for the comparisons below.
  catalogOf([archiveRecord(), memberRecord()]);

  assertRejectsForRule(
    () => catalogOf([archiveRecord(), memberRecord({ archiveMember: { archive: "example.missing", path: MEMBER_PATH } })]),
    "unregistered archive",
  );
  assertRejectsForRule(
    () => catalogOf([archiveRecord({ mediaType: "application/x-tar" }), memberRecord()]),
    "archive is not application/zip",
  );
  assertRejectsForRule(
    () => catalogOf([archiveRecord({ provider: OTHER_PROVIDER.id }), memberRecord()], [PROVIDER, OTHER_PROVIDER]),
    "archive from another provider",
  );
  assertRejectsForRule(
    () =>
      catalogOf([
        archiveRecord(),
        memberRecord({ license: { ...LICENSE, evidenceUrl: "https://example.com/other-license" } }),
      ]),
    "license evidence URL differs",
  );
  assertRejectsForRule(
    () =>
      catalogOf([
        archiveRecord({ license: { spdx: "CC-BY-4.0", evidenceUrl: LICENSE.evidenceUrl, attribution: "By Example" } }),
        memberRecord({ license: { spdx: "CC0-1.0", evidenceUrl: LICENSE.evidenceUrl } }),
      ]),
    "license spdx differs",
  );
  assertRejectsForRule(
    () =>
      catalogOf([
        archiveRecord({ license: { spdx: "CC-BY-4.0", evidenceUrl: LICENSE.evidenceUrl, attribution: "By Example" } }),
        memberRecord({ license: { spdx: "CC-BY-4.0", evidenceUrl: LICENSE.evidenceUrl, attribution: "By Someone" } }),
      ]),
    "license attribution differs",
  );
  assertRejectsForRule(
    () =>
      catalogOf([
        archiveRecord({ license: { ...LICENSE, attribution: "By Example" } }),
        memberRecord({ license: { ...LICENSE } }),
      ]),
    "license attribution present only on the archive",
  );

  // Identical license with attribution is accepted.
  catalogOf([
    archiveRecord({ license: { spdx: "CC-BY-4.0", evidenceUrl: LICENSE.evidenceUrl, attribution: "By Example" } }),
    memberRecord({ license: { spdx: "CC-BY-4.0", evidenceUrl: LICENSE.evidenceUrl, attribution: "By Example" } }),
  ]);
});

test("archive reference: a member can never be an archive, so members do not nest", () => {
  const nestedZip = memberRecord({
    id: "example.pack.inner-zip",
    mediaType: "application/zip",
    archiveMember: { archive: ARCHIVE_ID, path: "inner.zip" },
  });
  catalogOf([archiveRecord(), nestedZip]);
  assertRejectsForRule(
    () =>
      catalogOf([
        archiveRecord(),
        nestedZip,
        memberRecord({ id: "example.pack.nested", archiveMember: { archive: nestedZip.id, path: "Door.gltf" } }),
      ]),
    "member of a member",
  );
});

// ---------------------------------------------------------------------------
// Member path
// ---------------------------------------------------------------------------

test("member path: accepts portable relative paths with spaces and brackets", () => {
  for (const memberPath of ["Door.gltf", MEMBER_PATH, "Pack Standard/glTF/Door (1).gltf", "a/b..c/.hidden"]) {
    const catalog = catalogOf([archiveRecord(), memberRecord({ archiveMember: { archive: ARCHIVE_ID, path: memberPath } })]);
    assert.equal(catalog.getSource(MEMBER_ID).archiveMember.path, memberPath);
  }
});

test("member path: rejects non-portable paths", () => {
  const invalid = [
    ["empty", ""],
    ["leading slash", "/Pack/Door.gltf"],
    ["dot segment", "./Door.gltf"],
    ["inner dot segment", "Pack/./Door.gltf"],
    ["dotdot segment", "../Door.gltf"],
    ["inner dotdot segment", "Pack/../Door.gltf"],
    ["sole dotdot", ".."],
    ["backslash", "Pack\\Door.gltf"],
    ["drive prefix with slash", "C:/Pack/Door.gltf"],
    ["drive prefix without slash", "c:Door.gltf"],
    ["NUL", "Pack/Door\u0000.gltf"],
    ["empty segment", "Pack//Door.gltf"],
    ["trailing slash", "Pack/"],
  ];
  for (const [label, memberPath] of invalid) {
    assertRejectsForRule(
      () => catalogOf([archiveRecord(), memberRecord({ archiveMember: { archive: ARCHIVE_ID, path: memberPath } })]),
      `member path ${label}`,
    );
  }
});

test("member path: the (archive, path) pair is unique, while case and Unicode form variants are distinct", () => {
  assertRejectsForRule(
    () => catalogOf([archiveRecord(), memberRecord(), memberRecord({ id: "example.pack.door-again" })]),
    "duplicate (archive, path)",
  );

  const nfc = "Pack/Caf\u00e9.gltf";
  const nfd = "Pack/Cafe\u0301.gltf";
  const catalog = catalogOf([
    archiveRecord(),
    archiveRecord({ id: "example.pack-two", source: { url: "https://example.com/assets/pack-two.zip" } }),
    memberRecord(),
    memberRecord({ id: "example.pack-two.door", archiveMember: { archive: "example.pack-two", path: MEMBER_PATH } }),
    memberRecord({ id: "example.pack.door-lower", archiveMember: { archive: ARCHIVE_ID, path: MEMBER_PATH.toLowerCase() } }),
    memberRecord({ id: "example.pack.cafe-nfc", archiveMember: { archive: ARCHIVE_ID, path: nfc } }),
    memberRecord({ id: "example.pack.cafe-nfd", archiveMember: { archive: ARCHIVE_ID, path: nfd } }),
  ]);
  assert.equal(catalog.getSource("example.pack.cafe-nfc").archiveMember.path, nfc);
  assert.equal(catalog.getSource("example.pack.cafe-nfd").archiveMember.path, nfd);
});

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

test("acquisition: a member id fetches the archive URL once, extracts the member and writes the member pin", async () => {
  const root = await tempRoot("acquire");
  const archive = standardArchive();
  const requests = [];
  try {
    const catalog = catalogOf([
      archiveRecord({ source: { url: ARCHIVE_URL, path: "pack.zip", sha256: sha256Bytes(archive), byteLength: archive.byteLength } }),
      memberRecord(),
    ]);
    const result = await acquireAssetCatalogSource({
      catalog,
      sourceId: MEMBER_ID,
      destinationRoot: root,
      fetchImpl: serve(archive, requests),
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, ARCHIVE_URL);
    assert.equal(result.sourceId, MEMBER_ID);
    assert.equal(result.sha256, sha256Bytes(MEMBER_BYTES));
    assert.equal(result.byteLength, MEMBER_BYTES.byteLength);
    assert.equal(path.basename(result.filePath), "Door.gltf");
    assert.deepEqual(await readFile(result.filePath), MEMBER_BYTES);

    const pin = JSON.parse(await readFile(result.pinPath, "utf8"));
    assert.equal(pin.id, MEMBER_ID);
    assert.equal(pin.schemaVersion, 2);
    assert.deepEqual(pin.archiveMember, { archive: ARCHIVE_ID, path: MEMBER_PATH });
    assert.equal(pin.source.sha256, sha256Bytes(MEMBER_BYTES));
    assert.equal(pin.source.byteLength, MEMBER_BYTES.byteLength);
    assert.equal(pin.source.url, undefined);

    // Nothing canonical is written by acquisition.
    const written = await listFiles(root);
    assert.equal(written.some((file) => file.startsWith("assets/canonical/")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition: extracts a stored member and the byte-exact name (case and Unicode form matter)", async () => {
  const root = await tempRoot("acquire-exact");
  const nfc = "Pack/Caf\u00e9.gltf";
  const nfd = "Pack/Cafe\u0301.gltf";
  const archive = zip([
    { name: "pack[standard]/gltf/door.gltf", data: Buffer.from("lowercase twin"), method: 8 },
    { name: MEMBER_PATH, data: MEMBER_BYTES, method: 0 },
    { name: nfd, data: Buffer.from("decomposed"), method: 0 },
    { name: nfc, data: Buffer.from("composed"), method: 8 },
  ]);
  try {
    const catalog = catalogOf([
      archiveRecord(),
      memberRecord(),
      memberRecord({ id: "example.pack.cafe-nfc", archiveMember: { archive: ARCHIVE_ID, path: nfc } }),
      memberRecord({ id: "example.pack.cafe-nfd", archiveMember: { archive: ARCHIVE_ID, path: nfd } }),
    ]);
    const door = await acquireAssetCatalogSource({
      catalog,
      sourceId: MEMBER_ID,
      destinationRoot: root,
      fetchImpl: serve(archive),
    });
    assert.deepEqual(await readFile(door.filePath), MEMBER_BYTES);

    const composed = await acquireAssetCatalogSource({
      catalog,
      sourceId: "example.pack.cafe-nfc",
      destinationRoot: root,
      fetchImpl: serve(archive),
    });
    assert.deepEqual(await readFile(composed.filePath), Buffer.from("composed"));

    const decomposed = await acquireAssetCatalogSource({
      catalog,
      sourceId: "example.pack.cafe-nfd",
      destinationRoot: root,
      fetchImpl: serve(archive),
    });
    assert.deepEqual(await readFile(decomposed.filePath), Buffer.from("decomposed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition: a member path absent from the archive fails, without case or Unicode folding", async () => {
  const root = await tempRoot("acquire-missing");
  try {
    const catalog = catalogOf([
      archiveRecord(),
      memberRecord({ archiveMember: { archive: ARCHIVE_ID, path: MEMBER_PATH.toUpperCase() } }),
      memberRecord({ id: "example.pack.cafe-nfc", archiveMember: { archive: ARCHIVE_ID, path: "Pack/Caf\u00e9.gltf" } }),
    ]);
    await assert.rejects(
      acquireAssetCatalogSource({ catalog, sourceId: MEMBER_ID, destinationRoot: root, fetchImpl: serve(standardArchive()) }),
    );
    const nfdOnly = zip([{ name: "Pack/Cafe\u0301.gltf", data: Buffer.from("decomposed"), method: 0 }]);
    await assert.rejects(
      acquireAssetCatalogSource({ catalog, sourceId: "example.pack.cafe-nfc", destinationRoot: root, fetchImpl: serve(nfdOnly) }),
    );
    const written = await listFiles(root);
    assert.equal(written.some((file) => file.endsWith(".gltf")), false, `no member written: ${written.join(", ")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition: verifies the archive pin before extracting and the member pin after", async () => {
  const root = await tempRoot("acquire-pins");
  const archive = standardArchive();
  try {
    const wrongArchivePin = catalogOf([
      archiveRecord({ source: { url: ARCHIVE_URL, sha256: "0".repeat(64), byteLength: archive.byteLength } }),
      memberRecord(),
    ]);
    await assert.rejects(
      acquireAssetCatalogSource({ catalog: wrongArchivePin, sourceId: MEMBER_ID, destinationRoot: root, fetchImpl: serve(archive) }),
      new RegExp(escapeRegExp(ARCHIVE_ID)),
    );

    const wrongMemberPin = catalogOf([
      archiveRecord(),
      memberRecord({ source: { sha256: sha256Bytes(SIBLING_BYTES), byteLength: MEMBER_BYTES.byteLength } }),
    ]);
    await assert.rejects(
      acquireAssetCatalogSource({ catalog: wrongMemberPin, sourceId: MEMBER_ID, destinationRoot: root, fetchImpl: serve(archive) }),
      new RegExp(escapeRegExp(MEMBER_ID)),
    );

    const wrongMemberLength = catalogOf([
      archiveRecord(),
      memberRecord({ source: { sha256: sha256Bytes(MEMBER_BYTES), byteLength: MEMBER_BYTES.byteLength + 1 } }),
    ]);
    await assert.rejects(
      acquireAssetCatalogSource({ catalog: wrongMemberLength, sourceId: MEMBER_ID, destinationRoot: root, fetchImpl: serve(archive) }),
      new RegExp(escapeRegExp(MEMBER_ID)),
    );
    assert.deepEqual(
      (await listFiles(root)).filter((file) => file.endsWith(".gltf")),
      [],
      "a member failing its pin is not written",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition: a project-local provider cannot acquire members through the shared path", async () => {
  const root = await tempRoot("acquire-local");
  const local = { ...PROVIDER, distribution: "project-local" };
  try {
    const catalog = catalogOf([archiveRecord(), memberRecord()], [local]);
    let fetched = false;
    await assert.rejects(
      acquireAssetCatalogSource({
        catalog,
        sourceId: MEMBER_ID,
        destinationRoot: root,
        fetchImpl: async () => {
          fetched = true;
          return new Response(standardArchive(), { status: 200 });
        },
      }),
      /project-local/,
    );
    assert.equal(fetched, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition: version 1 zip sources are still acquired whole", async () => {
  const root = await tempRoot("acquire-v1");
  const archive = standardArchive();
  try {
    const result = await acquireAssetCatalogSource({
      catalog: catalogOf([archiveRecord()]),
      sourceId: ARCHIVE_ID,
      destinationRoot: root,
      fetchImpl: serve(archive),
    });
    assert.deepEqual(await readFile(result.filePath), archive);
    assert.equal(path.basename(result.filePath), "pack.zip");
    assert.equal(result.sha256, sha256Bytes(archive));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Malformed archives: each fails closed and names the entry.
// ---------------------------------------------------------------------------

const MALFORMED = [
  {
    label: "directory entry",
    entry: { name: MEMBER_PATH, data: Buffer.alloc(0), method: 0, externalAttributes: UNIX_DIRECTORY },
  },
  {
    label: "MS-DOS directory attribute",
    entry: { name: MEMBER_PATH, data: Buffer.alloc(0), method: 0, versionMadeBy: 20, externalAttributes: 0x10 },
  },
  {
    label: "symlink entry",
    entry: { name: MEMBER_PATH, data: Buffer.from("../../etc/passwd"), method: 0, externalAttributes: UNIX_SYMLINK },
  },
  { label: "encrypted flag", entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 0, flags: 0x0001 } },
  {
    label: "unsupported method 12 (bzip2)",
    entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 12, payload: Buffer.from(MEMBER_BYTES) },
  },
  {
    label: "ZIP64 marker",
    entry: {
      name: MEMBER_PATH,
      data: MEMBER_BYTES,
      method: 0,
      compressedSize: 0xffffffff,
      uncompressedSize: 0xffffffff,
      extra: zip64ExtraField(MEMBER_BYTES.byteLength, MEMBER_BYTES.byteLength),
    },
  },
  { label: "multi-disk entry", entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 8, diskStart: 1 } },
  {
    label: "local/central name mismatch",
    entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 0, local: { name: MEMBER_PATH.replace("Door", "Wall") } },
  },
  {
    label: "local/central method mismatch",
    entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 0, local: { method: 8 } },
  },
  {
    label: "local/central compressed size mismatch",
    entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 8, local: { compressedSize: 1 } },
  },
  {
    label: "local/central uncompressed size mismatch",
    entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 8, local: { uncompressedSize: MEMBER_BYTES.byteLength + 1 } },
  },
  {
    label: "wrong CRC-32",
    entry: { name: MEMBER_PATH, data: MEMBER_BYTES, method: 8, crc: (crc32(MEMBER_BYTES) ^ 1) >>> 0 },
  },
  {
    label: "inflate exceeds declared uncompressed size",
    entry: {
      name: MEMBER_PATH,
      // 4 MiB of zeros deflates to a few KiB; the header claims 1 KiB. CRC is
      // that of the full payload, so the size guard is the only fault.
      data: Buffer.alloc(4 * 1024 * 1024),
      method: 8,
      uncompressedSize: 1024,
    },
  },
];

for (const { label, entry } of MALFORMED) {
  test(`malformed archive fails closed with the entry name: ${label}`, async () => {
    const root = await tempRoot("malformed");
    try {
      const catalog = catalogOf([archiveRecord(), memberRecord()]);
      const archive = zip([{ name: "Pack[Standard]/glTF/Door.bin", data: SIBLING_BYTES, method: 0 }, entry]);
      await assert.rejects(
        acquireAssetCatalogSource({ catalog, sourceId: MEMBER_ID, destinationRoot: root, fetchImpl: serve(archive) }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(escapeRegExp(MEMBER_PATH)), `${label}: error names the entry`);
          return true;
        },
      );
      assert.deepEqual(
        (await listFiles(root)).filter((file) => file.endsWith("Door.gltf")),
        [],
        `${label}: no member bytes written`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("malformed archive fails closed with the entry name: duplicate central-directory names", async () => {
  const root = await tempRoot("duplicate");
  try {
    const catalog = catalogOf([archiveRecord(), memberRecord()]);
    const archive = zip([
      { name: MEMBER_PATH, data: MEMBER_BYTES, method: 8 },
      { name: MEMBER_PATH, data: Buffer.from("shadowing entry"), method: 0 },
    ]);
    await assert.rejects(
      acquireAssetCatalogSource({ catalog, sourceId: MEMBER_ID, destinationRoot: root, fetchImpl: serve(archive) }),
      new RegExp(escapeRegExp(MEMBER_PATH)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed archive: bytes that are not a zip fail closed", async () => {
  const root = await tempRoot("not-zip");
  try {
    const catalog = catalogOf([archiveRecord(), memberRecord()]);
    await assert.rejects(
      acquireAssetCatalogSource({
        catalog,
        sourceId: MEMBER_ID,
        destinationRoot: root,
        fetchImpl: serve(Buffer.from("definitely not a zip archive")),
      }),
    );
    assert.deepEqual((await listFiles(root)).filter((file) => file.endsWith("Door.gltf")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

async function promotionWorkspace(sources) {
  const root = await tempRoot("promote");
  await mkdir(path.join(root, "catalog"), { recursive: true });
  await writeFile(path.join(root, "catalog", "sources.json"), `${JSON.stringify(sourcesDocument(sources), null, 2)}\n`);
  await writeFile(path.join(root, "catalog", "storage.json"), `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`);
  return root;
}

test("promotion of a member id pins archive and member and stores only the member", async () => {
  const sources = [archiveRecord(), memberRecord()];
  const root = await promotionWorkspace(sources);
  const archive = standardArchive();
  const expectedPath = `assets/canonical/${MEMBER_ID}/Door.gltf`;
  try {
    const prepared = await prepareAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: { schemaVersion: 1, entries: [] },
      sourceId: MEMBER_ID,
      repositoryRoot: root,
      fetchImpl: serve(archive),
    });

    assert.equal(prepared.sourceId, MEMBER_ID);
    assert.equal(prepared.relativePath, expectedPath);
    assert.equal(prepared.sha256, sha256Bytes(MEMBER_BYTES));
    assert.equal(prepared.byteLength, MEMBER_BYTES.byteLength);
    assert.deepEqual(Buffer.from(prepared.bytes), MEMBER_BYTES);

    const byId = new Map(prepared.sourcesDocument.sources.map((source) => [source.id, source]));
    assert.equal(byId.get(ARCHIVE_ID).source.sha256, sha256Bytes(archive));
    assert.equal(byId.get(ARCHIVE_ID).source.byteLength, archive.byteLength);
    assert.equal(byId.get(ARCHIVE_ID).source.url, ARCHIVE_URL);
    assert.equal(byId.get(MEMBER_ID).schemaVersion, 2);
    assert.deepEqual(byId.get(MEMBER_ID).archiveMember, { archive: ARCHIVE_ID, path: MEMBER_PATH });
    assert.deepEqual(byId.get(MEMBER_ID).source, {
      sha256: sha256Bytes(MEMBER_BYTES),
      byteLength: MEMBER_BYTES.byteLength,
    });
    assert.deepEqual(
      prepared.storageDocument.entries.map((entry) => ({ ...entry })),
      [{ schemaVersion: 1, sourceId: MEMBER_ID, storage: "git-lfs", path: expectedPath }],
    );

    const applied = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: { schemaVersion: 1, entries: [] },
      sourceId: MEMBER_ID,
      repositoryRoot: root,
      fetchImpl: serve(archive),
    });
    assert.equal(applied.status, "changed");
    assert.equal(applied.path, expectedPath);
    assert.deepEqual(await listFiles(path.join(root, "assets")), [`canonical/${MEMBER_ID}/Door.gltf`]);
    assert.deepEqual(await readFile(path.join(root, ...expectedPath.split("/"))), MEMBER_BYTES);

    const writtenSources = JSON.parse(await readFile(path.join(root, "catalog", "sources.json"), "utf8"));
    const writtenStorage = JSON.parse(await readFile(path.join(root, "catalog", "storage.json"), "utf8"));
    const writtenById = new Map(writtenSources.sources.map((source) => [source.id, source]));
    assert.equal(writtenById.get(ARCHIVE_ID).source.sha256, sha256Bytes(archive));
    assert.equal(writtenById.get(MEMBER_ID).source.sha256, sha256Bytes(MEMBER_BYTES));
    assert.deepEqual(writtenStorage.entries, [
      { schemaVersion: 1, sourceId: MEMBER_ID, storage: "git-lfs", path: expectedPath },
    ]);
    assert.equal(
      writtenStorage.entries.some((entry) => entry.sourceId === ARCHIVE_ID),
      false,
      "no storage entry for the archive",
    );

    // Idempotent re-run against the pinned documents.
    const second = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: writtenSources,
      storageDocument: writtenStorage,
      sourceId: MEMBER_ID,
      repositoryRoot: root,
      fetchImpl: serve(archive),
    });
    assert.equal(second.status, "unchanged");
    assert.equal(second.sha256, applied.sha256);
    assert.deepEqual(await listFiles(path.join(root, "assets")), [`canonical/${MEMBER_ID}/Door.gltf`]);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "catalog", "sources.json"), "utf8")),
      writtenSources,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion of a member fails closed on a changed archive or a changed member", async () => {
  const sources = [archiveRecord(), memberRecord()];
  const root = await promotionWorkspace(sources);
  const archive = standardArchive();
  try {
    await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: { schemaVersion: 1, entries: [] },
      sourceId: MEMBER_ID,
      repositoryRoot: root,
      fetchImpl: serve(archive),
    });
    const pinnedSources = JSON.parse(await readFile(path.join(root, "catalog", "sources.json"), "utf8"));
    const pinnedStorage = JSON.parse(await readFile(path.join(root, "catalog", "storage.json"), "utf8"));

    // Same member bytes, but the archive changed (an extra entry).
    const repacked = zip([
      { name: MEMBER_PATH, data: MEMBER_BYTES, method: 8 },
      { name: "Pack[Standard]/README.txt", data: Buffer.from("new upstream file"), method: 0 },
    ]);
    await assert.rejects(
      prepareAssetCatalogLfsPromotion({
        providersDocument: PROVIDERS_DOCUMENT,
        sourcesDocument: pinnedSources,
        storageDocument: pinnedStorage,
        sourceId: MEMBER_ID,
        repositoryRoot: root,
        fetchImpl: serve(repacked),
      }),
      new RegExp(escapeRegExp(ARCHIVE_ID)),
    );

    // The member changed; drop the archive pin so only the member pin can catch it.
    const memberOnlyPin = {
      ...pinnedSources,
      sources: pinnedSources.sources.map((source) =>
        source.id === ARCHIVE_ID ? { ...source, source: { url: ARCHIVE_URL, path: "pack.zip" } } : source,
      ),
    };
    await assert.rejects(
      prepareAssetCatalogLfsPromotion({
        providersDocument: PROVIDERS_DOCUMENT,
        sourcesDocument: memberOnlyPin,
        storageDocument: pinnedStorage,
        sourceId: MEMBER_ID,
        repositoryRoot: root,
        fetchImpl: serve(standardArchive(Buffer.from("changed door bytes"))),
      }),
      new RegExp(escapeRegExp(MEMBER_ID)),
    );

    // A tampered canonical member payload is not overwritten.
    await writeFile(path.join(root, "assets", "canonical", MEMBER_ID, "Door.gltf"), Buffer.from("tampered"));
    await assert.rejects(
      applyAssetCatalogLfsPromotion({
        providersDocument: PROVIDERS_DOCUMENT,
        sourcesDocument: pinnedSources,
        storageDocument: pinnedStorage,
        sourceId: MEMBER_ID,
        repositoryRoot: root,
        fetchImpl: serve(archive),
      }),
      /hash mismatch|byte length mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion of the archive source itself still works as a version 1 promotion", async () => {
  const sources = [archiveRecord(), memberRecord()];
  const root = await promotionWorkspace(sources);
  const archive = standardArchive();
  try {
    const applied = await applyAssetCatalogLfsPromotion({
      providersDocument: PROVIDERS_DOCUMENT,
      sourcesDocument: sourcesDocument(sources),
      storageDocument: { schemaVersion: 1, entries: [] },
      sourceId: ARCHIVE_ID,
      repositoryRoot: root,
      fetchImpl: serve(archive),
    });
    assert.equal(applied.path, `assets/canonical/${ARCHIVE_ID}/pack.zip`);
    assert.deepEqual(await readFile(path.join(root, ...applied.path.split("/"))), archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Storage verification and consumers
// ---------------------------------------------------------------------------

function pinnedCatalogSources(archive) {
  return [
    archiveRecord({ source: { url: ARCHIVE_URL, path: "pack.zip", sha256: sha256Bytes(archive), byteLength: archive.byteLength } }),
    memberRecord({ source: { sha256: sha256Bytes(MEMBER_BYTES), byteLength: MEMBER_BYTES.byteLength } }),
  ];
}

const MEMBER_STORAGE_PATH = `assets/canonical/${MEMBER_ID}/Door.gltf`;
const MEMBER_STORAGE = {
  schemaVersion: 1,
  entries: [{ schemaVersion: 1, sourceId: MEMBER_ID, storage: "git-lfs", path: MEMBER_STORAGE_PATH }],
};

test("storage: a member's canonical path is assets/canonical/<member id>/<basename of member path>", () => {
  const archive = standardArchive();
  const [, member] = pinnedCatalogSources(archive);
  assert.equal(canonicalAssetStoragePath(member), MEMBER_STORAGE_PATH);

  const catalog = catalogOf(pinnedCatalogSources(archive));
  createAssetCatalogStorageManifest({ catalog, entries: MEMBER_STORAGE.entries });
  assert.throws(() =>
    createAssetCatalogStorageManifest({
      catalog,
      entries: [{ schemaVersion: 1, sourceId: MEMBER_ID, storage: "git-lfs", path: `assets/canonical/${MEMBER_ID}/${MEMBER_PATH}` }],
    }),
  );
});

test("storage: hydrated member bytes must match the member pin", async () => {
  const archive = standardArchive();
  const catalog = catalogOf(pinnedCatalogSources(archive));
  const entry = MEMBER_STORAGE.entries[0];
  verifyAssetCatalogStorageBytes(catalog, entry, MEMBER_BYTES);
  assert.throws(() => verifyAssetCatalogStorageBytes(catalog, entry, archive), /mismatch/);
  assert.throws(() => verifyAssetCatalogStorageBytes(catalog, entry, Buffer.from("drifted")), /mismatch/);

  const storageRoot = await tempRoot("storage");
  try {
    const absolute = path.join(storageRoot, ...MEMBER_STORAGE_PATH.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, MEMBER_BYTES);
    const read = await readAssetCatalogStorageSource({
      catalog,
      storage: MEMBER_STORAGE,
      sourceId: MEMBER_ID,
      storageRoot,
    });
    assert.deepEqual(read.bytes, MEMBER_BYTES);
    assert.equal(read.source.id, MEMBER_ID);

    await writeFile(
      absolute,
      `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256Bytes(MEMBER_BYTES)}\nsize ${MEMBER_BYTES.byteLength}\n`,
    );
    await assert.rejects(
      readAssetCatalogStorageSource({ catalog, storage: MEMBER_STORAGE, sourceId: MEMBER_ID, storageRoot }),
      /not hydrated/,
    );
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("consumers: importing a member records archiveSourceId, archiveSha256 and archiveMemberPath", async () => {
  const archive = standardArchive();
  const catalog = catalogOf(pinnedCatalogSources(archive));
  const storageRoot = await tempRoot("consumer-storage");
  const objectStoreRoot = await tempRoot("consumer-objects");
  try {
    const absolute = path.join(storageRoot, ...MEMBER_STORAGE_PATH.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, MEMBER_BYTES);

    const options = { catalog, storage: MEMBER_STORAGE, sourceId: MEMBER_ID, storageRoot, objectStoreRoot };
    const first = await importAssetCatalogStorageSource(options);
    const second = await importAssetCatalogStorageSource(options);
    assert.equal(first.status, "changed");
    assert.equal(second.status, "unchanged");
    assert.equal(first.asset.sha256, sha256Bytes(MEMBER_BYTES));
    assert.equal(first.asset.byteLength, MEMBER_BYTES.byteLength);
    assert.equal(first.asset.kind, "mesh");
    assert.equal(first.asset.mediaType, "model/gltf+json");
    assert.equal(first.asset.metadata.catalog.id, MEMBER_ID);
    assert.equal(first.asset.metadata.catalog.license.spdx, LICENSE.spdx);

    assert.equal(provenanceField(first.asset.metadata, "archiveSourceId"), ARCHIVE_ID);
    assert.equal(provenanceField(first.asset.metadata, "archiveSha256"), sha256Bytes(archive));
    assert.equal(provenanceField(first.asset.metadata, "archiveMemberPath"), MEMBER_PATH);

    await writeFile(absolute, Buffer.from("drifted"));
    await assert.rejects(importAssetCatalogStorageSource(options), /mismatch/);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
    await rm(objectStoreRoot, { recursive: true, force: true });
  }
});

test("consumers: version 1 imports carry no archive provenance fields", async () => {
  const archive = standardArchive();
  const [archiveSource] = pinnedCatalogSources(archive);
  const catalog = catalogOf([archiveSource]);
  const storage = {
    schemaVersion: 1,
    entries: [{ schemaVersion: 1, sourceId: ARCHIVE_ID, storage: "git-lfs", path: `assets/canonical/${ARCHIVE_ID}/pack.zip` }],
  };
  const storageRoot = await tempRoot("consumer-v1-storage");
  const objectStoreRoot = await tempRoot("consumer-v1-objects");
  try {
    const absolute = path.join(storageRoot, "assets", "canonical", ARCHIVE_ID, "pack.zip");
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, archive);
    const imported = await importAssetCatalogStorageSource({
      catalog,
      storage,
      sourceId: ARCHIVE_ID,
      storageRoot,
      objectStoreRoot,
    });
    assert.equal(imported.asset.metadata.catalog.id, ARCHIVE_ID);
    for (const key of ["archiveSourceId", "archiveSha256", "archiveMemberPath"]) {
      assert.equal(provenanceField(imported.asset.metadata, key), undefined, key);
    }
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
    await rm(objectStoreRoot, { recursive: true, force: true });
  }
});
