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
