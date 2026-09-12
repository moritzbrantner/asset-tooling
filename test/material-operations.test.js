import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { parseLinearRgba8Image } from "../src/image-linear-rgba8.js";
import {
  MATERIAL_OPERATIONS,
  PBR_MATERIAL_MEDIA_TYPE,
  createPbrMaterialBundleOperationBuildIdentity,
  executePbrMaterialBundleOperation,
  executeTextureOrmPackOperation,
} from "../src/material-operations.js";

function pixels(...values) {
  return Buffer.from(values.flat());
}

function pixel(value, alpha = 255) {
  return [value, value, value, alpha];
}

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-material-"));
}

async function storeImage(root, width, height, bytes, metadata = {}) {
  return (
    await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width, height, pixels: bytes }),
      kind: "image",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      metadata: { width, height, pixelFormat: "rgba8", colorSpace: "srgb", alphaMode: "straight", ...metadata },
    })
  ).asset;
}

test("material operation registry exposes ORM packing and PBR bundle assembly", () => {
  assert.deepEqual(
    MATERIAL_OPERATIONS.map((operation) => operation.id),
    ["material.pbr.bundle", "texture.orm.pack"],
  );
});

test("ORM packing maps grayscale AO roughness metallic to linear RGB with opaque alpha", async () => {
  const root = await workspace();
  const ambientOcclusion = await storeImage(root, 2, 1, pixels(pixel(10), pixel(20)));
  const roughness = await storeImage(root, 2, 1, pixels(pixel(30), pixel(40)));
  const metallic = await storeImage(root, 2, 1, pixels(pixel(50), pixel(60)));

  const result = await executeTextureOrmPackOperation(root, {
    inputs: { ambientOcclusion, roughness, metallic },
    parameters: {},
  });
  const image = parseLinearRgba8Image(await resolveAssetObject(root, result.outputs.output));
  assert.deepEqual(image.pixels, pixels([10, 30, 50, 255], [20, 40, 60, 255]));
  assert.equal(result.outputs.output.metadata.field, "orm");
  assert.deepEqual(result.outputs.output.metadata.channelSemantics, {
    red: "ambient-occlusion",
    green: "roughness",
    blue: "metallic",
    alpha: "one",
  });
});

test("ORM packing rejects mismatched dimensions before output identity is accepted", async () => {
  const root = await workspace();
  const ambientOcclusion = await storeImage(root, 2, 1, pixels(pixel(10), pixel(20)));
  const roughness = await storeImage(root, 1, 1, pixels(pixel(30)));
  const metallic = await storeImage(root, 2, 1, pixels(pixel(50), pixel(60)));
  await assert.rejects(
    () => executeTextureOrmPackOperation(root, { inputs: { ambientOcclusion, roughness, metallic } }),
    /ORM source dimensions must exactly match/,
  );
});

test("PBR material bundle stores canonical typed references and is idempotent", async () => {
  const root = await workspace();
  const baseColor = await storeImage(root, 1, 1, pixels([200, 150, 100, 255]));
  const normal = await storeImage(root, 1, 1, pixels([128, 128, 255, 255]), {
    field: "normal",
    normalEncoding: "xyz-unorm8",
    tangentSpace: true,
  });
  const channel = await storeImage(root, 1, 1, pixels(pixel(128)));
  const orm = (
    await executeTextureOrmPackOperation(root, {
      inputs: { ambientOcclusion: channel, roughness: channel, metallic: channel },
    })
  ).outputs.output;

  const invocation = {
    inputs: { baseColor, normal, orm },
    parameters: { normalYAxis: "positive" },
  };
  const first = await executePbrMaterialBundleOperation(root, invocation);
  const second = await executePbrMaterialBundleOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.equal(first.outputs.output.kind, "material");
  assert.equal(first.outputs.output.mediaType, PBR_MATERIAL_MEDIA_TYPE);

  const document = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.model, "pbr-metallic-roughness");
  assert.equal(document.textures.baseColor.sha256, baseColor.sha256);
  assert.equal(document.textures.normal.sha256, normal.sha256);
  assert.equal(document.textures.orm.sha256, orm.sha256);
  assert.deepEqual(document.conventions.normal, {
    space: "tangent",
    encoding: "xyz-unorm8",
    yAxis: "positive",
  });
  assert.equal(document.conventions.orm.green, "roughness");
});

test("PBR bundle requires a texture and makes normal Y convention explicit only when needed", async () => {
  const root = await workspace();
  await assert.rejects(
    () => createPbrMaterialBundleOperationBuildIdentity(root, { inputs: {}, parameters: {} }),
    /requires at least one texture input/,
  );

  const baseColor = await storeImage(root, 1, 1, pixels([10, 20, 30, 255]));
  await assert.rejects(
    () =>
      createPbrMaterialBundleOperationBuildIdentity(root, {
        inputs: { baseColor },
        parameters: { normalYAxis: "positive" },
      }),
    /normalYAxis is only valid when normal is present/,
  );

  const normal = await storeImage(root, 1, 1, pixels([128, 128, 255, 255]));
  await assert.rejects(
    () => createPbrMaterialBundleOperationBuildIdentity(root, { inputs: { normal }, parameters: {} }),
    /normalYAxis must be positive or negative/,
  );
});
