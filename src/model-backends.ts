import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePcmWav } from "./audio.js";
import { resolveSpecPath } from "./schema.js";
import { probeProcessAdapter, runProcessAdapter } from "./process-adapter.js";

const STABLE_DIFFUSION_SCRIPT = fileURLToPath(
  new URL("../adapters/python/stable_diffusion.py", import.meta.url),
);
const STABLE_FAST_3D_SCRIPT = fileURLToPath(
  new URL("../adapters/python/stable_fast_3d.py", import.meta.url),
);
const TRELLIS2_SCRIPT = fileURLToPath(
  new URL("../adapters/python/trellis2.py", import.meta.url),
);
const TRIPOSR_SCRIPT = fileURLToPath(
  new URL("../adapters/python/triposr.py", import.meta.url),
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

function validateStableFast3D(document) {
  const { spec } = document;
  assertExactKeys(
    spec.models,
    new Set(["sf3dSourceBundle", "sf3dModelBundle", "dinoBundle"]),
    "models",
  );
  assertExactKeys(spec.inputs, new Set(["image"]), "inputs");
  if (spec.randomness.mode !== "none") {
    throw new Error("model.stable-fast-3d requires randomness.mode='none'");
  }

  const parameters = spec.parameters;
  assertExactKeys(
    parameters,
    new Set([
      "preprocessMode",
      "device",
      "textureResolution",
      "remesh",
      "targetVertexCount",
      "deterministicAlgorithms",
    ]),
    "parameters",
  );
  if (parameters.preprocessMode !== "prepared-rgba") {
    throw new Error(
      "parameters.preprocessMode must be 'prepared-rgba'; background removal and framing are separate operations",
    );
  }
  if (!["cpu", "cuda"].includes(parameters.device)) {
    throw new Error("parameters.device must be cpu or cuda");
  }
  assertInteger(parameters.textureResolution, "parameters.textureResolution", 512, 2048);
  if (parameters.textureResolution % 256 !== 0) {
    throw new Error("parameters.textureResolution must be a multiple of 256");
  }
  if (!["none", "triangle", "quad"].includes(parameters.remesh)) {
    throw new Error("parameters.remesh must be none, triangle, or quad");
  }
  if (
    parameters.targetVertexCount !== -1 &&
    (!Number.isInteger(parameters.targetVertexCount) ||
      parameters.targetVertexCount < 1000 ||
      parameters.targetVertexCount > 20000)
  ) {
    throw new Error("parameters.targetVertexCount must be -1 or an integer in 1000..20000");
  }
  if (typeof parameters.deterministicAlgorithms !== "boolean") {
    throw new Error("parameters.deterministicAlgorithms must be a boolean");
  }
}


function validateTrellis2(document) {
  const { spec } = document;
  assertExactKeys(
    spec.models,
    new Set([
      "trellis2SourceBundle",
      "trellis2ModelBundle",
      "trellisLegacyDecoderBundle",
      "dinoV3Bundle",
    ]),
    "models",
  );
  assertExactKeys(spec.inputs, new Set(["image"]), "inputs");
  if (spec.randomness.mode !== "seeded") {
    throw new Error("model.trellis2 requires randomness.mode='seeded'");
  }
  assertPyTorchSeed(spec.randomness.seed);

  const parameters = spec.parameters;
  assertExactKeys(
    parameters,
    new Set([
      "preprocessMode",
      "device",
      "pipelineType",
      "maxNumTokens",
      "decimationTarget",
      "textureSize",
      "remesh",
      "extensionWebp",
      "deterministicAlgorithms",
    ]),
    "parameters",
  );
  if (parameters.preprocessMode !== "prepared-rgba-premultiplied") {
    throw new Error(
      "parameters.preprocessMode must be 'prepared-rgba-premultiplied'; background removal and framing are separate operations",
    );
  }
  if (parameters.device !== "cuda") {
    throw new Error("parameters.device must be cuda for TRELLIS.2 v1");
  }
  if (!["512", "1024", "1024-cascade", "1536-cascade"].includes(parameters.pipelineType)) {
    throw new Error(
      "parameters.pipelineType must be 512, 1024, 1024-cascade, or 1536-cascade",
    );
  }
  assertInteger(parameters.maxNumTokens, "parameters.maxNumTokens", 4096, 131072);
  assertInteger(parameters.decimationTarget, "parameters.decimationTarget", 1000, 1000000);
  if (![512, 1024, 2048, 4096].includes(parameters.textureSize)) {
    throw new Error("parameters.textureSize must be 512, 1024, 2048, or 4096");
  }
  if (typeof parameters.remesh !== "boolean") {
    throw new Error("parameters.remesh must be a boolean");
  }
  if (typeof parameters.extensionWebp !== "boolean") {
    throw new Error("parameters.extensionWebp must be a boolean");
  }
  if (typeof parameters.deterministicAlgorithms !== "boolean") {
    throw new Error("parameters.deterministicAlgorithms must be a boolean");
  }
}

function validateTripoSR(document) {
  const { spec } = document;
  assertExactKeys(spec.models, new Set(["triposrBundle"]), "models");
  assertExactKeys(spec.inputs, new Set(["image"]), "inputs");
  if (spec.randomness.mode !== "none") {
    throw new Error("model.triposr requires randomness.mode='none'");
  }

  const parameters = spec.parameters;
  assertExactKeys(
    parameters,
    new Set([
      "preprocessMode",
      "device",
      "chunkSize",
      "mcResolution",
      "outputFormat",
      "deterministicAlgorithms",
    ]),
    "parameters",
  );
  if (parameters.preprocessMode !== "prepared") {
    throw new Error("parameters.preprocessMode must be 'prepared'; automatic background removal is outside TripoSR v1");
  }
  if (!["cpu", "cuda"].includes(parameters.device)) {
    throw new Error("parameters.device must be cpu or cuda");
  }
  assertInteger(parameters.chunkSize, "parameters.chunkSize", 0, 65536);
  assertInteger(parameters.mcResolution, "parameters.mcResolution", 32, 512);
  if (!["obj", "glb"].includes(parameters.outputFormat)) {
    throw new Error("parameters.outputFormat must be obj or glb");
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

export const STABLE_FAST_3D_BACKEND = {
  id: "model.stable-fast-3d",
  version: "1",
  kind: "model",
  exactCapable: false,
  validate: validateStableFast3D,
  async environmentComponents(document) {
    validateStableFast3D(document);
    return probeProcessAdapter({
      executable: "python3",
      scriptPath: STABLE_FAST_3D_SCRIPT,
      cwd: document.root,
      environment: {
        ASSET_TOOLING_REQUESTED_DEVICE: document.spec.parameters.device,
        ...(document.spec.parameters.device === "cpu" ? { SF3D_USE_CPU: "1" } : {}),
      },
    });
  },
  async generate(document) {
    validateStableFast3D(document);
    const { spec, root } = document;
    return runProcessAdapter({
      executable: "python3",
      scriptPath: STABLE_FAST_3D_SCRIPT,
      cwd: root,
      environment: {
        ...(spec.parameters.deterministicAlgorithms
          ? { CUBLAS_WORKSPACE_CONFIG: ":16:8" }
          : {}),
        ...(spec.parameters.device === "cpu" ? { SF3D_USE_CPU: "1" } : {}),
      },
      outputName: "stable-fast-3d.glb",
      request: {
        sourceBundlePath: resolveSpecPath(root, spec.models.sf3dSourceBundle.path),
        modelBundlePath: resolveSpecPath(root, spec.models.sf3dModelBundle.path),
        dinoBundlePath: resolveSpecPath(root, spec.models.dinoBundle.path),
        imagePath: resolveSpecPath(root, spec.inputs.image.path),
        parameters: spec.parameters,
      },
    });
  },
};


export const TRELLIS2_BACKEND = {
  id: "model.trellis2",
  version: "1",
  kind: "model",
  exactCapable: false,
  validate: validateTrellis2,
  async environmentComponents(document) {
    validateTrellis2(document);
    return probeProcessAdapter({
      executable: "python3",
      scriptPath: TRELLIS2_SCRIPT,
      cwd: document.root,
      environment: {
        ASSET_TOOLING_REQUESTED_DEVICE: "cuda",
      },
    });
  },
  async generate(document) {
    validateTrellis2(document);
    const { spec, root } = document;
    return runProcessAdapter({
      executable: "python3",
      scriptPath: TRELLIS2_SCRIPT,
      cwd: root,
      environment: spec.parameters.deterministicAlgorithms
        ? { CUBLAS_WORKSPACE_CONFIG: ":16:8" }
        : {},
      outputName: "trellis2.glb",
      request: {
        sourceBundlePath: resolveSpecPath(root, spec.models.trellis2SourceBundle.path),
        modelBundlePath: resolveSpecPath(root, spec.models.trellis2ModelBundle.path),
        legacyDecoderBundlePath: resolveSpecPath(
          root,
          spec.models.trellisLegacyDecoderBundle.path,
        ),
        imageEncoderBundlePath: resolveSpecPath(root, spec.models.dinoV3Bundle.path),
        imagePath: resolveSpecPath(root, spec.inputs.image.path),
        seed: spec.randomness.seed,
        parameters: spec.parameters,
      },
    });
  },
};

export const TRIPOSR_BACKEND = {
  id: "model.triposr",
  version: "1",
  kind: "model",
  exactCapable: false,
  validate: validateTripoSR,
  async environmentComponents(document) {
    validateTripoSR(document);
    return probeProcessAdapter({
      executable: "python3",
      scriptPath: TRIPOSR_SCRIPT,
      cwd: document.root,
      environment: {
        ASSET_TOOLING_REQUESTED_DEVICE: document.spec.parameters.device,
      },
    });
  },
  async generate(document) {
    validateTripoSR(document);
    const { spec, root } = document;
    return runProcessAdapter({
      executable: "python3",
      scriptPath: TRIPOSR_SCRIPT,
      cwd: root,
      environment: spec.parameters.deterministicAlgorithms
        ? { CUBLAS_WORKSPACE_CONFIG: ":16:8" }
        : {},
      outputName: `triposr.${spec.parameters.outputFormat}`,
      request: {
        triposrBundlePath: resolveSpecPath(root, spec.models.triposrBundle.path),
        imagePath: resolveSpecPath(root, spec.inputs.image.path),
        parameters: spec.parameters,
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Kokoro-82M text-to-speech adapter for audio.model.generate@2 (asset-tooling#30)
// ---------------------------------------------------------------------------

const KOKORO_SCRIPT = fileURLToPath(new URL("../adapters/python/kokoro_tts.py", import.meta.url));

export const KOKORO_MODEL_ID = "hexgrad/Kokoro-82M";
export const KOKORO_MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987";
export const KOKORO_SAMPLE_RATE = 24_000;

/** Kokoro v1.0 English voices at the pinned revision (American `a*`, British `b*`). */
export const KOKORO_ENGLISH_VOICES = Object.freeze([
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova",
  "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]);
const KOKORO_VOICE_SET = new Set(KOKORO_ENGLISH_VOICES);
const KOKORO_LEXICON_WORD = /^[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*$/u;
const KOKORO_MAX_LEXICON_ENTRIES = 10_000;
// misaki 0.9.4 (pinned in requirements-kokoro.txt), misaki/en.py US_VOCAB and GB_VOCAB: the phoneme
// symbols its English lexicons use. Both are subsets of the Kokoro-82M config.json vocab at the
// pinned revision. adapters/python/kokoro_tts.py re-checks entries against the set its voice selects.
export const KOKORO_US_PHONEMES = Object.freeze([..."AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʔʤʧˈˌθᵊᵻ"]);
export const KOKORO_GB_PHONEMES = Object.freeze([..."AIQWYabdfhijklmnpstuvwzðŋɑɒɔəɛɜɡɪɹʃʊʌʒʤʧˈˌːθᵊ"]);
const KOKORO_LEXICON_PHONEMES = new Set([...KOKORO_US_PHONEMES, ...KOKORO_GB_PHONEMES]);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unsupported field '${key}'`);
  }
}

function normalizeKokoroPython(value) {
  const parts = value === undefined ? ["python3"] : typeof value === "string" ? [value] : value;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("kokoro adapter python must be an executable or a non-empty [executable, ...launcherArguments] array");
  }
  parts.forEach((part, index) => {
    if (typeof part !== "string" || part.length === 0) {
      throw new Error(`kokoro adapter python[${index}] must be a non-empty string`);
    }
  });
  return Object.freeze([...parts]);
}

function normalizeKokoroLexicon(value) {
  if (!isPlainObject(value)) {
    throw new Error("kokoro adapterParameters.lexicon must be an object { version, entries }");
  }
  assertKnownKeys(value, new Set(["version", "entries"]), "kokoro adapterParameters.lexicon");
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("kokoro adapterParameters.lexicon.version must be a non-empty string");
  }
  if (!isPlainObject(value.entries)) {
    throw new Error("kokoro adapterParameters.lexicon.entries must be an object mapping words to phonemes");
  }
  const words = Object.keys(value.entries);
  if (words.length > KOKORO_MAX_LEXICON_ENTRIES) {
    throw new Error(`kokoro adapterParameters.lexicon.entries must not exceed ${KOKORO_MAX_LEXICON_ENTRIES} entries`);
  }
  const entries = {};
  for (const word of words.sort()) {
    if (!KOKORO_LEXICON_WORD.test(word)) {
      throw new Error(`kokoro adapterParameters.lexicon.entries key ${JSON.stringify(word)} must be a single word`);
    }
    const phonemes = value.entries[word];
    if (typeof phonemes !== "string" || phonemes.length === 0 || /\s/u.test(phonemes)) {
      throw new Error(`kokoro adapterParameters.lexicon.entries[${JSON.stringify(word)}] must be a non-empty phoneme string without whitespace`);
    }
    const invalid = [...new Set([...phonemes].filter((symbol) => !KOKORO_LEXICON_PHONEMES.has(symbol)))];
    if (invalid.length > 0) {
      throw new Error(
        `kokoro adapterParameters.lexicon.entries[${JSON.stringify(word)}] uses symbol(s) outside misaki's English phoneme set: ${JSON.stringify(invalid.join(""))}`,
      );
    }
    entries[word] = phonemes;
  }
  return { version: value.version, entries };
}

function normalizeKokoroAdapterParameters(value) {
  if (!isPlainObject(value)) throw new Error("kokoro adapterParameters must be an object");
  assertKnownKeys(value, new Set(["voice", "lexicon", "speed"]), "kokoro adapterParameters");
  if (typeof value.voice !== "string" || !KOKORO_VOICE_SET.has(value.voice)) {
    throw new Error(
      `kokoro adapterParameters.voice must be a Kokoro v1.0 English voice (${KOKORO_ENGLISH_VOICES.join(", ")})`,
    );
  }
  if (value.lexicon === undefined) {
    throw new Error("kokoro adapterParameters.lexicon is required: unknown words fail closed instead of falling back");
  }
  const lexicon = normalizeKokoroLexicon(value.lexicon);
  let speed = 1;
  if (value.speed !== undefined) {
    if (typeof value.speed !== "number" || !Number.isFinite(value.speed) || value.speed <= 0) {
      throw new Error("kokoro adapterParameters.speed must be a finite number greater than 0");
    }
    speed = value.speed;
  }
  return { voice: value.voice, lexicon, speed };
}

function validateKokoroRequest(request) {
  if (request.model?.id !== KOKORO_MODEL_ID) {
    throw new Error(`kokoro requires modelId ${KOKORO_MODEL_ID}; got ${JSON.stringify(request.model?.id)}`);
  }
  if (request.model.revision !== KOKORO_MODEL_REVISION) {
    throw new Error(`kokoro requires modelRevision ${KOKORO_MODEL_REVISION}; got ${JSON.stringify(request.model.revision)}`);
  }
  const asset = request.model.asset;
  if (asset?.mediaType !== "application/zip") {
    throw new Error(
      `kokoro model input must be the acquisition model.zip bundle (mediaType application/zip); got ${JSON.stringify(asset?.mediaType)}`,
    );
  }
  const bytes = request.model.bytes;
  if (!(bytes instanceof Uint8Array) || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error("kokoro model bundle bytes do not match the model AssetRef sha256");
  }
  if (request.conditioning !== undefined) {
    throw new Error("kokoro does not accept a conditioning input");
  }
  if (request.sampleRate !== KOKORO_SAMPLE_RATE) {
    throw new Error(`kokoro synthesizes at sampleRate ${KOKORO_SAMPLE_RATE}; got ${request.sampleRate}`);
  }
  if (request.channels !== 1) {
    throw new Error(`kokoro synthesizes mono audio (channels 1); got channels ${request.channels}`);
  }
  if (request.frameCount !== undefined) {
    throw new Error("kokoro derives the frame count from synthesis; frameCount must be omitted");
  }
  if (typeof request.seed !== "string") {
    throw new Error("kokoro requires a seed: the request seed seeds torch");
  }
  if (BigInt(request.seed) > PYTORCH_MAX_SEED) {
    throw new Error(`kokoro seed must be at most ${PYTORCH_MAX_SEED} for PyTorch`);
  }
  return normalizeKokoroAdapterParameters(request.parameters);
}

function decodeKokoroOutput(bytes) {
  let decoded;
  try {
    decoded = decodePcmWav(bytes);
  } catch (error) {
    throw new Error(`kokoro output is not a PCM WAV file: ${error.message}`);
  }
  if (decoded.sourceBitsPerSample !== 16) {
    throw new Error(`kokoro output must be 16-bit PCM WAV; got ${decoded.sourceBitsPerSample}-bit`);
  }
  if (decoded.sampleRate !== KOKORO_SAMPLE_RATE) {
    throw new Error(`kokoro output sampleRate ${decoded.sampleRate} does not match ${KOKORO_SAMPLE_RATE}`);
  }
  if (decoded.channels !== 1) {
    throw new Error(`kokoro output must be mono; got ${decoded.channels} channels`);
  }
  if (decoded.samples.length === 0) {
    throw new Error("kokoro output is empty: it contains no audio frames");
  }
  return { sampleRate: decoded.sampleRate, channels: decoded.channels, samples: decoded.samples };
}

/**
 * Local Kokoro-82M speech adapter for `audio.model.generate@2`. `python` is the interpreter of
 * the hash-locked venv (requirements-kokoro.txt), either one executable or
 * `[executable, ...launcherArguments]`; `threads` is the torch thread count and is part of the
 * build identity. See docs/kokoro.md.
 */
export function createKokoroAudioModelAdapter(options = {}) {
  if (!isPlainObject(options)) throw new Error("kokoro adapter options must be an object");
  assertKnownKeys(options, new Set(["python", "threads"]), "kokoro adapter options");
  const [executable, ...launcherArguments] = normalizeKokoroPython(options.python);
  const threads = options.threads ?? 1;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 256) {
    throw new Error("kokoro adapter threads must be an integer in 1..256");
  }
  const environment = {
    OMP_NUM_THREADS: String(threads),
    MKL_NUM_THREADS: String(threads),
    PYTHONDONTWRITEBYTECODE: "1",
  };

  return {
    id: "kokoro",
    version: "1",
    reproducibility: "approximate",
    async environmentComponents() {
      const components = await probeProcessAdapter({
        executable,
        launcherArguments,
        scriptPath: KOKORO_SCRIPT,
        cwd: os.tmpdir(),
        environment,
      });
      return [...components, { id: "asset-tooling.kokoro-adapter-options", threads }];
    },
    async generate(request) {
      const parameters = validateKokoroRequest(request);
      const directory = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-kokoro-"));
      try {
        const modelBundlePath = path.join(directory, "model.zip");
        await writeFile(modelBundlePath, request.model.bytes);
        const { bytes, observations } = await runProcessAdapter({
          executable,
          launcherArguments,
          scriptPath: KOKORO_SCRIPT,
          cwd: directory,
          environment,
          outputName: "kokoro.wav",
          request: {
            modelBundlePath,
            modelId: KOKORO_MODEL_ID,
            modelRevision: KOKORO_MODEL_REVISION,
            prompt: request.prompt,
            seed: request.seed,
            threads,
            sampleRate: KOKORO_SAMPLE_RATE,
            voice: parameters.voice,
            lexicon: parameters.lexicon,
            speed: parameters.speed,
          },
        });
        return { audio: decodeKokoroOutput(bytes), observations };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
