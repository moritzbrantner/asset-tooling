import assert from "node:assert/strict";
import path from "node:path";
import { createAssetRef, type AssetRef } from "asset-tooling/operations";
import { resolveAssetObject, storeAssetObject } from "asset-tooling/operations/store";
import { EFFECT_ARTWORK_PRESETS, executeEffectArtwork } from "asset-tooling/recipes/effect-artwork";
import { IMAGE_ENCODE_PNG_OPERATION, executeImageEncodePngOperation, executeImageDecodeOperation, probeImageCodecImplementation } from "asset-tooling/operations/image/codecs";
import { parseRgba8Image } from "asset-tooling/image/rgba8";
import { STATIC_ASSET_BUNDLE_PROFILE, exportAssetBundle, verifyAssetBundle, readAssetBundleAsset } from "asset-tooling/operations/bundle";

/** Explicit local generation. FFmpeg/FFprobe must already be installed; no acquisition occurs. */
export async function buildSelectedBundle(root: string) {
  // Diagnose missing tools before generating any disposable objects.
  await probeImageCodecImplementation(IMAGE_ENCODE_PNG_OPERATION, {});
  const artwork = await executeEffectArtwork(root, { parameters: EFFECT_ARTWORK_PRESETS.ring.strong });
  const encoded = await executeImageEncodePngOperation(root, {
    parameters: { compressionLevel: 9 }, inputs: { source: createAssetRef(artwork.outputs.image) },
  });
  const source = createAssetRef(encoded.outputs.output);
  const invocation = {
    parameters: { profile: STATIC_ASSET_BUNDLE_PROFILE, assets: [{ key: "feedback.ring", variant: "strong" }] },
    inputs: { assets: [source] },
  };
  const directory = path.join(root, ".artifacts", "selected-bundle");
  const result = await exportAssetBundle(root, directory, invocation);
  const independent = await exportAssetBundle(root, path.join(root, ".artifacts", "selected-bundle-cold"), invocation);
  assert.equal(independent.manifest.sha256, result.manifest.sha256, "independent export must agree");
  return { directory, ...result };
}

/** Package-only acceptance. The expected ref comes from the build, never the downloaded manifest. */
export async function consumeSelectedBundle(directory: string, expected: AssetRef, consumerRoot: string) {
  const checked = await verifyAssetBundle(directory, expected);
  const bytes = await readAssetBundleAsset(directory, checked.manifest, "feedback.ring", "strong");
  const entry = checked.manifest.assets[0];
  assert.ok(entry, "selected ring must be present");
  const imported = await storeAssetObject(consumerRoot, {
    bytes, kind: "image", mediaType: "image/png", metadata: entry.source.metadata,
  });
  const decoded = await executeImageDecodeOperation(consumerRoot, { inputs: { source: imported.asset } });
  const image = parseRgba8Image(await resolveAssetObject(consumerRoot, createAssetRef(decoded.outputs.output)));
  assert.equal(image.width, 64);
  assert.equal(image.height, 64);
  const pixel = (x: number, y: number) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
  assert.deepEqual(pixel(32, 32), [255, 210, 112, 0], "ring center stays transparent");
  assert.deepEqual(pixel(52, 32), [255, 210, 112, 255], "ring stroke retains its color and coverage");
  assert.deepEqual(pixel(0, 0), [255, 210, 112, 0], "outer border stays transparent");
  return { accepted: true, selection: "feedback.ring/strong", width: image.width, height: image.height, manifest: expected.sha256 };
}
