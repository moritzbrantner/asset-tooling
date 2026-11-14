// The KTX2 encodings the baked kits share (docs/greyhaven-terrain.md, docs/kit-standard.md#textures). They live here,
// not in a kit's build script, so a kit that encodes like the terrain does not take the terrain build as a source.
import type { TextureEncoding } from "../scripts/pack-downloads.ts";

/**
 * The KTX2 (Basis Universal, KHR_texture_basisu) encoding per slot, all with a full mip chain: UASTC (quality 2,
 * Zstandard 18) for the base colour, whose height alpha and fine ground detail ETC1S blurs, and for the normal maps;
 * ETC1S (BasisLZ, qlevel 160) for the AO/roughness/metal data map. `ktxArguments` (scripts/pack-downloads.ts) holds the
 * exact `ktx create` flags.
 */
export const TERRAIN_KTX2: Readonly<Record<"baseColor" | "normal" | "metallicRoughness", TextureEncoding>> = {
  baseColor: "uastc-srgb", normal: "uastc", metallicRoughness: "etc1s-linear",
};

/** The KTX2 encoding of a texture by the material slots it fills, as the crag kit and the terrain encode theirs. */
export function slotKtx2Encoding(slots: ReadonlySet<string>): TextureEncoding {
  if (slots.has("normalTexture")) return TERRAIN_KTX2.normal;
  if (slots.has("baseColorTexture") || slots.has("emissiveTexture")) return TERRAIN_KTX2.baseColor;
  return TERRAIN_KTX2.metallicRoughness;
}
