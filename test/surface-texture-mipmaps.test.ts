import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ktxArguments } from "../scripts/pack-downloads.ts";
import { rollRgba8, surfaceMipPeriodicity, encodeSurfaceKtx2 } from "../src/surface-texture-mipmaps.js";
import { executeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS, type SurfaceChannel } from "../src/surface-texture-recipes.js";
import { storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";

const ktx = !!Bun.which(process.env.ASSET_TOOLING_KTX ?? "ktx");
const ffmpeg = !!Bun.which("ffmpeg");
const skip = !ktx ? "requires KTX-Software's ktx CLI (ASSET_TOOLING_KTX or ktx on PATH)" : !ffmpeg ? "requires FFmpeg" : false;

test("mip generation wraps only when asked: the shared packing default is unchanged", () => {
  assert.ok(!ktxArguments("uastc", "in.png", "out.ktx2").includes("--mipmap-wrap"));
  const wrapped = ktxArguments("uastc-srgb", "in.png", "out.ktx2", undefined, { mipmapWrap: "wrap" });
  assert.deepEqual(wrapped.slice(0, 4), ["create", "--generate-mipmap", "--mipmap-wrap", "wrap"]);
  assert.deepEqual(wrapped.slice(-2), ["in.png", "out.ktx2"]);
});

test("rolling moves every texel with wrap-around, and rolling back restores the image", () => {
  // 3x2 image, one distinct red byte per texel: value = 10 * y + x.
  const pixels = new Uint8Array(3 * 2 * 4);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) pixels.set([10 * y + x, 0, 0, 255], (y * 3 + x) * 4);
  const rolled = rollRgba8({ width: 3, height: 2, pixels }, 1, 1);
  const red = Array.from({ length: 6 }, (_, i) => rolled.pixels[i * 4]);
  // Texel (x, y) lands on ((x + 1) mod 3, (y + 1) mod 2).
  assert.deepEqual(red, [12, 10, 11, 2, 0, 1]);
  assert.deepEqual(rollRgba8(rolled, -1, -1).pixels, pixels);
  assert.deepEqual(rollRgba8(rolled, 2, 1).pixels, pixels);
});

test("wrapped KTX2 mips of every surface channel tile exactly; the clamped default does not", { skip }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surface-mipmaps-"));
  try {
    const recipe = { ...SURFACE_TEXTURE_PRESETS["soil-tilled-deep"], width: 64, height: 32, detailGridX: 32, detailGridY: 16 };
    const { outputs } = await executeSurfaceTextureRecipe(root, recipe as never);
    for (const [channel, source] of Object.entries(outputs) as [SurfaceChannel, NonNullable<(typeof outputs)[SurfaceChannel]>][]) {
      const wrap = await surfaceMipPeriodicity(root, { source, channel, mipmapWrap: "wrap" });
      assert.deepEqual(wrap.levels.map(({ width, height }) => `${width}x${height}`),
        ["64x32", "32x16", "16x8", "8x4", "4x2", "2x1", "1x1"], channel);
      assert.equal(new TextDecoder().decode(wrap.ktx2.bytes.subarray(1, 7)), "KTX 20", channel);
      for (const level of wrap.levels.filter((level) => level.blockAligned)) assert.equal(level.maxError, 0, `${channel} level ${level.level}`);
      assert.equal(wrap.levels[0]!.maxError, 0);
      const clamp = await surfaceMipPeriodicity(root, { source, channel, mipmapWrap: "clamp" });
      assert.equal(clamp.levels[0]!.maxError, 0, `${channel} base level`);
      assert.ok(clamp.levels.some((level) => level.blockAligned && level.maxError > 0), `${channel} clamped mips should break tiling`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("surface KTX2 refuses non-power-of-two tiles before encoding", { skip }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surface-mipmaps-"));
  try {
    const source = (await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width: 6, height: 4, pixels: new Uint8Array(6 * 4 * 4).fill(128) }), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    })).asset;
    await assert.rejects(encodeSurfaceKtx2(root, { source, channel: "height" }), /power-of-two sides, not 6x4/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
