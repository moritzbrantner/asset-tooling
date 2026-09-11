import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  assertCanonicalAudioBytes,
  audioFrameCount,
  CANONICAL_AUDIO_MEDIA_TYPE,
  createCanonicalAudioMetadata,
  encodeCanonicalPcm16Wav,
  normalizeCanonicalAudioAssetRef,
  validateAudioBuffer,
} from "./audio.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  createAssetRef,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const TOKEN_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[A-Za-z0-9]+(?:[._+-][A-Za-z0-9]+)*$/;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

const REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "audio.model.generate",
    version: "1",
    label: "Generate audio with model",
    description:
      "Generate canonical audio through an injected offline model adapter and exact content-addressed model bundle.",
    category: "model.audio",
    inputs: [
      { id: "model", label: "Model bundle", assetKinds: ["model"], mediaTypes: [] },
      {
        id: "conditioning",
        label: "Conditioning audio",
        assetKinds: ["audio"],
        mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE],
        required: false,
      },
    ],
    outputs: [
      { id: "output", label: "Audio", assetKinds: ["audio"], mediaTypes: [CANONICAL_AUDIO_MEDIA_TYPE] },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["modelId", "modelRevision", "prompt", "sampleRate", "channels", "frameCount"],
      properties: {
        modelId: { type: "string", minLength: 1 },
        modelRevision: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        sampleRate: { type: "integer", minimum: 8000, maximum: 192000 },
        channels: { type: "integer", enum: [1, 2] },
        frameCount: { type: "integer", minimum: 1, maximum: 10000000 },
        adapterParameters: { type: "object" },
      },
    },
  },
]);

export const AUDIO_MODEL_GENERATE_OPERATION = REGISTRY.get("audio.model.generate", "1");

function isObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertInteger(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function assertJsonValue(value, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new Error(`${location}.${key} is undefined`);
      assertJsonValue(entry, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} contains unsupported non-JSON value`);
}

function canonicalJsonClone(value, location) {
  assertJsonValue(value, location);
  return JSON.parse(JSON.stringify(value));
}

function normalizeParameters(value) {
  const parameters = assertObject(value, "audio.model.generate parameters");
  assertExactKeys(
    parameters,
    new Set(["modelId", "modelRevision", "prompt", "seed", "sampleRate", "channels", "frameCount", "adapterParameters"]),
    "audio.model.generate parameters",
  );
  const result = {
    modelId: assertNonEmptyString(parameters.modelId, "audio.model.generate modelId"),
    modelRevision: assertNonEmptyString(parameters.modelRevision, "audio.model.generate modelRevision"),
    prompt: assertNonEmptyString(parameters.prompt, "audio.model.generate prompt"),
    sampleRate: assertInteger(parameters.sampleRate, "audio.model.generate sampleRate", 8_000, 192_000),
    channels: assertInteger(parameters.channels, "audio.model.generate channels", 1, 2),
    frameCount: assertInteger(parameters.frameCount, "audio.model.generate frameCount", 1, 10_000_000),
    adapterParameters: canonicalJsonClone(parameters.adapterParameters ?? {}, "audio.model.generate adapterParameters"),
  };
  if (!isObject(result.adapterParameters)) throw new Error("audio.model.generate adapterParameters must be an object");
  if (parameters.seed !== undefined) {
    if (typeof parameters.seed !== "string" || !SEED_PATTERN.test(parameters.seed)) {
      throw new Error("audio.model.generate seed must be a non-negative decimal integer string");
    }
    result.seed = parameters.seed;
  }
  return result;
}

function normalizeAdapter(value) {
  const adapter = assertObject(value, "audio model adapter");
  assertExactKeys(adapter, new Set(["id", "version", "reproducibility", "generate"]), "audio model adapter");
  if (typeof adapter.id !== "string" || !TOKEN_PATTERN.test(adapter.id)) {
    throw new Error("audio model adapter id must be a lowercase dotted token");
  }
  if (typeof adapter.version !== "string" || !VERSION_PATTERN.test(adapter.version)) {
    throw new Error("audio model adapter version must be a portable version token");
  }
  if (!new Set(["exact", "approximate"]).has(adapter.reproducibility)) {
    throw new Error("audio model adapter reproducibility must be exact or approximate");
  }
  if (typeof adapter.generate !== "function") throw new Error("audio model adapter generate must be a function");
  return adapter;
}

function normalizeAdapterResult(value, adapterId) {
  const result = assertObject(value, `${adapterId} result`);
  assertExactKeys(result, new Set(["audio", "observations"]), `${adapterId} result`);
  const audio = validateAudioBuffer(result.audio);
  const observations = canonicalJsonClone(result.observations ?? {}, `${adapterId} observations`);
  if (!isObject(observations)) throw new Error(`${adapterId} observations must be an object`);
  return { audio, observations };
}

function assertRequestedShape(audio, parameters) {
  if (audio.sampleRate !== parameters.sampleRate) {
    throw new Error(`audio model adapter returned sampleRate ${audio.sampleRate}; expected ${parameters.sampleRate}`);
  }
  if (audio.channels !== parameters.channels) {
    throw new Error(`audio model adapter returned ${audio.channels} channels; expected ${parameters.channels}`);
  }
  const frameCount = audioFrameCount(audio);
  if (frameCount !== parameters.frameCount) {
    throw new Error(`audio model adapter returned ${frameCount} frames; expected ${parameters.frameCount}`);
  }
}

export async function createAudioModelGenerateOperationBuildIdentity(adapterValue, { parameters = {}, inputs = {} } = {}) {
  const adapter = normalizeAdapter(adapterValue);
  const normalizedParameters = normalizeParameters(parameters);
  return createAssetOperationBuildIdentity({
    operation: AUDIO_MODEL_GENERATE_OPERATION,
    implementation: {
      id: adapter.id,
      version: adapter.version,
      reproducibility: adapter.reproducibility,
      model: { id: normalizedParameters.modelId, revision: normalizedParameters.modelRevision },
      tool: await captureToolIdentity(),
    },
    parameters: normalizedParameters,
    inputs,
  });
}

export function createAudioModelGenerateOperationExecutor(adapterValue) {
  const adapter = normalizeAdapter(adapterValue);
  return async function executeAudioModelGenerateOperation(root, { parameters = {}, inputs = {} } = {}, context) {
    const build = await createAudioModelGenerateOperationBuildIdentity(adapter, { parameters, inputs });
    const model = createAssetRef(build.inputs.model);
    const modelBytes = await resolveAssetObject(root, model);
    const conditioning = build.inputs.conditioning ? normalizeCanonicalAudioAssetRef(build.inputs.conditioning) : undefined;
    const conditioningBytes = conditioning ? await resolveAssetObject(root, conditioning) : undefined;
    if (conditioning && conditioningBytes) assertCanonicalAudioBytes(conditioningBytes, conditioning.metadata);

    const generated = normalizeAdapterResult(
      await adapter.generate(
        {
          model: { id: build.parameters.modelId, revision: build.parameters.modelRevision, asset: model, bytes: modelBytes },
          conditioning: conditioning ? { asset: conditioning, bytes: conditioningBytes } : undefined,
          prompt: build.parameters.prompt,
          seed: build.parameters.seed,
          sampleRate: build.parameters.sampleRate,
          channels: build.parameters.channels,
          frameCount: build.parameters.frameCount,
          parameters: build.parameters.adapterParameters,
        },
        context,
      ),
      adapter.id,
    );
    assertRequestedShape(generated.audio, build.parameters);

    const encoded = encodeCanonicalPcm16Wav(generated.audio);
    const metadata = createCanonicalAudioMetadata({
      sampleRate: generated.audio.sampleRate,
      channels: generated.audio.channels,
      frameCount: encoded.frameCount,
      operation: { id: AUDIO_MODEL_GENERATE_OPERATION.id, version: AUDIO_MODEL_GENERATE_OPERATION.version },
      inputs: [
        { port: "model", sha256: model.sha256 },
        ...(conditioning ? [{ port: "conditioning", sha256: conditioning.sha256 }] : []),
      ],
    });
    const stored = await storeAssetObject(root, {
      bytes: encoded.bytes,
      kind: "audio",
      mediaType: CANONICAL_AUDIO_MEDIA_TYPE,
      metadata,
    });

    return normalizeAssetOperationResult(AUDIO_MODEL_GENERATE_OPERATION, {
      outputs: { output: stored.asset },
      observations: {
        adapter: { id: adapter.id, version: adapter.version, reproducibility: adapter.reproducibility },
        model: { id: build.parameters.modelId, revision: build.parameters.modelRevision, sha256: model.sha256 },
        ...(build.parameters.seed === undefined ? {} : { seed: build.parameters.seed }),
        sampleRate: generated.audio.sampleRate,
        channels: generated.audio.channels,
        frameCount: encoded.frameCount,
        backend: generated.observations,
      },
    });
  };
}
