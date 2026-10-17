/**
 * Approved Warden ability-icon export (asset-tooling#211, Decision Atlas 4.1.3).
 *
 * `review/warden-icons/export-selection.json` records the owner's selection of four review candidates
 * and names the exact sha256 of each master and of its 512/64/48/32 px derivatives. This module turns
 * that selection into an `approved-png-v1` bundle through the existing operations: the candidate bytes
 * are re-verified by the review loader, derivatives come from `image.decode@1`, `image.resize@1` and
 * `image.encode.png@1`, and `exportAssetBundle` commits the bundle. Naming the sha256 values in the
 * export is the approval act; nothing outside the export claims approval.
 *
 * The committed bundle lives at `review/warden-icons/approved/` (Git LFS PNGs plus a plain-JSON
 * manifest) with `export.ref.json`, the manifest AssetRef consumers pin. This module parses the selection
 * and verifies the committed export; `warden-icon-derive.ts` derives and exports it.
 */
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";

import {
  APPROVED_IMAGE_BUNDLE_PROFILE,
  readAssetBundleAsset,
  verifyAssetBundle,
  type ApprovedImageBundleManifest,
} from "./asset-bundle.js";
import { canonicalJson } from "./canonical.js";
import { sha256Bytes } from "./hash.js";
import { createAssetRef, type AssetRef } from "./operations.js";
import { WARDEN_ABILITIES, loadWardenCandidateReview, type WardenCandidateReview } from "./warden-icon-review.js";

export const WARDEN_EXPORT_SELECTION_FILE = "export-selection.json";
export const WARDEN_EXPORT_REF_FILE = "export.ref.json";
/** Every key carries the exact master plus these derived square sizes. */
export const WARDEN_EXPORT_VARIANTS = ["master", "512", "64", "48", "32"] as const;
export type WardenExportVariant = (typeof WARDEN_EXPORT_VARIANTS)[number];
export const WARDEN_DERIVED_SIZES = [512, 64, 48, 32] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const BUNDLE_DIRECTORY = /^[a-z0-9][a-z0-9-]*$/;

export interface WardenExportSelectionEntry {
  key: string;
  name: string;
  candidate: string;
  variants: Partial<Record<WardenExportVariant, string>>;
}

export interface WardenExportSelection {
  schemaVersion: 1;
  profile: typeof APPROVED_IMAGE_BUNDLE_PROFILE;
  bundle: string;
  ownerSelection: { date: string; issue: string; message: string; candidateSet: string };
  license: { outputs: string; models: string; attribution: string };
  derivation: { filter: "bilinear"; compressionLevel: number; chains: Record<string, number[]> };
  selections: WardenExportSelectionEntry[];
  [key: string]: unknown;
}

export interface WardenApprovedImage {
  key: string;
  name: string;
  candidate: string;
  variant: WardenExportVariant;
  sha256: string;
  width: number;
  bytes: Buffer;
}

export interface WardenApprovedExport {
  selection: WardenExportSelection;
  directory: string;
  manifestRef: AssetRef;
  manifest: ApprovedImageBundleManifest;
  images: WardenApprovedImage[];
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function pngWidth(bytes: Buffer): number {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error("approved Warden image is not a PNG");
  const width = bytes.readUInt32BE(16);
  if (width !== bytes.readUInt32BE(20)) throw new Error("approved Warden image must be square");
  return width;
}

/**
 * Parse `export-selection.json` and check it against the verified review: exactly the four Warden
 * keys in order, each naming one candidate of the owner's candidate set whose master sha256 equals the
 * candidate's pinned bytes, and an owner message that names every selected candidate.
 */
export function parseWardenExportSelection(value: unknown, review: WardenCandidateReview): WardenExportSelection {
  const selection = record(value, "Warden export selection");
  if (selection.schemaVersion !== 1) throw new Error("Warden export selection schemaVersion must be 1");
  if (selection.profile !== APPROVED_IMAGE_BUNDLE_PROFILE) throw new Error(`Warden export selection profile must be ${APPROVED_IMAGE_BUNDLE_PROFILE}`);
  if (typeof selection.bundle !== "string" || !BUNDLE_DIRECTORY.test(selection.bundle)) throw new Error("Warden export selection bundle must be a directory name in the review folder");
  const owner = record(selection.ownerSelection, "Warden export ownerSelection");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(owner.date, "ownerSelection.date"))) throw new Error("ownerSelection.date must be YYYY-MM-DD");
  text(owner.issue, "ownerSelection.issue");
  const message = text(owner.message, "ownerSelection.message");
  const set = review.sets.find((entry) => entry.id === owner.candidateSet);
  if (!set) throw new Error(`ownerSelection.candidateSet ${JSON.stringify(owner.candidateSet)} is not a listed candidate set`);
  const license = record(selection.license, "Warden export license");
  for (const field of ["outputs", "models", "attribution"]) text(license[field], `license.${field}`);
  const derivation = record(selection.derivation, "Warden export derivation");
  if (derivation.filter !== "bilinear") throw new Error("derivation.filter must be bilinear");
  if (!Number.isSafeInteger(derivation.compressionLevel) || (derivation.compressionLevel as number) < 0 || (derivation.compressionLevel as number) > 9) {
    throw new Error("derivation.compressionLevel must be 0..9");
  }
  const chains = record(derivation.chains, "derivation.chains");
  for (const size of WARDEN_DERIVED_SIZES) {
    const chain = chains[String(size)];
    if (!Array.isArray(chain) || chain.length === 0 || chain.at(-1) !== size
      || chain.some((step, index) => !Number.isSafeInteger(step) || step < size || (index > 0 && step >= chain[index - 1]))) {
      throw new Error(`derivation.chains.${size} must be a strictly decreasing list of sizes ending at ${size}`);
    }
  }
  if (Object.keys(chains).length !== WARDEN_DERIVED_SIZES.length) throw new Error("derivation.chains must list exactly the 512, 64, 48 and 32 px chains");

  const entries = selection.selections;
  if (!Array.isArray(entries) || entries.length !== WARDEN_ABILITIES.length) throw new Error(`Warden export must select exactly ${WARDEN_ABILITIES.length} abilities`);
  const selections = WARDEN_ABILITIES.map((ability, index) => {
    const entry = record(entries[index], `Warden export selection ${index + 1}`);
    if (entry.key !== ability.id || entry.name !== ability.name) throw new Error(`Warden export selection ${index + 1} must be ${ability.id} (${ability.name})`);
    const candidateId = text(entry.candidate, `${ability.id} candidate`);
    const candidate = review.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error(`${ability.id} candidate ${candidateId} is not in the candidates manifest`);
    if (candidate.ability !== ability.id) throw new Error(`${ability.id} candidate ${candidateId} belongs to ${candidate.ability}`);
    if (candidate.set !== set.id) throw new Error(`${ability.id} candidate ${candidateId} is not in the selected set ${set.id}`);
    if (!message.includes(candidateId)) throw new Error(`ownerSelection.message does not name ${candidateId}`);
    const variants = record(entry.variants, `${ability.id} variants`);
    for (const [variant, sha] of Object.entries(variants)) {
      if (!(WARDEN_EXPORT_VARIANTS as readonly string[]).includes(variant)) throw new Error(`${ability.id} variant '${variant}' is unknown`);
      if (typeof sha !== "string" || !SHA256.test(sha)) throw new Error(`${ability.id}/${variant} must name a lowercase sha256`);
    }
    if (variants.master !== candidate.sha256) {
      throw new Error(`${ability.id} master sha256 ${String(variants.master)} is not the pinned bytes of ${candidateId} (${candidate.sha256})`);
    }
    return { key: ability.id, name: ability.name, candidate: candidateId, variants: variants as WardenExportSelectionEntry["variants"] };
  });
  return { ...(selection as WardenExportSelection), selections };
}

async function readJsonFile(file: string, location: string): Promise<unknown> {
  const stats = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`${location} is missing`);
    throw error;
  });
  if (!stats.isFile()) throw new Error(`${location} must be a regular file`);
  return JSON.parse(await readFile(file, "utf8"));
}

/** Whether the review folder carries an export selection at all (fixture folders do not). */
export async function hasWardenExportSelection(reviewDirectory: string): Promise<boolean> {
  return lstat(path.join(path.resolve(reviewDirectory), WARDEN_EXPORT_SELECTION_FILE)).then(() => true, () => false);
}

export async function loadWardenExportSelection(reviewDirectory: string, review?: WardenCandidateReview): Promise<{ selection: WardenExportSelection; review: WardenCandidateReview }> {
  const directory = path.resolve(reviewDirectory);
  const verified = review ?? await loadWardenCandidateReview(directory);
  const selection = parseWardenExportSelection(await readJsonFile(path.join(directory, WARDEN_EXPORT_SELECTION_FILE), WARDEN_EXPORT_SELECTION_FILE), verified);
  return { selection, review: verified };
}

/** Serialized `export.ref.json` bytes for a manifest AssetRef. */
export function wardenExportRefBytes(ref: AssetRef): Buffer {
  return Buffer.from(`${canonicalJson(ref)}\n`);
}

/**
 * Load and verify the committed approved export without ComfyUI, FFmpeg, a source store or network:
 * `export.ref.json` pins the manifest, `verifyAssetBundle` checks every payload, and the manifest must
 * name exactly the selection's keys, variants and sha256 values.
 */
export async function loadApprovedWardenExport(reviewDirectory: string, review?: WardenCandidateReview): Promise<WardenApprovedExport> {
  const { selection } = await loadWardenExportSelection(reviewDirectory, review);
  const directory = path.join(path.resolve(reviewDirectory), selection.bundle);
  const manifestRef = createAssetRef(await readJsonFile(path.join(directory, WARDEN_EXPORT_REF_FILE), `${selection.bundle}/${WARDEN_EXPORT_REF_FILE}`));
  const { manifest } = await verifyAssetBundle(directory, manifestRef, { profile: APPROVED_IMAGE_BUNDLE_PROFILE });
  const expected = selection.selections.flatMap((entry) => WARDEN_EXPORT_VARIANTS.map((variant) => `${entry.key}/${variant}=${entry.variants[variant] ?? "unnamed"}`)).sort();
  const actual = manifest.assets.map((entry) => `${entry.key}/${entry.variant}=${entry.approved.sha256}`).sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("the committed approved export does not name exactly the selection's keys, variants and sha256 values");
  const images: WardenApprovedImage[] = [];
  for (const entry of selection.selections) {
    for (const variant of WARDEN_EXPORT_VARIANTS) {
      const bytes = await readAssetBundleAsset(directory, manifest, entry.key, variant);
      const width = pngWidth(bytes);
      if (variant !== "master" && width !== Number(variant)) throw new Error(`${entry.key}/${variant} is ${width} px`);
      images.push({ key: entry.key, name: entry.name, candidate: entry.candidate, variant, sha256: sha256Bytes(bytes), width, bytes });
    }
  }
  return { selection, directory, manifestRef, manifest, images };
}
