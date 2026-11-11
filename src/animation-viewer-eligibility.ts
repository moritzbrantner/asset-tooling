// Which catalog sources the rigged source animation viewer (#111) accepts.
// Shared by the Pages build (the "Inspect animation" link on asset pages) and
// the viewer client, which re-checks the runtime catalog.json entry before it
// fetches anything. Contract: docs/animation-viewer.md.

export const ANIMATION_VIEWER_MEDIA_TYPES: readonly string[] = ["model/gltf-binary", "model/gltf+json"];
export const ANIMATION_VIEWER_REQUIRED_TAG = "animation";
/** The rig kinds the viewer plays, by catalog tag: a skinned rig, or the quadruped-rigid animals of #128. */
export const ANIMATION_VIEWER_RIG_TAGS: readonly string[] = ["skinning", "quadruped-rigid"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The viewer's rig kind of a catalog entry, or `null` when its tags name none or both. */
export function animationViewerRigKind(entry: unknown): "skinned" | "quadruped-rigid" | null {
  const tags = record(entry)?.tags;
  if (!Array.isArray(tags)) return null;
  const skinned = tags.includes("skinning"), rigid = tags.includes("quadruped-rigid");
  return skinned === rigid ? null : skinned ? "skinned" : "quadruped-rigid";
}

/**
 * Why a catalog entry cannot be inspected in the viewer, or `null` when it can.
 * Eligible: a `mesh` source in glTF/GLB form, tagged `animation` and exactly one
 * rig kind (`skinning` or `quadruped-rigid`), whose source URL is pinned by
 * SHA-256 and byte length.
 */
export function animationViewerIneligibility(entry: unknown): string | null {
  const asset = record(entry);
  if (!asset) return "the catalog entry is not an object";
  if (asset.kind !== "mesh") return "it is not a mesh source";
  if (typeof asset.mediaType !== "string" || !ANIMATION_VIEWER_MEDIA_TYPES.includes(asset.mediaType)) {
    return "it is not a glTF or GLB source";
  }
  const tags = Array.isArray(asset.tags) ? asset.tags : [];
  if (!tags.includes(ANIMATION_VIEWER_REQUIRED_TAG)) return `it is not tagged ${ANIMATION_VIEWER_REQUIRED_TAG}`;
  if (animationViewerRigKind(asset) === null) {
    return ANIMATION_VIEWER_RIG_TAGS.every((tag) => tags.includes(tag))
      ? "it is tagged both skinning and quadruped-rigid"
      : "it is not tagged skinning or quadruped-rigid";
  }
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
