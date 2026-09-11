import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  RGBA8_IMAGE_MEDIA_TYPE,
  encodeRgba8Image,
  parseRgba8Image,
} from "../src/image-rgba8.js";
import {
  IMAGE_OPERATIONS,
  IMAGE_RESIZE_OPERATION,
  createImageResizeOperationBuildIdentity,
  executeImageResizeOperation,
  resizeRgba8Nearest,
} from "../src/image-operations.js";

function pixel(red, green, blue, alpha = 255) {
  return [red, green, blue, alpha];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

async function workspaceWithImage(width, height, pixelBytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-operation-"));
  const bytes = encodeRgba8Image({ width, height, pixels: pixelBytes });
  const stored = await storeAssetObject(root, {
    bytes,
    kind: "image",
    mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width,
      height,
      pixelFormat: "rgba8",
      colorSpace: "srgb",
      alphaMode: "straight",
    },
  });
  return { root, source: stored.asset };
}

test("canonical RGBA8 codec round-trips exact pixel bytes", () => {
  const sourcePixels = pixels(pixel(1, 2, 3, 4), pixel(5, 6, 7, 8));
  const encoded = encodeRgba8Image({ width: 2, height: 1, pixels: sourcePixels });
  const parsed = parseRgba8Image(encoded);
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 1);
  assert.equal(parsed.colorSpace, "srgb");
  assert.equal(parsed.alphaMode, "straight");
  assert.deepEqual(parsed.pixels, sourcePixels);
});

test("canonical RGBA8 codec rejects contradictory byte length", () => {
  const invalid = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      width: 2,
      height: 1,
      colorSpace: "srgb",
      alphaMode: "straight",
      pixelsBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
    }),
    "utf8",
  );
  assert.throws(() => parseRgba8Image(invalid), /exactly 8 bytes/);
});

test("image geometry registry is deterministic and typed", () => {
  assert.deepEqual(
    IMAGE_OPERATIONS.map((operation) => operation.id),
    ["image.crop", "image.flip", "image.pad", "image.resize", "image.rotate"],
  );
  assert.equal(IMAGE_RESIZE_OPERATION.id, "image.resize");
  assert.equal(IMAGE_RESIZE_OPERATION.version, "1");
  assert.deepEqual(IMAGE_RESIZE_OPERATION.inputs[0].assetKinds, ["image"]);
  assert.deepEqual(IMAGE_RESIZE_OPERATION.inputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  assert.deepEqual(IMAGE_RESIZE_OPERATION.outputs[0].assetKinds, ["image"]);
  assert.deepEqual(IMAGE_RESIZE_OPERATION.outputs[0].mediaTypes, [RGBA8_IMAGE_MEDIA_TYPE]);
  assert.deepEqual(IMAGE_RESIZE_OPERATION.parameterSchema.properties.filter.enum, [
    "nearest",
    "bilinear",
  ]);
});

test("image.resize build identity binds source content and exact algorithm", async () => {
  const { root, source } = await workspaceWithImage(1, 1, pixels(pixel(10, 20, 30)));
  const identity = await createImageResizeOperationBuildIdentity(root, {
    parameters: { width: 2, height: 3, filter: "nearest" },
    inputs: { source },
  });
  assert.deepEqual(identity.operation, { id: "image.resize", version: "1" });
  assert.equal(identity.inputs.source.sha256, source.sha256);
  assert.equal(identity.implementation.id, "builtin.image.rgba8.resize");
  assert.equal(identity.implementation.version, "1");
  assert.equal(identity.implementation.algorithm, "nearest-center-integer-v1");
  assert.equal(identity.implementation.pixelFormat, "rgba8");
  assert.equal(JSON.stringify(identity).includes(root), false);
});

test("nearest-center resize expands pixels deterministically", () => {
  const source = {
    width: 2,
    height: 2,
    pixels: pixels(
      pixel(255, 0, 0),
      pixel(0, 255, 0),
      pixel(0, 0, 255),
      pixel(255, 255, 255),
    ),
  };
  const resized = resizeRgba8Nearest(source, 4, 4);
  assert.equal(resized.width, 4);
  assert.equal(resized.height, 4);
  const expected = pixels(
    pixel(255, 0, 0), pixel(255, 0, 0), pixel(0, 255, 0), pixel(0, 255, 0),
    pixel(255, 0, 0), pixel(255, 0, 0), pixel(0, 255, 0), pixel(0, 255, 0),
    pixel(0, 0, 255), pixel(0, 0, 255), pixel(255, 255, 255), pixel(255, 255, 255),
    pixel(0, 0, 255), pixel(0, 0, 255), pixel(255, 255, 255), pixel(255, 255, 255),
  );
  assert.deepEqual(resized.pixels, expected);
});

test("nearest-center downsampling uses exact integer center mapping", () => {
  const source = {
    width: 4,
    height: 1,
    pixels: pixels(pixel(1, 0, 0), pixel(2, 0, 0), pixel(3, 0, 0), pixel(4, 0, 0)),
  };
  const resized = resizeRgba8Nearest(source, 2, 1);
  assert.deepEqual(resized.pixels, pixels(pixel(2, 0, 0), pixel(4, 0, 0)));
});

test("image.resize stores identical bytes and observations across repeated execution", async () => {
  const { root, source } = await workspaceWithImage(
    2,
    2,
    pixels(pixel(10, 20, 30), pixel(40, 50, 60), pixel(70, 80, 90), pixel(100, 110, 120)),
  );
  const invocation = {
    parameters: { width: 3, height: 2, filter: "nearest" },
    inputs: { source },
  };
  const first = await executeImageResizeOperation(root, invocation);
  const second = await executeImageResizeOperation(root, invocation);

  assert.equal(second.outputs.output.sha256, first.outputs.output.sha256);
  assert.deepEqual(second.observations, first.observations);
  assert.equal(first.outputs.output.kind, "image");
  assert.equal(first.outputs.output.mediaType, RGBA8_IMAGE_MEDIA_TYPE);
  assert.deepEqual(first.outputs.output.metadata, {
    width: 3,
    height: 2,
    pixelFormat: "rgba8",
    colorSpace: "srgb",
    alphaMode: "straight",
    sourceSha256: source.sha256,
  });
  assert.deepEqual(first.observations, {
    sourceWidth: 2,
    sourceHeight: 2,
    resultWidth: 3,
    resultHeight: 2,
    algorithm: "nearest-center-integer-v1",
    parameters: { width: 3, height: 2, filter: "nearest" },
  });
  const output = parseRgba8Image(await resolveAssetObject(root, first.outputs.output));
  assert.equal(output.width, 3);
  assert.equal(output.height, 2);
});

test("image.resize rejects unsupported filters and missing source bytes", async () => {
  const { root, source } = await workspaceWithImage(1, 1, pixels(pixel(1, 2, 3)));
  await assert.rejects(
    () =>
      createImageResizeOperationBuildIdentity(root, {
        parameters: { width: 1, height: 1, filter: "bicubic" },
        inputs: { source },
      }),
    /nearest.*bilinear/,
  );

  const missing = { ...source, sha256: "f".repeat(64) };
  await assert.rejects(
    () =>
      createImageResizeOperationBuildIdentity(root, {
        parameters: { width: 1, height: 1, filter: "nearest" },
        inputs: { source: missing },
      }),
    /asset object.*missing/i,
  );
});
