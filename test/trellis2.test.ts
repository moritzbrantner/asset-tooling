import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { getBackend } from "../src/backends.js";
import { validateSpec } from "../src/core.js";

function trellis2Spec(overrides = {}) {
  return {
    schemaVersion: 1,
    assetId: "test.trellis2",
    generator: { id: "model.trellis2", version: "1" },
    randomness: { mode: "seeded", seed: "42" },
    inputs: {
      image: {
        path: "inputs/object.png",
        sha256: "1".repeat(64),
      },
    },
    models: {
      trellis2SourceBundle: {
        id: "microsoft/TRELLIS.2-source",
        path: "models/trellis2-source.zip",
        sha256: "2".repeat(64),
      },
      trellis2ModelBundle: {
        id: "microsoft/TRELLIS.2-4B",
        path: "models/trellis2-model.zip",
        sha256: "3".repeat(64),
      },
      trellisLegacyDecoderBundle: {
        id: "microsoft/TRELLIS-image-large:ss-decoder",
        path: "models/trellis-legacy-decoder.zip",
        sha256: "4".repeat(64),
      },
      dinoV3Bundle: {
        id: "facebook/dinov3-vitl16-pretrain-lvd1689m",
        path: "models/dinov3-vitl16.zip",
        sha256: "5".repeat(64),
      },
    },
    parameters: {
      preprocessMode: "prepared-rgba-premultiplied",
      device: "cuda",
      pipelineType: "1024-cascade",
      maxNumTokens: 49152,
      decimationTarget: 100000,
      textureSize: 2048,
      remesh: true,
      extensionWebp: false,
      deterministicAlgorithms: true,
    },
    output: { path: ".asset-tooling/object.glb" },
    reproducibility: { expected: "approximate" },
    ...overrides,
  };
}

async function writeSpec(spec) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-trellis2-"));
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return specPath;
}

test("TRELLIS.2 is a model backend and never claims exact capability a priori", () => {
  const backend = getBackend({ id: "model.trellis2", version: "1" });
  assert.equal(backend.kind, "model");
  assert.equal(backend.exactCapable, false);
});

test("TRELLIS.2 requires prepared image plus every remotely referenced model component", async () => {
  const specPath = await writeSpec(trellis2Spec());
  const result = await validateSpec(specPath);
  assert.equal(result.status, "valid");

  const missingEncoder = trellis2Spec();
  delete missingEncoder.models.dinoV3Bundle;
  const missingEncoderPath = await writeSpec(missingEncoder);
  await assert.rejects(
    () => validateSpec(missingEncoderPath),
    /models\.dinoV3Bundle is required/,
  );
});

test("TRELLIS.2 rejects hidden preprocessing, CPU fallback, and invalid production controls", async () => {
  const autoBackground = trellis2Spec();
  autoBackground.parameters.preprocessMode = "remove-background";
  const autoBackgroundPath = await writeSpec(autoBackground);
  await assert.rejects(
    () => validateSpec(autoBackgroundPath),
    /prepared-rgba-premultiplied/,
  );

  const cpu = trellis2Spec();
  cpu.parameters.device = "cpu";
  const cpuPath = await writeSpec(cpu);
  await assert.rejects(
    () => validateSpec(cpuPath),
    /parameters\.device must be cuda/,
  );

  const badTexture = trellis2Spec();
  badTexture.parameters.textureSize = 3072;
  const badTexturePath = await writeSpec(badTexture);
  await assert.rejects(
    () => validateSpec(badTexturePath),
    /textureSize must be 512, 1024, 2048, or 4096/,
  );
});

test("TRELLIS.2 adapter is offline, bypasses BiRefNet, and binds external pipeline refs locally", async () => {
  const source = await readFile(new URL("../adapters/python/trellis2.py", import.meta.url), "utf8");
  assert.match(source, /HF_HUB_OFFLINE/);
  assert.match(source, /TRANSFORMERS_OFFLINE/);
  assert.match(source, /LEGACY_DECODER_REF/);
  assert.match(source, /DinoV3FeatureExtractor\(\s*model_name=str\(dino_root\)/);
  assert.match(source, /pipeline\.rembg_model = None/);
  assert.match(source, /preprocess_image=False/);
  assert.match(source, /o_voxel\.postprocess\.to_glb/);
  assert.doesNotMatch(source, /BiRefNet\(/);
  assert.doesNotMatch(source, /hf_hub_download/);
});

test("TRELLIS.2 fingerprints compiled CUDA runtime components and GPU identity", async () => {
  const source = await readFile(new URL("../adapters/python/trellis2.py", import.meta.url), "utf8");
  assert.match(source, /module_fingerprint\("flash_attn"\)/);
  assert.match(source, /module_fingerprint\("flex_gemm"\)/);
  assert.match(source, /module_fingerprint\("cumesh"\)/);
  assert.match(source, /module_fingerprint\("nvdiffrast\.torch"\)/);
  assert.match(source, /module_fingerprint\("o_voxel\._C"\)/);
  assert.match(source, /torch\.cuda\.get_device_properties\(index\)/);
  assert.match(source, /--query-gpu=driver_version/);

  const backendSource = await readFile(new URL("../src/model-backends.ts", import.meta.url), "utf8");
  assert.match(
    backendSource,
    /TRELLIS2_BACKEND[\s\S]*ASSET_TOOLING_REQUESTED_DEVICE: "cuda"/,
  );
});
