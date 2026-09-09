import { fileURLToPath } from "node:url";
import { resolveSpecPath } from "./schema.js";
import { probeProcessAdapter, runProcessAdapter } from "./process-adapter.js";

const STABLE_DIFFUSION_SCRIPT = fileURLToPath(
  new URL("../adapters/python/stable_diffusion.py", import.meta.url),
);
const PYTORCH_MAX_SEED = (1n << 64n) - 1n;

function assertExactKeys(value, expected, location) {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${location} contains unsupported field '${key}'`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new Error(`${location}.${key} is required`);
  }
}

function assertInteger(value, location, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
}

function assertFiniteNumber(value, location, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be a finite number in ${minimum}..${maximum}`);
  }
}

function assertPyTorchSeed(seed) {
  const parsed = BigInt(seed);
  if (parsed > PYTORCH_MAX_SEED) {
    throw new Error(`randomness.seed must be at most ${PYTORCH_MAX_SEED} for PyTorch`);
  }
}

function validateStableDiffusion(document) {
  const { spec } = document;
  assertExactKeys(spec.models, new Set(["pipelineBundle"]), "models");
  assertExactKeys(spec.inputs, new Set(), "inputs");
  if (spec.randomness.mode !== "seeded") {
    throw new Error("model.stable-diffusion.diffusers requires randomness.mode='seeded'");
  }
  assertPyTorchSeed(spec.randomness.seed);

  const parameters = spec.parameters;
  assertExactKeys(
    parameters,
    new Set([
      "prompt",
      "negativePrompt",
      "width",
      "height",
      "steps",
      "guidanceScale",
      "scheduler",
      "dtype",
      "device",
      "deterministicAlgorithms",
    ]),
    "parameters",
  );
  if (typeof parameters.prompt !== "string" || parameters.prompt.length === 0) {
    throw new Error("parameters.prompt must be a non-empty string");
  }
  if (typeof parameters.negativePrompt !== "string") {
    throw new Error("parameters.negativePrompt must be a string");
  }
  assertInteger(parameters.width, "parameters.width", 64, 2048);
  assertInteger(parameters.height, "parameters.height", 64, 2048);
  if (parameters.width % 8 !== 0 || parameters.height % 8 !== 0) {
    throw new Error("Stable Diffusion width and height must be divisible by 8");
  }
  assertInteger(parameters.steps, "parameters.steps", 1, 200);
  assertFiniteNumber(parameters.guidanceScale, "parameters.guidanceScale", 0, 30);
  if (!["default", "ddim", "euler", "euler-a"].includes(parameters.scheduler)) {
    throw new Error("parameters.scheduler must be default, ddim, euler, or euler-a");
  }
  if (!["float32", "float16", "bfloat16"].includes(parameters.dtype)) {
    throw new Error("parameters.dtype must be float32, float16, or bfloat16");
  }
  if (!["cpu", "cuda", "mps"].includes(parameters.device)) {
    throw new Error("parameters.device must be cpu, cuda, or mps");
  }
  if (typeof parameters.deterministicAlgorithms !== "boolean") {
    throw new Error("parameters.deterministicAlgorithms must be a boolean");
  }
}

export const STABLE_DIFFUSION_BACKEND = {
  id: "model.stable-diffusion.diffusers",
  version: "1",
  kind: "model",
  exactCapable: false,
  validate: validateStableDiffusion,
  async environmentComponents(document) {
    validateStableDiffusion(document);
    return probeProcessAdapter({
      executable: "python3",
      scriptPath: STABLE_DIFFUSION_SCRIPT,
      cwd: document.root,
      environment: {
        ASSET_TOOLING_REQUESTED_DEVICE: document.spec.parameters.device,
      },
    });
  },
  async generate(document) {
    validateStableDiffusion(document);
    const { spec, root } = document;
    return runProcessAdapter({
      executable: "python3",
      scriptPath: STABLE_DIFFUSION_SCRIPT,
      cwd: root,
      environment: spec.parameters.deterministicAlgorithms
        ? { CUBLAS_WORKSPACE_CONFIG: ":16:8" }
        : {},
      outputName: "stable-diffusion.png",
      request: {
        pipelineBundlePath: resolveSpecPath(root, spec.models.pipelineBundle.path),
        seed: spec.randomness.seed,
        parameters: spec.parameters,
      },
    });
  },
};
