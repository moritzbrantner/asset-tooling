import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { getBackend } from "../src/backends.js";
import { validateSpec } from "../src/core.js";

function stableDiffusionSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    assetId: "test.stable-diffusion",
    generator: { id: "model.stable-diffusion.diffusers", version: "1" },
    randomness: { mode: "seeded", seed: "42" },
    inputs: {},
    models: {
      pipelineBundle: {
        id: "stable-diffusion-local-pipeline",
        path: "models/stable-diffusion.zip",
        sha256: "0".repeat(64),
      },
    },
    parameters: {
      prompt: "a small stone cottage",
      negativePrompt: "",
      width: 512,
      height: 512,
      steps: 30,
      guidanceScale: 7.5,
      scheduler: "euler",
      dtype: "float16",
      device: "cuda",
      deterministicAlgorithms: true,
    },
    output: { path: ".asset-tooling/cottage.png" },
    reproducibility: { expected: "approximate" },
    ...overrides,
  };
}

async function writeSpec(spec) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-stable-diffusion-"));
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return specPath;
}

test("Stable Diffusion is a model backend and never claims exact capability a priori", () => {
  const backend = getBackend({ id: "model.stable-diffusion.diffusers", version: "1" });
  assert.equal(backend.kind, "model");
  assert.equal(backend.exactCapable, false);
});

test("Stable Diffusion accepts one hash-pinned pipeline bundle and normalized inference parameters", async () => {
  const specPath = await writeSpec(stableDiffusionSpec());
  const result = await validateSpec(specPath);
  assert.equal(result.status, "valid");
});

test("Stable Diffusion rejects untracked model components", async () => {
  const spec = stableDiffusionSpec();
  spec.models.untrackedVae = {
    id: "hidden-vae",
    path: "models/vae.safetensors",
    sha256: "1".repeat(64),
  };
  const specPath = await writeSpec(spec);
  await assert.rejects(() => validateSpec(specPath), /models contains unsupported field 'untrackedVae'/);
});

test("Stable Diffusion requires seeded randomness and an explicit inference grid", async () => {
  const unseededPath = await writeSpec(stableDiffusionSpec({ randomness: { mode: "none" } }));
  await assert.rejects(
    () => validateSpec(unseededPath),
    /requires randomness\.mode='seeded'/,
  );

  const badDimensions = stableDiffusionSpec();
  badDimensions.parameters.width = 513;
  const badDimensionsPath = await writeSpec(badDimensions);
  await assert.rejects(
    () => validateSpec(badDimensionsPath),
    /width and height must be divisible by 8/,
  );
});

test("Stable Diffusion rejects seeds outside PyTorch's uint64 domain during validation", async () => {
  const maximumPath = await writeSpec(stableDiffusionSpec({
    randomness: { mode: "seeded", seed: "18446744073709551615" },
  }));
  assert.equal((await validateSpec(maximumPath)).status, "valid");

  const tooLargePath = await writeSpec(stableDiffusionSpec({
    randomness: { mode: "seeded", seed: "18446744073709551616" },
  }));
  await assert.rejects(
    () => validateSpec(tooLargePath),
    /randomness\.seed must be at most 18446744073709551615 for PyTorch/,
  );
});

test("Stable Diffusion adapter is structurally offline and fingerprints adapter and CUDA identity", async () => {
  const source = await readFile(
    new URL("../adapters/python/stable_diffusion.py", import.meta.url),
    "utf8",
  );
  assert.match(source, /local_files_only=True/);
  assert.match(source, /HF_HUB_OFFLINE/);
  assert.match(source, /TRANSFORMERS_OFFLINE/);
  assert.match(source, /torch\.Generator\(device="cpu"\)\.manual_seed\(seed\)/);
  assert.match(source, /asset-tooling\.stable-diffusion-adapter/);
  assert.match(source, /sha256_file\(Path\(__file__\)\.resolve\(\)\)/);
  assert.match(source, /ASSET_TOOLING_REQUESTED_DEVICE/);
  assert.match(source, /torch\.cuda\.get_device_properties\(index\)/);
  assert.match(source, /torch\.cuda\.get_device_capability\(index\)/);
  assert.match(source, /--query-gpu=driver_version/);
  assert.doesNotMatch(source, /from_single_file/);
});

test("Stable Diffusion probe receives the declared device selection", async () => {
  const source = await readFile(
    new URL("../src/model-backends.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /ASSET_TOOLING_REQUESTED_DEVICE: document\.spec\.parameters\.device/);
});
