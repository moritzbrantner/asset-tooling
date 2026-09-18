import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { getBackend } from "../src/backends.js";
import { validateSpec } from "../src/core.js";

function stableFast3DSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    assetId: "test.stable-fast-3d",
    generator: { id: "model.stable-fast-3d", version: "1" },
    randomness: { mode: "none" },
    inputs: {
      image: {
        path: "inputs/object.png",
        sha256: "1".repeat(64),
      },
    },
    models: {
      sf3dSourceBundle: {
        id: "stable-fast-3d-source",
        path: "models/stable-fast-3d-source.zip",
        sha256: "2".repeat(64),
      },
      sf3dModelBundle: {
        id: "stabilityai/stable-fast-3d",
        path: "models/stable-fast-3d-model.zip",
        sha256: "3".repeat(64),
      },
      dinoBundle: {
        id: "facebook/dinov2-large",
        path: "models/dinov2-large.zip",
        sha256: "4".repeat(64),
      },
    },
    parameters: {
      preprocessMode: "prepared-rgba",
      device: "cuda",
      textureResolution: 1024,
      remesh: "triangle",
      targetVertexCount: 12000,
      deterministicAlgorithms: true,
    },
    output: { path: ".asset-tooling/object.glb" },
    reproducibility: { expected: "approximate" },
    ...overrides,
  };
}

async function writeSpec(spec) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-stable-fast-3d-"));
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return specPath;
}

test("Stable Fast 3D is a model backend and never claims exact capability a priori", () => {
  const backend = getBackend({ id: "model.stable-fast-3d", version: "1" });
  assert.equal(backend.kind, "model");
  assert.equal(backend.exactCapable, false);
});

test("Stable Fast 3D accepts prepared image plus explicit source, weights, and DINO bundles", async () => {
  const specPath = await writeSpec(stableFast3DSpec());
  const result = await validateSpec(specPath);
  assert.equal(result.status, "valid");
});

test("Stable Fast 3D rejects hidden preprocessing and hidden model components", async () => {
  const autoBackground = stableFast3DSpec();
  autoBackground.parameters.preprocessMode = "remove-background";
  const autoBackgroundPath = await writeSpec(autoBackground);
  await assert.rejects(
    () => validateSpec(autoBackgroundPath),
    /preprocessMode must be 'prepared-rgba'/,
  );

  const hiddenModel = stableFast3DSpec();
  hiddenModel.models.rembg = {
    id: "ambient-rembg-model",
    path: "models/rembg.onnx",
    sha256: "5".repeat(64),
  };
  const hiddenModelPath = await writeSpec(hiddenModel);
  await assert.rejects(
    () => validateSpec(hiddenModelPath),
    /models contains unsupported field 'rembg'/,
  );
});

test("Stable Fast 3D normalizes game-asset mesh controls", async () => {
  const invalidTexture = stableFast3DSpec();
  invalidTexture.parameters.textureResolution = 1000;
  const invalidTexturePath = await writeSpec(invalidTexture);
  await assert.rejects(
    () => validateSpec(invalidTexturePath),
    /textureResolution must be a multiple of 256/,
  );

  const invalidVertices = stableFast3DSpec();
  invalidVertices.parameters.targetVertexCount = 500;
  const invalidVerticesPath = await writeSpec(invalidVertices);
  await assert.rejects(
    () => validateSpec(invalidVerticesPath),
    /targetVertexCount must be -1 or an integer in 1000\.\.20000/,
  );
});

test("Stable Fast 3D adapter pins local DINO and excludes rembg or hidden resizing", async () => {
  const source = await readFile(
    new URL("../adapters/python/stable_fast_3d.py", import.meta.url),
    "utf8",
  );
  assert.match(source, /config\.image_tokenizer\.pretrained_model_name_or_path = str\(dino_root\)/);
  assert.match(source, /HF_HUB_OFFLINE/);
  assert.match(source, /TRANSFORMERS_OFFLINE/);
  assert.match(source, /shutil\.copytree\(source_root \/ "sf3d", import_path \/ "sf3d"\)/);
  assert.match(source, /SF3D\.from_pretrained\(/);
  assert.match(source, /image\.mode != "RGBA"/);
  assert.match(source, /image\.size != \(512, 512\)/);
  assert.doesNotMatch(source, /import rembg/);
  assert.doesNotMatch(source, /remove_background/);
  assert.doesNotMatch(source, /resize_foreground/);
});

test("Stable Fast 3D fingerprints native baking/unwrapping modules and selected CUDA identity", async () => {
  const source = await readFile(
    new URL("../adapters/python/stable_fast_3d.py", import.meta.url),
    "utf8",
  );
  assert.match(source, /asset-tooling\.stable-fast-3d-adapter/);
  assert.match(source, /module_fingerprint\("texture_baker\._C"\)/);
  assert.match(source, /module_fingerprint\("uv_unwrapper\._C"\)/);
  assert.match(source, /torch\.cuda\.get_device_properties\(index\)/);
  assert.match(source, /--query-gpu=driver_version/);

  const backendSource = await readFile(
    new URL("../src/model-backends.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    backendSource,
    /STABLE_FAST_3D_BACKEND[\s\S]*ASSET_TOOLING_REQUESTED_DEVICE: document\.spec\.parameters\.device/,
  );
});
