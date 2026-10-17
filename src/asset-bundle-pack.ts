/**
 * Deterministic release packaging for exported asset bundles (#118 Q5: a versioned GitHub Release).
 * The tar holds exactly the manifest closure plus `export.ref.json`, sorted, as ustar regular files with fixed
 * mode 0644, uid/gid 0, empty owner names and mtime 0. Packing and verification are offline; publishing the
 * tar with `gh release` is a separate, explicit distribution step.
 */
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { sha256Bytes } from "./hash.js";
import { createAssetRef, type AssetRef } from "./operations.js";
import {
  APPROVED_IMAGE_BUNDLE_PROFILE, ASSET_BUNDLE_MEDIA_TYPE, GLTF_RESOURCES_BUNDLE_PROFILE, SPRITE_ATLAS_BUNDLE_PROFILE,
  STATIC_ASSET_BUNDLE_PROFILE, listAssetBundleFiles, verifyAssetBundle, type AnyAssetBundleManifest,
} from "./asset-bundle.js";

export const ASSET_BUNDLE_REF_FILE = "export.ref.json";
const BLOCK = 512, MAX_TAR_BYTES = 512 * 1024 * 1024;
const PROFILES = [STATIC_ASSET_BUNDLE_PROFILE, SPRITE_ATLAS_BUNDLE_PROFILE, APPROVED_IMAGE_BUNDLE_PROFILE, GLTF_RESOURCES_BUNDLE_PROFILE] as const;
type Profile = typeof PROFILES[number];
export type AssetBundleTarEntry = { path: string; bytes: Buffer; mode: number; uid: number; gid: number; mtime: number };

function octal(value: number, width: number): string { return `${value.toString(8).padStart(width - 1, "0")}\0`; }
function splitName(name: string): [string, string] {
  if (Buffer.byteLength(name) <= 100) return ["", name];
  for (let index = name.lastIndexOf("/"); index > 0; index = name.lastIndexOf("/", index - 1)) {
    const prefix = name.slice(0, index), rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return [prefix, rest];
  }
  throw new Error(`bundle path '${name}' does not fit a ustar header`);
}
function header(name: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK), [prefix, base] = splitName(name);
  block.write(base, 0, "utf8"); block.write(octal(0o644, 8), 100, "ascii"); block.write(octal(0, 8), 108, "ascii"); block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii"); block.write(octal(0, 12), 136, "ascii"); block.fill(0x20, 148, 156); block.write("0", 156, "ascii");
  block.write("ustar\0", 257, "ascii"); block.write("00", 263, "ascii"); block.write(prefix, 345, "utf8");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}
/** Write sorted regular-file entries as a deterministic ustar archive. */
export function writeAssetBundleTar(entries: { path: string; bytes: Uint8Array }[]): Buffer {
  const sorted = [...entries].sort((a, b) => compareCodeUnitStrings(a.path, b.path));
  if (sorted.some((entry, index) => index > 0 && sorted[index - 1]!.path === entry.path)) throw new Error("bundle tar entries must be unique");
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    portable(entry.path);
    parts.push(header(entry.path, entry.bytes.byteLength), Buffer.from(entry.bytes), Buffer.alloc((BLOCK - (entry.bytes.byteLength % BLOCK)) % BLOCK));
  }
  return Buffer.concat([...parts, Buffer.alloc(2 * BLOCK)]);
}
function portable(name: string): string {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) || name.split("/").some((part) => part === "." || part === "..")) throw new Error(`bundle tar path '${name}' is not a portable relative path`);
  return name;
}
function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length), end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString("utf8");
}
function number(block: Buffer, start: number, length: number, name: string): number {
  const text = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`bundle tar header ${name} is not octal`);
  return Number.parseInt(text, 8);
}
/** Parse a deterministic bundle tar strictly: ustar regular files, valid checksums, zero padding, sorted unique paths. */
export function readAssetBundleTar(tar: Uint8Array): AssetBundleTarEntry[] {
  const bytes = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength), entries: AssetBundleTarEntry[] = [];
  if (bytes.byteLength > MAX_TAR_BYTES || bytes.byteLength % BLOCK) throw new Error("bundle tar must be whole 512-byte blocks within 512 MiB");
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > bytes.byteLength) throw new Error("bundle tar ends without its end-of-archive blocks");
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      if (!bytes.subarray(offset).every((byte) => byte === 0) || bytes.byteLength - offset !== 2 * BLOCK) throw new Error("bundle tar must end with exactly two zero blocks");
      break;
    }
    const expected = number(block, 148, 8, "checksum"), copy = Buffer.from(block); copy.fill(0x20, 148, 156);
    if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) throw new Error("bundle tar header checksum mismatch");
    if (field(block, 257, 6) !== "ustar" || field(block, 156, 1) !== "0") throw new Error("bundle tar must contain only ustar regular files");
    const prefix = field(block, 345, 155), name = portable(prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    const size = number(block, 124, 12, "size"), padded = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + BLOCK + padded > bytes.byteLength) throw new Error(`bundle tar entry '${name}' is truncated`);
    const data = bytes.subarray(offset + BLOCK, offset + BLOCK + size);
    if (!bytes.subarray(offset + BLOCK + size, offset + BLOCK + padded).every((byte) => byte === 0)) throw new Error(`bundle tar entry '${name}' has non-zero padding`);
    entries.push({ path: name, bytes: Buffer.from(data), mode: number(block, 100, 8, "mode"), uid: number(block, 108, 8, "uid"), gid: number(block, 116, 8, "gid"), mtime: number(block, 136, 12, "mtime") });
    offset += BLOCK + padded;
  }
  if (entries.some((entry, index) => index > 0 && compareCodeUnitStrings(entries[index - 1]!.path, entry.path) >= 0)) throw new Error("bundle tar entries must be uniquely sorted");
  if (entries.some((entry) => entry.mode !== 0o644 || entry.uid || entry.gid || entry.mtime)) throw new Error("bundle tar entries must have mode 0644, uid/gid 0 and mtime 0");
  // Every other header field (version, owner names, link/device fields, reserved bytes) must be what the writer emits.
  if (!writeAssetBundleTar(entries).equals(bytes)) throw new Error("bundle tar is not the canonical serialization of its entries (non-canonical ustar header)");
  return entries;
}
function manifestProfile(bytes: Buffer): Profile {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  const profile = value && typeof value === "object" && "profile" in value ? value.profile : undefined;
  if (!PROFILES.includes(profile as Profile)) throw new Error(`unsupported bundle profile '${String(profile)}'`);
  return profile as Profile;
}
function minimalRef(bytes: Buffer): AssetRef {
  return createAssetRef({ kind: "asset-bundle", mediaType: ASSET_BUNDLE_MEDIA_TYPE, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength });
}
async function verifyProfile(directory: string, ref: AssetRef, profile: Profile): Promise<AnyAssetBundleManifest> {
  // verifyAssetBundle's overloads are per profile; the runtime check selects the same profile explicitly.
  return (await (verifyAssetBundle as (d: string, r: unknown, o: { profile: Profile }) => Promise<{ manifest: AnyAssetBundleManifest }>)(directory, ref, { profile })).manifest;
}
/**
 * Pack a verified export directory: only `manifest.json`, its closure and a content-only `export.ref.json`
 * (the manifest AssetRef consumers pin). Retained former export files are never shipped.
 */
export async function packAssetBundle(directory: string): Promise<{ tar: Buffer; sha256: string; ref: AssetRef; files: string[] }> {
  if (!path.isAbsolute(directory)) throw new Error("bundle directory must be an absolute path");
  const manifestBytes = await readFile(path.join(directory, "manifest.json")), ref = minimalRef(manifestBytes);
  const manifest = await verifyProfile(directory, ref, manifestProfile(manifestBytes)), files = listAssetBundleFiles(manifest);
  const entries = await Promise.all(files.map(async (file) => ({ path: file, bytes: await readFile(path.join(directory, ...file.split("/"))) })));
  entries.push({ path: ASSET_BUNDLE_REF_FILE, bytes: Buffer.from(`${canonicalJson(ref)}\n`) });
  const tar = writeAssetBundleTar(entries);
  return { tar, sha256: sha256Bytes(tar), ref, files };
}
/**
 * Verify a release tar offline: optional tar sha256 pin, strict tar structure, exactly the manifest closure plus
 * `export.ref.json`, then full `verifyAssetBundle` on an extracted copy. `ref` is the consumer's own pinned
 * manifest AssetRef; without it the tar's `export.ref.json` is used, which is only as trustworthy as the tar pin.
 */
export async function verifyAssetBundleTar(tar: Uint8Array, expected: { sha256?: string; ref?: unknown } = {}) {
  if (expected.sha256 !== undefined && sha256Bytes(tar) !== expected.sha256) throw new Error("bundle tar sha256 does not match its pin");
  const entries = readAssetBundleTar(tar), byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  const refBytes = byPath.get(ASSET_BUNDLE_REF_FILE), manifestBytes = byPath.get("manifest.json");
  if (!refBytes || !manifestBytes) throw new Error(`bundle tar must contain manifest.json and ${ASSET_BUNDLE_REF_FILE}`);
  const packedRef = createAssetRef(JSON.parse(refBytes.toString("utf8")));
  const ref = expected.ref === undefined ? packedRef : createAssetRef(expected.ref);
  if (packedRef.sha256 !== ref.sha256 || packedRef.byteLength !== ref.byteLength) throw new Error(`bundle tar ${ASSET_BUNDLE_REF_FILE} does not pin the expected manifest`);
  const directory = await mkdtemp(path.join(os.tmpdir(), "asset-bundle-tar-"));
  try {
    for (const entry of entries) {
      const target = path.join(directory, ...entry.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.bytes, { flag: "wx" });
    }
    const manifest = await verifyProfile(directory, ref, manifestProfile(manifestBytes));
    const closure = [...listAssetBundleFiles(manifest), ASSET_BUNDLE_REF_FILE].sort(compareCodeUnitStrings);
    if (canonicalJson(closure) !== canonicalJson(entries.map((entry) => entry.path))) throw new Error("bundle tar contains files outside its manifest closure or omits listed files");
    return { manifest, ref, files: closure };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
