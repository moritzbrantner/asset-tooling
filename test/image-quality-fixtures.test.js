import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  IMAGE_CODEC_OPERATIONS,
  createImageDecodeOperationBuildIdentity,
  executeImageDecodeOperation,
  executeImageEncodePngOperation,
} from "../src/image-codec-operations.js";
import {
  RGBA8_IMAGE_MEDIA_TYPE,
  encodeRgba8Image,
  parseRgba8Image,
} from "../src/image-rgba8.js";
import {
  executeImagePerturbationRecipe,
  imagePerturbationRecipeSha256,
  normalizeImagePerturbationRecipe,
} from "../src/image-perturbation-recipes.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

async function workspaceWithImage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-quality-fixture-"));
  const pixels = Buffer.from([
    ...pixel(220, 20, 30),
    ...pixel(40, 210, 50),
    ...pixel(60, 70, 200),
    ...pixel(240, 230, 80),
  ]);
  const stored = await storeAssetObject(root, {
    bytes: encodeRgba8Image({ width: 2, height: 2, pixels }),
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: { width: 2, height: 2, pixelFormat: "rgba8", colorSpace: "srgb", alphaMode: "straight" },
  });
  return { root, source: stored.asset, pixels };
}

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0 &&
    spawnSync("ffprobe", ["-version"], { windowsHide: true }).status === 0;
}

test("image codec registry exposes explicit standard decode and PNG encode boundaries", () => {
  assert.deepEqual(
    IMAGE_CODEC_OPERATIONS.map((operation) => operation.id),
    ["image.decode", "image.encode.png"],
  );
  const decode = IMAGE_CODEC_OPERATIONS.find((operation) => operation.id === "image.decode");
  assert.deepEqual(decode.outputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  assert.deepEqual(decode.inputs[0].mediaTypes, [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/bmp",
    "image/tiff",
  ]);
});

test("image codec fails closed when the declared runtime is unavailable", async () => {
  const { root } = await workspaceWithImage();
  const encoded = await storeAssetObject(root, {
    bytes: Buffer.from("not-an-image"),
    kind: "image",
    mediaType: "image/png",
    metadata: {},
  });
  await assert.rejects(
    () =>
      createImageDecodeOperationBuildIdentity(root, {
        inputs: { source: encoded.asset },
        runtime: { ffmpeg: "definitely-missing-ffmpeg", ffprobe: "definitely-missing-ffprobe" },
      }),
    /could not execute/i,
  );
});

test("image perturbation recipes are canonical and reject unsupported operations", () => {
  const first = {
    schemaVersion: 1,
    steps: [
      { operation: "image.exposure", parameters: { numerator: 9, denominator: 10 } },
      { operation: "image.blur", parameters: { radius: 1 } },
    ],
  };
  const reorderedKeys = {
    steps: [
      { parameters: { denominator: 10, numerator: 9 }, operation: "image.exposure" },
      { parameters: { radius: 1 }, operation: "image.blur" },
    ],
    schemaVersion: 1,
  };
  assert.deepEqual(normalizeImagePerturbationRecipe(first), normalizeImagePerturbationRecipe(reorderedKeys));
  assert.equal(imagePerturbationRecipeSha256(first), imagePerturbationRecipeSha256(reorderedKeys));
  assert.throws(
    () => normalizeImagePerturbationRecipe({ steps: [{ operation: "image.magic", parameters: {} }] }),
    /unsupported operation/,
  );
});

test("image perturbation recipes preserve step-by-step content-addressed lineage", async () => {
  const { root, source } = await workspaceWithImage();
  const recipe = {
    schemaVersion: 1,
    steps: [
      { operation: "image.resize", parameters: { width: 4, height: 4, filter: "nearest" } },
      { operation: "image.crop", parameters: { x: 1, y: 1, width: 2, height: 2 } },
      { operation: "image.contrast", parameters: { numerator: 11, denominator: 10 } },
      { operation: "image.blur", parameters: { radius: 1 } },
    ],
  };
  const first = await executeImagePerturbationRecipe(root, { source, recipe });
  const second = await executeImagePerturbationRecipe(root, { source, recipe });

  assert.equal(first.output.sha256, second.output.sha256);
  assert.equal(first.recipeSha256, second.recipeSha256);
  assert.equal(first.steps.length, 4);
  assert.equal(first.steps[0].input.sha256, source.sha256);
  assert.equal(first.steps[1].input.sha256, first.steps[0].output.sha256);
  assert.equal(first.steps[3].output.sha256, first.output.sha256);
  assert.ok(first.steps.every((step) => /^[0-9a-f]{64}$/.test(step.cacheKey)));
  const decoded = parseRgba8Image(await resolveAssetObject(root, first.output));
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
});

if (hasFfmpeg()) {
  test("FFmpeg codec operations round-trip canonical pixels through deterministic PNG", async () => {
    const { root, source, pixels } = await workspaceWithImage();
    const encoded = await executeImageEncodePngOperation(root, {
      parameters: { compressionLevel: 9 },
      inputs: { source },
    });
    assert.equal(encoded.outputs.output.mediaType, "image/png");

    const decoded = await executeImageDecodeOperation(root, {
      inputs: { source: encoded.outputs.output },
    });
    const canonical = parseRgba8Image(await resolveAssetObject(root, decoded.outputs.output));
    assert.equal(canonical.width, 2);
    assert.equal(canonical.height, 2);
    assert.deepEqual(canonical.pixels, pixels);
  });
}
