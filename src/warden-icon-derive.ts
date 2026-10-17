/**
 * Derive and export the approved Warden ability icons (asset-tooling#211, Decision Atlas 4.1.3).
 *
 * Re-verifies the review folder, derives each master's 512/64/48/32 px PNGs through the existing
 * image.decode@1, image.resize@1 and image.encode.png@1 operations, and exports exactly the sha256 values
 * that `export-selection.json` names as an approved-png-v1 bundle with `exportAssetBundle`.
 */
import path from "node:path";

import { APPROVED_IMAGE_BUNDLE_PROFILE, exportAssetBundle, verifyAssetBundle } from "./asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { executeImageDecodeOperation, executeImageEncodePngOperation } from "./image-codec-operations.js";
import { executeImageResizeOperation } from "./image-operations.js";
import { createAssetRef, type AssetRef, type CanonicalJsonObject } from "./operations.js";
import type { WardenCandidate } from "./warden-icon-review.js";
import {
  WARDEN_DERIVED_SIZES,
  WARDEN_EXPORT_SELECTION_FILE,
  WARDEN_EXPORT_VARIANTS,
  loadWardenExportSelection,
  type WardenExportSelection,
  type WardenExportVariant,
} from "./warden-icon-export.js";

function single(outputs: Record<string, unknown>): AssetRef {
  return createAssetRef(outputs.output);
}

function masterMetadata(candidate: WardenCandidate, selection: WardenExportSelection): CanonicalJsonObject {
  return {
    width: candidate.width,
    height: candidate.height,
    review: { manifest: "review/warden-icons/candidates.json", candidate: candidate.id, set: candidate.set, briefs: candidate.briefs },
    generation: JSON.parse(JSON.stringify(candidate.provenance)),
    license: { ...selection.license },
  };
}

/**
 * Derive the 512/64/48/32 px PNGs of one master through image.decode@1 → image.resize@1 → image.encode.png@1
 * in the object store at `root`. Returns the stored PNG AssetRefs (with derivation provenance) by variant.
 */
async function deriveVariants(root: string, candidate: WardenCandidate, selection: WardenExportSelection): Promise<Map<WardenExportVariant, { ref: AssetRef; bytes: Buffer }>> {
  const stored = await storeAssetObject(root, { bytes: candidate.bytes, kind: "image", mediaType: "image/png", metadata: masterMetadata(candidate, selection) });
  const variants = new Map<WardenExportVariant, { ref: AssetRef; bytes: Buffer }>([["master", { ref: stored.asset, bytes: candidate.bytes }]]);
  const decoded = single((await executeImageDecodeOperation(root, { inputs: { source: stored.asset } })).outputs);
  // Resize results keyed by the exact edge they come from, so shared prefixes run once.
  const resized = new Map<string, AssetRef>();
  const { filter, compressionLevel, chains } = selection.derivation;
  for (const size of WARDEN_DERIVED_SIZES) {
    const chain = chains[String(size)]!;
    const steps: CanonicalJsonObject[] = [{ operation: "image.decode@1", input: candidate.sha256, output: decoded.sha256 }];
    let current = decoded;
    let currentSize = candidate.width;
    for (const step of chain) {
      if (step > currentSize) throw new Error(`derivation chain for ${size} px would upscale the ${currentSize} px image`);
      if (step === currentSize) continue;
      const edge = `${current.sha256}->${step}`;
      let next = resized.get(edge);
      if (!next) {
        next = single((await executeImageResizeOperation(root, { parameters: { width: step, height: step, filter }, inputs: { source: current } })).outputs);
        resized.set(edge, next);
      }
      steps.push({ operation: "image.resize@1", parameters: { width: step, height: step, filter }, input: current.sha256, output: next.sha256 });
      current = next;
      currentSize = step;
    }
    const encoded = single((await executeImageEncodePngOperation(root, { parameters: { compressionLevel }, inputs: { source: current } })).outputs);
    steps.push({ operation: "image.encode.png@1", parameters: { compressionLevel }, input: current.sha256, output: encoded.sha256 });
    const pngBytes = Buffer.from(await resolveAssetObject(root, encoded));
    const ref = (await storeAssetObject(root, {
      bytes: pngBytes,
      kind: "image",
      mediaType: "image/png",
      metadata: {
        width: size,
        height: size,
        derivedFrom: { candidate: candidate.id, sha256: candidate.sha256, width: candidate.width },
        derivation: steps,
        license: { ...selection.license },
      },
    })).asset;
    variants.set(String(size) as WardenExportVariant, { ref, bytes: pngBytes });
  }
  return variants;
}

export interface WardenExportRun {
  selection: WardenExportSelection;
  /** Derived sha256 by key and variant, whether or not the selection names them yet. */
  derived: Record<string, Record<WardenExportVariant, string>>;
  manifestRef?: AssetRef;
  files?: string[];
  bytesWritten?: number;
  manifestStatus?: "changed" | "unchanged";
}

/**
 * Re-verify the review folder, derive every variant and, unless `deriveOnly`, export the approved-png-v1
 * bundle to `outputDirectory` (default: the selection's bundle folder). Every variant's sha256 must be
 * named by the selection; a derivative whose bytes differ (for example from another FFmpeg build) fails
 * before the export directory changes.
 */
export async function exportApprovedWardenIcons({
  root,
  reviewDirectory,
  outputDirectory,
  deriveOnly = false,
}: {
  root: string;
  reviewDirectory: string;
  outputDirectory?: string;
  deriveOnly?: boolean;
}): Promise<WardenExportRun> {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Warden export root must be an absolute path");
  const { selection, review } = await loadWardenExportSelection(reviewDirectory);
  const derived: WardenExportRun["derived"] = {};
  const assets: { key: string; variant: string; approved: { sha256: string } }[] = [];
  const inputs: AssetRef[] = [];
  for (const entry of selection.selections) {
    const candidate = review.candidates.find((item) => item.id === entry.candidate)!;
    const variants = await deriveVariants(root, candidate, selection);
    derived[entry.key] = Object.fromEntries([...variants].map(([variant, value]) => [variant, value.ref.sha256])) as Record<WardenExportVariant, string>;
    for (const variant of WARDEN_EXPORT_VARIANTS) {
      const value = variants.get(variant)!;
      const named = entry.variants[variant];
      if (deriveOnly) continue;
      if (named === undefined) throw new Error(`${entry.key}/${variant} is not named in ${WARDEN_EXPORT_SELECTION_FILE}; derived sha256 ${value.ref.sha256}`);
      if (named !== value.ref.sha256) {
        throw new Error(`${entry.key}/${variant} derived sha256 ${value.ref.sha256} differs from the named ${named}; the committed export stays unchanged`);
      }
      assets.push({ key: entry.key, variant, approved: { sha256: named } });
      inputs.push(value.ref);
    }
  }
  if (deriveOnly) return { selection, derived };
  const directory = path.resolve(outputDirectory ?? path.join(path.resolve(reviewDirectory), selection.bundle));
  const result = await exportAssetBundle(root, directory, { parameters: { profile: APPROVED_IMAGE_BUNDLE_PROFILE, assets }, inputs: { assets: inputs } });
  await verifyAssetBundle(directory, result.manifest, { profile: APPROVED_IMAGE_BUNDLE_PROFILE });
  return { selection, derived, manifestRef: result.manifest, files: result.files, bytesWritten: result.bytesWritten, manifestStatus: result.manifestStatus };
}

