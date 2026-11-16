// The KTX2 encodings the baked kits share (docs/greyhaven-terrain.md, docs/kit-standard.md#textures). They live here,
// not in a kit's build script, so a kit that encodes like the terrain does not take the terrain build as a source.
import type { TextureEncoding } from "../scripts/pack-downloads.ts";

/**
 * The KTX2 (Basis Universal, KHR_texture_basisu) encoding per slot, all with a full mip chain: ETC1S (BasisLZ, qlevel
 * 160) for the base colour and for the AO/roughness/metal data map, and UASTC (quality 2, Zstandard 18) only for the
 * normal maps, which band under ETC1S (#681: a UASTC colour layer was about 1.3 MB, ETC1S about 0.4 MB).
 * `ktxArguments` (scripts/pack-downloads.ts) holds the exact `ktx create` flags.
 */
export const TERRAIN_KTX2: Readonly<Record<"baseColor" | "normal" | "metallicRoughness", TextureEncoding>> = {
  baseColor: "etc1s-srgb", normal: "uastc", metallicRoughness: "etc1s-linear",
};

/** The KTX2 encoding of a texture by the material slots it fills, as the crag kit and the terrain encode theirs. */
export function slotKtx2Encoding(slots: ReadonlySet<string>): TextureEncoding {
  if (slots.has("normalTexture")) return TERRAIN_KTX2.normal;
  if (slots.has("baseColorTexture") || slots.has("emissiveTexture")) return TERRAIN_KTX2.baseColor;
  return TERRAIN_KTX2.metallicRoughness;
}

/**
 * The longest edge a shipped KTX2 texture keeps (#681): 1024 px for a linear UASTC texture (the normal maps, whose
 * UASTC bytes cost about four times ETC1S's) and 2048 px for every other one. Larger sources are halved until they fit.
 */
export const KTX2_MAX_EDGE = { uastc: 1024, other: 2048 } as const;
export const ktx2MaxEdge = (encoding: TextureEncoding) => encoding === "uastc" ? KTX2_MAX_EDGE.uastc : KTX2_MAX_EDGE.other;
