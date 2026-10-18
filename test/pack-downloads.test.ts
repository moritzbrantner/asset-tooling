import { test } from "node:test";
import assert from "node:assert/strict";
import { ktxArguments, textureEncoding } from "../scripts/pack-downloads.ts";

test("textures are encoded by slot: UASTC for normals, sRGB ETC1S for colour, linear ETC1S for data maps", () => {
  assert.equal(textureEncoding(new Set(["normalTexture"])), "uastc");
  assert.equal(textureEncoding(new Set(["baseColorTexture"])), "etc1s-srgb");
  assert.equal(textureEncoding(new Set(["emissiveTexture"])), "etc1s-srgb");
  assert.equal(textureEncoding(new Set(["metallicRoughnessTexture", "occlusionTexture"])), "etc1s-linear");
  assert.equal(textureEncoding(new Set(["normalTexture", "occlusionTexture"])), "uastc");
  const uastc = ktxArguments("uastc", "in.png", "out.ktx2");
  assert.ok(uastc.includes("uastc") && uastc.includes("--zstd") && uastc.includes("R8G8B8A8_UNORM"));
  const color = ktxArguments("etc1s-srgb", "in.png", "out.ktx2");
  assert.ok(color.includes("basis-lz") && color.includes("R8G8B8A8_SRGB") && color.includes("--generate-mipmap"));
  assert.deepEqual(color.slice(-2), ["in.png", "out.ktx2"]);
});

test("non-power-of-two textures are resampled to the nearest power of two, and KTX2 sizes come from the header", async () => {
  const { powerOfTwo, ktx2Size } = await import("../scripts/pack-downloads.ts");
  assert.deepEqual([1008, 981, 1024, 700, 1, 3000].map(powerOfTwo), [1024, 1024, 1024, 512, 1, 4096]);
  const header = new Uint8Array(80);
  header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(header.buffer).setUint32(20, 512, true);
  new DataView(header.buffer).setUint32(24, 256, true);
  assert.deepEqual(ktx2Size(header), { width: 512, height: 256 });
  assert.throws(() => ktx2Size(new Uint8Array(80)), /not a KTX2/);
  const sized = ktxArguments("etc1s-srgb", "in.png", "out.ktx2", { width: 1024, height: 1024 });
  assert.deepEqual(sized.slice(sized.indexOf("--width"), sized.indexOf("--width") + 4), ["--width", "1024", "--height", "1024"]);
});
