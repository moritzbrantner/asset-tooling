// Which catalog sources the rigged source animation viewer (#111) accepts.
// Shared by the Pages build (the "Inspect animation" link on asset pages) and
// the viewer client, which re-checks the runtime catalog.json entry before it
// fetches anything. Contract: docs/animation-viewer.md.

export const ANIMATION_VIEWER_MEDIA_TYPES: readonly string[] = ["model/gltf-binary", "model/gltf+json"];
export const ANIMATION_VIEWER_REQUIRED_TAGS: readonly string[] = ["skinning", "animation"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Why a catalog entry cannot be inspected in the viewer, or `null` when it can.
 * Eligible: a `mesh` source in glTF/GLB form, tagged both `skinning` and
 * `animation`, whose source URL is pinned by SHA-256 and byte length.
 */
export function animationViewerIneligibility(entry: unknown): string | null {
  const asset = record(entry);
  if (!asset) return "the catalog entry is not an object";
  if (asset.kind !== "mesh") return "it is not a mesh source";
  if (typeof asset.mediaType !== "string" || !ANIMATION_VIEWER_MEDIA_TYPES.includes(asset.mediaType)) {
    return "it is not a glTF or GLB source";
  }
  const tags = Array.isArray(asset.tags) ? asset.tags : [];
  const missing = ANIMATION_VIEWER_REQUIRED_TAGS.filter((tag) => !tags.includes(tag));
  if (missing.length > 0) return `it is not tagged ${missing.join(" and ")}`;
  const source = record(asset.source);
  if (!source || typeof source.url !== "string" || source.url.length === 0) return "it has no source URL";
  if (typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(source.sha256)) return "its source has no SHA-256 pin";
  if (typeof source.byteLength !== "number" || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
    return "its source has no byte-length pin";
  }
  return null;
}

export function isAnimationViewerEligible(entry: unknown): boolean {
  return animationViewerIneligibility(entry) === null;
}

/** Relative link from a catalog asset page (`assets/<id>/`) to its viewer. */
export function animationViewerHrefFromAssetPage(id: string): string {
  return `../../viewer/?asset=${encodeURIComponent(id)}`;
}
