import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { getBackend } from "../src/backends.js";
import { validateSpec } from "../src/core.js";

function triposrSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    assetId: "test.triposr",
    generator: { id: "model.triposr", version: "1" },
    randomness: { mode: "none" },
    inputs: {
      image: {
        path: "inputs/object.png",
        sha256: "1".repeat(64),
      },
    },
    models: {
      triposrBundle: {
        id: "triposr-local-bundle",
        path: "models/triposr.zip",
        sha256: "2".repeat(64),
      },
    },
    parameters: {
      preprocessMode: "prepared",
      device: "cuda",
      chunkSize: 8192,
      mcResolution: 256,
      outputFormat: "glb",
      deterministicAlgorithms: true,
    },
    output: { path: ".asset-tooling/object.glb" },
    reproducibility: { expected: "approximate" },
    ...overrides,
  };
}

async function writeSpec(spec) {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-triposr-"));
  const specPath = path.join(root, "asset.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return specPath;
}

test("TripoSR is a model backend and never claims exact capability a priori", () => {
  const backend = getBackend({ id: "model.triposr", version: "1" });
  assert.equal(backend.kind, "model");
  assert.equal(backend.exactCapable, false);
});

test("TripoSR accepts one image and one hash-pinned source/model/DINO bundle", async () => {
  const specPath = await writeSpec(triposrSpec());
  const result = await validateSpec(specPath);
  assert.equal(result.status, "valid");
});

test("TripoSR v1 rejects automatic background removal and hidden model components", async () => {
  const autoBackground = triposrSpec();
  autoBackground.parameters.preprocessMode = "remove-background";
  const autoBackgroundPath = await writeSpec(autoBackground);
  await assert.rejects(
    () => validateSpec(autoBackgroundPath),
    /preprocessMode must be 'prepared'/,
  );

  const hiddenModel = triposrSpec();
  hiddenModel.models.rembg = {
    id: "ambient-rembg-model",
    path: "models/rembg.onnx",
    sha256: "3".repeat(64),
  };
  const hiddenModelPath = await writeSpec(hiddenModel);
  await assert.rejects(
    () => validateSpec(hiddenModelPath),
    /models contains unsupported field 'rembg'/,
  );
});

test("TripoSR has no user randomness and normalizes mesh extraction controls", async () => {
  const seededPath = await writeSpec(
    triposrSpec({ randomness: { mode: "seeded", seed: "42" } }),
  );
  await assert.rejects(
    () => validateSpec(seededPath),
    /requires randomness\.mode='none'/,
  );

  const invalidResolution = triposrSpec();
  invalidResolution.parameters.mcResolution = 1024;
  const invalidResolutionPath = await writeSpec(invalidResolution);
  await assert.rejects(
    () => validateSpec(invalidResolutionPath),
    /mcResolution must be an integer in 32\.\.512/,
  );
});

test("TripoSR adapter pins bundled source and DINO and excludes rembg inference", async () => {
  const source = await readFile(
    new URL("../adapters/python/triposr.py", import.meta.url),
    "utf8",
  );
  assert.match(source, /sys\.path\.insert\(0, str\(bundle_root\)\)/);
  assert.match(source, /config\.image_tokenizer\.pretrained_model_name_or_path = str\(bundle_root \/ "dino"\)/);
  assert.match(source, /TSR\.from_pretrained\(/);
  assert.match(source, /HF_HUB_OFFLINE/);
  assert.match(source, /TRANSFORMERS_OFFLINE/);
  assert.match(source, /model\.extract_mesh\([\s\S]*scene_codes,[\s\S]*True,[\s\S]*resolution=parameters\["mcResolution"\]/);
  assert.doesNotMatch(source, /import rembg/);
  assert.doesNotMatch(source, /remove_background/);
});

test("TripoSR archive accepts unspecified Unix type bits but rejects explicit special files", async () => {
  const source = await readFile(
    new URL("../adapters/python/triposr.py", import.meta.url),
    "utf8",
  );
  assert.match(source, /file_type = stat\.S_IFMT\(unix_mode\)/);
  assert.match(source, /file_type == stat\.S_IFLNK/);
  assert.match(source, /file_type not in \(0, stat\.S_IFREG, stat\.S_IFDIR\)/);
});

test("TripoSR fingerprints adapter, native marching-cubes binary, and selected CUDA identity", async () => {
  const source = await readFile(
    new URL("../adapters/python/triposr.py", import.meta.url),
    "utf8",
  );
  assert.match(source, /asset-tooling\.triposr-adapter/);
  assert.match(source, /sha256_file\(Path\(__file__\)\.resolve\(\)\)/);
  assert.match(source, /module_fingerprint\("torchmcubes_module"\)/);
  assert.match(source, /torch\.cuda\.get_device_properties\(index\)/);
  assert.match(source, /--query-gpu=driver_version/);

  const backendSource = await readFile(
    new URL("../src/model-backends.js", import.meta.url),
    "utf8",
  );
  assert.match(backendSource, /TRIPOSR_BACKEND[\s\S]*ASSET_TOOLING_REQUESTED_DEVICE: document\.spec\.parameters\.device/);
  assert.match(backendSource, /PYTORCH_MAX_SEED/);
});
