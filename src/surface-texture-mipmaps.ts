// KTX2 mip chains for tileable surface channels (#131, docs/surface-textures.md#mipmaps). A surface tile is sampled
// with REPEAT, so its mips must be filtered as a periodic image: `ktx create --mipmap-wrap wrap`. The periodicity check
// encodes the tile and a copy rolled by half a tile, then requires every level of the second chain, rolled back, to
// equal the first. A filter that clamps at the edge fails it near the borders; the tile's interior is unaffected.
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE, type Rgba8Image } from "./image-rgba8.js";
import { executeImageEncodePngOperation } from "./image-codec-operations.js";
import { createAssetRef, type AssetRef } from "./operations.js";
import { ktxArguments, type MipmapWrap, type TextureEncoding } from "../scripts/pack-downloads.js";
import type { SurfaceChannel } from "./surface-texture-recipes.js";

/** Colour is sRGB; height, normal and roughness are linear data. UASTC keeps scalar detail that ETC1S blurs. */
export const SURFACE_CHANNEL_KTX_ENCODING: Readonly<Record<SurfaceChannel, TextureEncoding>> = Object.freeze({
  color: "uastc-srgb", height: "uastc", normal: "uastc", roughness: "uastc",
});

export type SurfaceMipLevel = { level: number; width: number; height: number; maxError: number; blockAligned: boolean };
export type SurfaceKtx2 = { bytes: Uint8Array; levels: Rgba8Image[] };

const ktxTool = () => process.env.ASSET_TOOLING_KTX ?? "ktx";
const isPowerOfTwo = (value: number) => Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;

function run(args: string[]): void {
  const result = Bun.spawnSync([ktxTool(), ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`ktx ${args[0]} failed: ${result.stderr.toString().trim()}`);
}

/** The image rolled by (dx, dy) texels with wrap-around: texel (x, y) moves to ((x + dx) mod w, (y + dy) mod h). */
export function rollRgba8({ width, height, pixels }: Rgba8Image, dx: number, dy: number): Rgba8Image {
  const out = new Uint8Array(pixels.length);
  const sx = ((dx % width) + width) % width, sy = ((dy % height) + height) % height;
  for (let y = 0; y < height; y++) {
    const target = ((y + sy) % height) * width;
    for (let x = 0; x < width; x++) out.set(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (target + (x + sx) % width) * 4);
  }
  return { width, height, pixels: out };
}

/**
 * Encode one canonical RGBA8 surface channel as KTX2 with a full mip chain, through the existing PNG encoder and
 * `ktxArguments`. Returns the file and every level transcoded back to RGBA8. Needs KTX-Software's `ktx`
 * (ASSET_TOOLING_KTX or PATH) and FFmpeg for the PNG step. Tile sides must be powers of two.
 */
export async function encodeSurfaceKtx2(
  root: string, { source, channel, mipmapWrap = "wrap" }: { source: AssetRef; channel: SurfaceChannel; mipmapWrap?: MipmapWrap },
): Promise<SurfaceKtx2> {
  const encoding = SURFACE_CHANNEL_KTX_ENCODING[channel];
  if (!encoding) throw new Error(`unknown surface channel '${String(channel)}'`);
  const image = parseRgba8Image(await resolveAssetObject(root, source));
  if (!isPowerOfTwo(image.width) || !isPowerOfTwo(image.height)) throw new Error(`surface KTX2 needs power-of-two sides, not ${image.width}x${image.height}`);
  const png = createAssetRef((await executeImageEncodePngOperation(root, { inputs: { source }, parameters: { compressionLevel: 9 } })).outputs.output);
  const scratch = await mkdtemp(path.join(tmpdir(), "surface-ktx2-"));
  try {
    const input = path.join(scratch, "in.png"), output = path.join(scratch, "out.ktx2");
    await writeFile(input, await resolveAssetObject(root, png));
    run(ktxArguments(encoding, input, output, undefined, { mipmapWrap }));
    const levels: Rgba8Image[] = [];
    for (let level = 0, width = image.width, height = image.height; ; level++, width = Math.max(1, width >> 1), height = Math.max(1, height >> 1)) {
      const raw = path.join(scratch, `level-${level}.raw`);
      run(["extract", "--level", String(level), "--transcode", "rgba8", "--raw", output, raw]);
      const pixels = new Uint8Array(await readFile(raw));
      if (pixels.length !== width * height * 4) throw new Error(`ktx level ${level} has ${pixels.length} bytes, not ${width}x${height} RGBA8`);
      levels.push({ width, height, pixels });
      if (width === 1 && height === 1) break;
    }
    return { bytes: new Uint8Array(await readFile(output)), levels };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Per-level periodicity of a surface channel's KTX2 mip chain: the largest absolute byte difference between the
 * chain and the chain of the half-tile-rolled tile, rolled back. Zero means the level tiles exactly like its source.
 * `blockAligned` levels roll by whole 4x4 compression blocks, so block compression cannot cause a difference there.
 */
export async function surfaceMipPeriodicity(
  root: string, { source, channel, mipmapWrap = "wrap" }: { source: AssetRef; channel: SurfaceChannel; mipmapWrap?: MipmapWrap },
): Promise<{ ktx2: SurfaceKtx2; levels: SurfaceMipLevel[] }> {
  const image = parseRgba8Image(await resolveAssetObject(root, source));
  const rolled = (await storeAssetObject(root, {
    bytes: encodeRgba8Image(rollRgba8(image, image.width / 2, image.height / 2)), kind: source.kind, mediaType: RGBA8_IMAGE_MEDIA_TYPE,
  })).asset;
  const ktx2 = await encodeSurfaceKtx2(root, { source, channel, mipmapWrap });
  const shifted = await encodeSurfaceKtx2(root, { source: rolled, channel, mipmapWrap });
  const levels = ktx2.levels.map((level, index) => {
    const back = rollRgba8(shifted.levels[index]!, -Math.floor(level.width / 2), -Math.floor(level.height / 2));
    let maxError = 0;
    for (let i = 0; i < level.pixels.length; i++) maxError = Math.max(maxError, Math.abs(level.pixels[i]! - back.pixels[i]!));
    return { level: index, width: level.width, height: level.height, maxError, blockAligned: level.width % 8 === 0 && level.height % 8 === 0 };
  });
  return { ktx2, levels };
}
