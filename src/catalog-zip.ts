// Minimal, fail-closed reader for one member of a zip archive (#118).
//
// It parses the end-of-central-directory record and the central directory,
// finds exactly one entry whose raw name bytes equal the requested path, and
// extracts it under the rules in docs/catalog.md ("Archive-member sources").
// Decompression uses Node's raw inflate with an output cap.
import { crc32, inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const HOST_UNIX = 3;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_REGULAR = 0o100000;
const DOS_DIRECTORY = 0x10;
const DOS_VOLUME_LABEL = 0x08;

function fail(message) {
  throw new Error(`zip archive: ${message}`);
}

function entryFail(name, message) {
  throw new Error(`zip archive entry '${name}': ${message}`);
}

function hasZip64Extra(extra) {
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (id === ZIP64_EXTRA_ID) return true;
    offset += 4 + size;
  }
  return false;
}

function findEndOfCentralDirectory(bytes) {
  if (bytes.byteLength < EOCD_SIZE) fail("too short to contain an end-of-central-directory record");
  const lowest = Math.max(0, bytes.byteLength - EOCD_SIZE - MAX_COMMENT);
  for (let offset = bytes.byteLength - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + EOCD_SIZE + commentLength === bytes.byteLength) return offset;
  }
  return fail("no end-of-central-directory record");
}

function readCentralDirectory(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    fail("ZIP64 archives are not supported");
  }
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    fail("multi-disk archives are not supported");
  }
  if (totalEntries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    fail("ZIP64 archives are not supported");
  }
  if (offset + size > eocd) fail("central directory lies outside the archive");

  const entries = [];
  let cursor = offset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_SIZE > offset + size) fail("central directory is truncated");
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) fail("central directory entry has a bad signature");
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const end = cursor + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (end > offset + size) fail("central directory is truncated");
    const nameStart = cursor + CENTRAL_SIZE;
    entries.push({
      versionMadeBy: bytes.readUInt16LE(cursor + 4),
      flags: bytes.readUInt16LE(cursor + 8),
      method: bytes.readUInt16LE(cursor + 10),
      crc32: bytes.readUInt32LE(cursor + 16),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      uncompressedSize: bytes.readUInt32LE(cursor + 24),
      diskStart: bytes.readUInt16LE(cursor + 34),
      externalAttributes: bytes.readUInt32LE(cursor + 38),
      localHeaderOffset: bytes.readUInt32LE(cursor + 42),
      nameBytes: bytes.subarray(nameStart, nameStart + nameLength),
      extra: bytes.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
    });
    cursor = end;
  }
  if (cursor !== offset + size) fail("central directory size does not match its entries");
  return { entries, centralDirectoryOffset: offset };
}

function displayName(entry) {
  return entry.nameBytes.toString("utf8");
}

/**
 * Lists the central directory of a zip archive without extracting anything.
 * Used for inspection and diagnostics; extraction rules are applied only by
 * extractZipMember.
 */
export function listZipEntries(bytesValue) {
  const bytes = Buffer.from(bytesValue.buffer, bytesValue.byteOffset, bytesValue.byteLength);
  return readCentralDirectory(bytes).entries.map((entry) => ({
    name: displayName(entry),
    versionMadeBy: entry.versionMadeBy,
    flags: entry.flags,
    method: entry.method,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    externalAttributes: entry.externalAttributes,
  }));
}

function assertRegularFile(entry, name) {
  if (name.endsWith("/")) entryFail(name, "is a directory");
  const host = entry.versionMadeBy >>> 8;
  const dosAttributes = entry.externalAttributes & 0xff;
  if (dosAttributes & DOS_DIRECTORY) entryFail(name, "is a directory");
  if (dosAttributes & DOS_VOLUME_LABEL) entryFail(name, "is a volume label");
  if (host === HOST_UNIX) {
    const type = (entry.externalAttributes >>> 16) & UNIX_TYPE_MASK;
    if (type !== 0 && type !== UNIX_REGULAR) {
      entryFail(name, `is not a regular file (unix mode ${((entry.externalAttributes >>> 16) & 0xffff).toString(8)})`);
    }
  }
}

function assertSupportedHeader(entry, name) {
  if (entry.flags & FLAG_ENCRYPTED) entryFail(name, "is encrypted");
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    entryFail(name, `uses unsupported compression method ${entry.method}`);
  }
  // Only bit 3 (sizes and CRC in a data descriptor) and bit 11 (UTF-8 names) are accepted.
  if (entry.flags & ~(FLAG_DATA_DESCRIPTOR | FLAG_UTF8)) entryFail(name, `uses unsupported general-purpose flags 0x${entry.flags.toString(16)}`);
  if (
    entry.compressedSize === 0xffffffff ||
    entry.uncompressedSize === 0xffffffff ||
    entry.localHeaderOffset === 0xffffffff ||
    hasZip64Extra(entry.extra)
  ) {
    entryFail(name, "uses ZIP64 fields");
  }
  if (entry.diskStart !== 0) entryFail(name, "starts on another disk");
  if (entry.method === METHOD_STORED && entry.compressedSize !== entry.uncompressedSize) {
    entryFail(name, "is stored but its compressed and uncompressed sizes differ");
  }
}

function readLocalPayload(bytes, entry, name, centralDirectoryOffset) {
  const offset = entry.localHeaderOffset;
  if (offset + LOCAL_SIZE > centralDirectoryOffset) entryFail(name, "local header lies outside the archive data");
  if (bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE) entryFail(name, "local header has a bad signature");
  const flags = bytes.readUInt16LE(offset + 6);
  const method = bytes.readUInt16LE(offset + 8);
  const localCrc = bytes.readUInt32LE(offset + 14);
  const compressedSize = bytes.readUInt32LE(offset + 18);
  const uncompressedSize = bytes.readUInt32LE(offset + 22);
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const nameStart = offset + LOCAL_SIZE;
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart > centralDirectoryOffset) entryFail(name, "local header lies outside the archive data");

  if (!bytes.subarray(nameStart, nameStart + nameLength).equals(entry.nameBytes)) {
    entryFail(name, "local header name differs from the central directory");
  }
  if (method !== entry.method) entryFail(name, "local header compression method differs from the central directory");
  if ((flags & (FLAG_ENCRYPTED | FLAG_DATA_DESCRIPTOR)) !== (entry.flags & (FLAG_ENCRYPTED | FLAG_DATA_DESCRIPTOR))) {
    entryFail(name, "local header flags differ from the central directory");
  }
  if (hasZip64Extra(bytes.subarray(nameStart + nameLength, dataStart))) entryFail(name, "uses ZIP64 fields");
  // With a data descriptor (bit 3) the local CRC and sizes may be zero; the
  // central directory is then authoritative. Non-zero local values must agree.
  const deferred = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
  const agrees = (local, central) => local === central || (deferred && local === 0);
  if (!agrees(compressedSize, entry.compressedSize)) {
    entryFail(name, "local header compressed size differs from the central directory");
  }
  if (!agrees(uncompressedSize, entry.uncompressedSize)) {
    entryFail(name, "local header uncompressed size differs from the central directory");
  }
  if (!agrees(localCrc, entry.crc32)) entryFail(name, "local header CRC-32 differs from the central directory");

  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralDirectoryOffset) entryFail(name, "compressed data extends past the archive data");
  return bytes.subarray(dataStart, dataEnd);
}

function decompress(payload, entry, name) {
  if (entry.method === METHOD_STORED) return Buffer.from(payload);
  try {
    // The cap makes inflate stop as soon as output exceeds the declared size.
    return inflateRawSync(payload, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch (error) {
    if (error && error.code === "ERR_BUFFER_TOO_LARGE") {
      return entryFail(name, `inflates past its declared size of ${entry.uncompressedSize} bytes`);
    }
    return entryFail(name, `cannot be inflated: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extracts exactly one member from zip archive bytes. `memberPath` is compared
 * byte-for-byte (UTF-8) with central-directory names; no case or Unicode
 * folding is applied. Every failure names the entry.
 */
export function extractZipMember(bytesValue, memberPath) {
  if (!Buffer.isBuffer(bytesValue) && !(bytesValue instanceof Uint8Array)) {
    throw new Error("zip archive bytes must be a Buffer or Uint8Array");
  }
  if (typeof memberPath !== "string" || memberPath.length === 0) {
    throw new Error("zip member path must be a non-empty string");
  }
  const bytes = Buffer.from(bytesValue.buffer, bytesValue.byteOffset, bytesValue.byteLength);
  const wanted = Buffer.from(memberPath, "utf8");
  const { entries, centralDirectoryOffset } = readCentralDirectory(bytes);
  const matches = entries.filter((entry) => entry.nameBytes.equals(wanted));
  if (matches.length === 0) entryFail(memberPath, "is not present in the archive");
  if (matches.length > 1) entryFail(memberPath, `appears ${matches.length} times in the central directory`);
  const [entry] = matches;

  assertRegularFile(entry, memberPath);
  assertSupportedHeader(entry, memberPath);
  const payload = readLocalPayload(bytes, entry, memberPath, centralDirectoryOffset);
  const data = decompress(payload, entry, memberPath);
  if (data.byteLength !== entry.uncompressedSize) {
    entryFail(memberPath, `inflated to ${data.byteLength} bytes, expected ${entry.uncompressedSize}`);
  }
  if (crc32(data) >>> 0 !== entry.crc32) entryFail(memberPath, "CRC-32 does not match");
  return data;
}
