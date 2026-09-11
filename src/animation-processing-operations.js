import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assetObjectPortablePath, resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { probeProcessAdapter, runProcessAdapter } from "./process-adapter.js";
import { captureToolIdentity } from "./tool.js";

const execFileAsync = promisify(execFile);

export const THREE_D_ANIMATION_MEDIA_TYPE =
  "application/vnd.moritzbrantner.three-d.animation+json";

const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const PROCESSOR_CODEC = "three-d-animation-json-v1";
const RESAMPLE_OPERATION_ID = "animation.resample";
const REDUCE_OPERATION_ID = "animation.reduce";
const OPERATION_VERSION = "1";
const RESAMPLE_PROCESSOR_ID = "three-d-animation-resample";
const REDUCE_PROCESSOR_ID = "three-d-animation-reduce";
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UNIT_QUATERNION_TOLERANCE = 1.0e-4;

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: RESAMPLE_OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Resample animation",
    description:
      "Bake local translation, rotation, and scale channels onto an explicit time grid through an authoritative animation processor.",
    category: "animation.processing",
    inputs: [
      {
        id: "source",
        label: "Source animation",
        assetKinds: ["animation"],
        mediaTypes: [THREE_D_ANIMATION_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Resampled animation",
        assetKinds: ["animation"],
        mediaTypes: [THREE_D_ANIMATION_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "sourceStartSeconds",
        "sourceEndSeconds",
        "targetTimesSeconds",
        "interpolation",
        "transformSpace",
      ],
      properties: {
        sourceStartSeconds: { type: "number", minimum: 0 },
        sourceEndSeconds: { type: "number", minimum: 0 },
        targetTimesSeconds: {
          type: "array",
          minItems: 1,
          items: { type: "number", minimum: 0 },
        },
        interpolation: {
          type: "object",
          additionalProperties: false,
          required: ["translation", "rotation", "scale"],
          properties: {
            translation: { type: "string", enum: ["linear"] },
            rotation: { type: "string", enum: ["slerp"] },
            scale: { type: "string", enum: ["linear"] },
          },
        },
        transformSpace: { type: "string", enum: ["local"] },
      },
    },
  },
  {
    schemaVersion: 1,
    id: REDUCE_OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Reduce animation keys",
    description:
      "Remove redundant local-transform animation keys within explicit translation, rotation, and scale error tolerances.",
    category: "animation.processing",
    inputs: [
      {
        id: "source",
        label: "Source animation",
        assetKinds: ["animation"],
        mediaTypes: [THREE_D_ANIMATION_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Reduced animation",
        assetKinds: ["animation"],
        mediaTypes: [THREE_D_ANIMATION_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "translationError",
        "rotationErrorRadians",
        "scaleError",
        "transformSpace",
        "preserveEndpoints",
      ],
      properties: {
        translationError: { type: "number", minimum: 0 },
        rotationErrorRadians: { type: "number", minimum: 0 },
        scaleError: { type: "number", minimum: 0 },
        transformSpace: { type: "string", enum: ["local"] },
        preserveEndpoints: { type: "boolean" },
      },
    },
  },
]);

export const ANIMATION_RESAMPLE_OPERATION = OPERATION_REGISTRY.get(
  RESAMPLE_OPERATION_ID,
  OPERATION_VERSION,
);
export const ANIMATION_REDUCE_OPERATION = OPERATION_REGISTRY.get(
  REDUCE_OPERATION_ID,
  OPERATION_VERSION,
);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value, keys, location) {
  const object = assertPlainObject(value, location);
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return object;
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${location} must be a finite number`);
  }
  return value;
}

function finiteF32(value, location) {
  const normalized = Math.fround(finiteNumber(value, location));
  if (!Number.isFinite(normalized)) {
    throw new Error(`${location} must be representable as a finite f32`);
  }
  return normalized;
}

function finiteNonNegative(value, location) {
  const normalized = finiteNumber(value, location);
  if (normalized < 0) {
    throw new Error(`${location} must be a finite non-negative number`);
  }
  return normalized;
}

function finiteNonNegativeF32(value, location) {
  const normalized = finiteNonNegative(value, location);
  const rounded = Math.fround(normalized);
  if (!Number.isFinite(rounded)) {
    throw new Error(`${location} must be representable as a finite non-negative f32`);
  }
  return rounded;
}

function positiveSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value;
}

function normalizeResampleParameters(value) {
  const keys = new Set([
    "sourceStartSeconds",
    "sourceEndSeconds",
    "targetTimesSeconds",
    "interpolation",
    "transformSpace",
  ]);
  const parameters = assertExactKeys(value, keys, `${RESAMPLE_OPERATION_ID} parameters`);
  const sourceStartSeconds = finiteNonNegativeF32(
    parameters.sourceStartSeconds,
    "parameters.sourceStartSeconds",
  );
  const sourceEndSeconds = finiteNonNegativeF32(
    parameters.sourceEndSeconds,
    "parameters.sourceEndSeconds",
  );
  if (sourceEndSeconds < sourceStartSeconds) {
    throw new Error("parameters.sourceEndSeconds must not precede sourceStartSeconds");
  }
  if (!Array.isArray(parameters.targetTimesSeconds) || parameters.targetTimesSeconds.length === 0) {
    throw new Error("parameters.targetTimesSeconds must be a non-empty array");
  }
  let previous = -Infinity;
  const targetTimesSeconds = parameters.targetTimesSeconds.map((time, index) => {
    const normalized = finiteNonNegativeF32(
      time,
      `parameters.targetTimesSeconds[${index}]`,
    );
    if (normalized < sourceStartSeconds || normalized > sourceEndSeconds) {
      throw new Error("parameters.targetTimesSeconds must stay inside the source time domain");
    }
    if (normalized <= previous) {
      throw new Error(
        "parameters.targetTimesSeconds must be strictly increasing after f32 normalization",
      );
    }
    previous = normalized;
    return normalized;
  });
  const interpolation = assertExactKeys(
    parameters.interpolation,
    new Set(["translation", "rotation", "scale"]),
    "parameters.interpolation",
  );
  if (
    interpolation.translation !== "linear" ||
    interpolation.rotation !== "slerp" ||
    interpolation.scale !== "linear"
  ) {
    throw new Error(
      "animation.resample requires linear translation/scale and slerp rotation interpolation",
    );
  }
  if (parameters.transformSpace !== "local") {
    throw new Error("parameters.transformSpace must be 'local'");
  }
  return {
    sourceStartSeconds,
    sourceEndSeconds,
    targetTimesSeconds,
    interpolation: { translation: "linear", rotation: "slerp", scale: "linear" },
    transformSpace: "local",
  };
}

function normalizeReduceParameters(value) {
  const keys = new Set([
    "translationError",
    "rotationErrorRadians",
    "scaleError",
    "transformSpace",
    "preserveEndpoints",
  ]);
  const parameters = assertExactKeys(value, keys, `${REDUCE_OPERATION_ID} parameters`);
  if (parameters.transformSpace !== "local") {
    throw new Error("parameters.transformSpace must be 'local'");
  }
  if (typeof parameters.preserveEndpoints !== "boolean") {
    throw new Error("parameters.preserveEndpoints must be a boolean");
  }
  return {
    translationError: finiteNonNegativeF32(
      parameters.translationError,
      "parameters.translationError",
    ),
    rotationErrorRadians: finiteNonNegativeF32(
      parameters.rotationErrorRadians,
      "parameters.rotationErrorRadians",
    ),
    scaleError: finiteNonNegativeF32(parameters.scaleError, "parameters.scaleError"),
    transformSpace: "local",
    preserveEndpoints: parameters.preserveEndpoints,
  };
}

function normalizeProcessor(value, operationId) {
  const processor = assertPlainObject(value, `${operationId} processor`);
  const allowed = new Set([
    "repository",
    "revision",
    "executable",
    "scriptPath",
    "prefixArguments",
    "checkoutRoot",
    "sourceFiles",
  ]);
  for (const key of Object.keys(processor)) {
    if (!allowed.has(key)) throw new Error(`${operationId} processor contains unknown field '${key}'`);
  }
  const repository = assertNonEmptyString(processor.repository, "processor.repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("processor.repository must use owner/repository form");
  }
  if (typeof processor.revision !== "string" || !GIT_SHA_PATTERN.test(processor.revision)) {
    throw new Error("processor.revision must be an exact lowercase 40-character Git commit SHA");
  }
  const executable = assertNonEmptyString(processor.executable, "processor.executable");
  const scriptPath = assertNonEmptyString(processor.scriptPath, "processor.scriptPath");
  const prefixArguments = processor.prefixArguments ?? [];
  if (!Array.isArray(prefixArguments)) throw new Error("processor.prefixArguments must be an array");
  prefixArguments.forEach((argument, index) =>
    assertNonEmptyString(argument, `processor.prefixArguments[${index}]`),
  );

  const hasCheckoutRoot = processor.checkoutRoot !== undefined;
  const hasSourceFiles = processor.sourceFiles !== undefined;
  if (hasCheckoutRoot === hasSourceFiles) {
    throw new Error("processor must declare exactly one of checkoutRoot or sourceFiles");
  }

  let checkoutRoot;
  let sourceFiles;
  if (hasCheckoutRoot) {
    checkoutRoot = assertNonEmptyString(processor.checkoutRoot, "processor.checkoutRoot");
    if (!path.isAbsolute(checkoutRoot)) {
      throw new Error("processor.checkoutRoot must be an absolute path");
    }
  } else {
    if (!Array.isArray(processor.sourceFiles) || processor.sourceFiles.length === 0) {
      throw new Error("processor.sourceFiles must be a non-empty array");
    }
    sourceFiles = processor.sourceFiles.map((file, index) => {
      const normalized = assertNonEmptyString(file, `processor.sourceFiles[${index}]`);
      if (!path.isAbsolute(normalized)) {
        throw new Error(`processor.sourceFiles[${index}] must be an absolute path`);
      }
      return path.resolve(normalized);
    });
    if (new Set(sourceFiles).size !== sourceFiles.length) {
      throw new Error("processor.sourceFiles must not contain duplicates");
    }
  }

  return {
    repository,
    revision: processor.revision,
    executable,
    scriptPath,
    prefixArguments: [...prefixArguments],
    ...(checkoutRoot === undefined ? {} : { checkoutRoot: path.resolve(checkoutRoot) }),
    ...(sourceFiles === undefined ? {} : { sourceFiles }),
  };
}

function processorStorageEnvironment(processor) {
  if (!/^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))) return {};
  const environment = {};
  for (const name of ["CARGO_HOME", "RUSTUP_HOME", "HOME", "USERPROFILE"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function gitOutput(checkoutRoot, arguments_, location) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", checkoutRoot, ...arguments_], {
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`${location} failed: ${error.message}`);
  }
}

async function verifyProcessorSource(processor, root, operationId) {
  if (processor.checkoutRoot !== undefined) {
    const actualRevision = await gitOutput(
      processor.checkoutRoot,
      ["rev-parse", "HEAD"],
      `${operationId} processor checkout revision verification`,
    );
    if (actualRevision !== processor.revision) {
      throw new Error(
        `${operationId} processor checkout HEAD '${actualRevision}' does not match declared revision '${processor.revision}'`,
      );
    }
    const status = await gitOutput(
      processor.checkoutRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      `${operationId} processor checkout cleanliness verification`,
    );
    if (status.length > 0) {
      throw new Error(`${operationId} processor checkout must be clean at the declared revision`);
    }

    if (/^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))) {
      const manifestIndex = processor.prefixArguments.indexOf("--manifest-path");
      const manifestValue = processor.prefixArguments[manifestIndex + 1];
      if (manifestIndex < 0 || typeof manifestValue !== "string") {
        throw new Error(`${operationId} cargo processor must declare --manifest-path`);
      }
      const manifestPath = path.resolve(manifestValue);
      if (!pathIsInside(processor.checkoutRoot, manifestPath)) {
        throw new Error(`${operationId} processor manifest must be inside checkoutRoot`);
      }
      const manifestRelativePath = path.relative(processor.checkoutRoot, manifestPath);
      await gitOutput(
        processor.checkoutRoot,
        ["ls-files", "--error-unmatch", "--", manifestRelativePath],
        `${operationId} processor manifest tracking verification`,
      );
    } else {
      const scriptPath = path.isAbsolute(processor.scriptPath)
        ? path.resolve(processor.scriptPath)
        : path.resolve(root, processor.scriptPath);
      if (!pathIsInside(processor.checkoutRoot, scriptPath)) {
        throw new Error(`${operationId} processor script must be inside checkoutRoot`);
      }
    }

    return {
      repository: processor.repository,
      revision: processor.revision,
      verification: "git-clean-exact-head",
    };
  }

  const scriptPath = path.isAbsolute(processor.scriptPath)
    ? path.resolve(processor.scriptPath)
    : path.resolve(root, processor.scriptPath);
  if (!processor.sourceFiles.includes(scriptPath)) {
    throw new Error(`${operationId} processor.sourceFiles must include the executed scriptPath`);
  }
  const fileHashes = [];
  for (const sourceFile of processor.sourceFiles) {
    let bytes;
    try {
      bytes = await readFile(sourceFile);
    } catch (error) {
      throw new Error(`${operationId} processor source file '${sourceFile}' could not be read: ${error.message}`);
    }
    fileHashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  fileHashes.sort();
  const sourceSha256 = createHash("sha256")
    .update(JSON.stringify(fileHashes))
    .digest("hex");
  return {
    repository: processor.repository,
    revision: processor.revision,
    sourceSha256,
  };
}

function normalizeProbe(components, { operationId, processorId }) {
  const matching = components.filter((component) => component.id === processorId);
  if (matching.length !== 1) {
    throw new Error(`processor probe must contain exactly one '${processorId}' component`);
  }
  const component = assertPlainObject(matching[0], `${operationId} processor probe component`);
  assertNonEmptyString(component.version, "processor probe version");
  assertNonEmptyString(component.algorithm, "processor probe algorithm");
  if (component.protocol !== PROCESSOR_PROTOCOL) {
    throw new Error(`processor probe protocol must be '${PROCESSOR_PROTOCOL}'`);
  }
  if (component.codec !== PROCESSOR_CODEC) {
    throw new Error(`processor probe codec must be '${PROCESSOR_CODEC}'`);
  }
  assertPlainObject(component.dependencies, "processor probe dependencies");
  assertNonEmptyString(component.cargoLock, "processor probe cargoLock");
  return component;
}

async function processorIdentity(root, processorValue, { operationId, processorId }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(`${operationId} root must be an absolute path`);
  }
  const processor = normalizeProcessor(processorValue, operationId);
  const source = await verifyProcessorSource(processor, root, operationId);
  const environment = processorStorageEnvironment(processor);
  const components = await probeProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
    environment,
  });
  const probe = normalizeProbe(components, { operationId, processorId });
  return {
    processor,
    environment,
    implementation: {
      id: probe.id,
      version: probe.version,
      source,
      probe,
      assetTooling: await captureToolIdentity(),
    },
  };
}

function parseAnimationDocument(bytes, location) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${location} is not valid JSON: ${error.message}`);
  }
  const document = assertExactKeys(value, new Set(["schemaVersion", "channels"]), location);
  if (document.schemaVersion !== 1) throw new Error(`${location} schemaVersion must be 1`);
  if (!Array.isArray(document.channels) || document.channels.length === 0) {
    throw new Error(`${location} channels must be a non-empty array`);
  }
  const identities = new Set();
  let keyframeCount = 0;
  const channels = document.channels.map((value_, channelIndex) => {
    const channel = assertExactKeys(
      value_,
      new Set(["kind", "node", "keyframes"]),
      `${location}.channels[${channelIndex}]`,
    );
    if (!["translation", "rotation", "scale"].includes(channel.kind)) {
      throw new Error(`${location}.channels[${channelIndex}].kind is unsupported`);
    }
    if (!Number.isSafeInteger(channel.node) || channel.node < 0) {
      throw new Error(`${location}.channels[${channelIndex}].node must be a non-negative safe integer`);
    }
    const identity = `${channel.node}:${channel.kind}`;
    if (identities.has(identity)) {
      throw new Error(`${location} contains duplicate ${channel.kind} channel for node ${channel.node}`);
    }
    identities.add(identity);
    if (!Array.isArray(channel.keyframes) || channel.keyframes.length === 0) {
      throw new Error(`${location}.channels[${channelIndex}].keyframes must be non-empty`);
    }
    let previousTime = -Infinity;
    const width = channel.kind === "rotation" ? 4 : 3;
    const keyframes = channel.keyframes.map((value__, keyIndex) => {
      const keyframe = assertExactKeys(
        value__,
        new Set(["time", "value"]),
        `${location}.channels[${channelIndex}].keyframes[${keyIndex}]`,
      );
      const time = finiteNonNegativeF32(
        keyframe.time,
        `${location}.channels[${channelIndex}].keyframes[${keyIndex}].time`,
      );
      if (time <= previousTime) {
        throw new Error(
          `${location}.channels[${channelIndex}] keyframe times must be strictly increasing after f32 normalization`,
        );
      }
      previousTime = time;
      if (!Array.isArray(keyframe.value) || keyframe.value.length !== width) {
        throw new Error(
          `${location}.channels[${channelIndex}].keyframes[${keyIndex}].value must be a finite ${width === 4 ? "quaternion" : "vec3"}`,
        );
      }
      const normalizedValue = keyframe.value.map((component, componentIndex) =>
        finiteF32(
          component,
          `${location}.channels[${channelIndex}].keyframes[${keyIndex}].value[${componentIndex}]`,
        ),
      );
      if (channel.kind === "rotation") {
        const [x, y, z, w] = normalizedValue;
        const length = Math.hypot(x, y, z, w);
        if (Math.abs(length - 1) > UNIT_QUATERNION_TOLERANCE) {
          throw new Error(
            `${location}.channels[${channelIndex}].keyframes[${keyIndex}].value must be a normalized quaternion`,
          );
        }
      }
      return { time, value: normalizedValue };
    });
    keyframeCount += keyframes.length;
    return { kind: channel.kind, node: channel.node, keyframes };
  });
  const startSeconds = Math.min(...channels.map((channel) => channel.keyframes[0].time));
  const endSeconds = Math.max(
    ...channels.map((channel) => channel.keyframes[channel.keyframes.length - 1].time),
  );
  return { channels, channelCount: channels.length, keyframeCount, startSeconds, endSeconds };
}

function sameF32(left, right) {
  return Math.fround(left) === Math.fround(right);
}

function sameF32Value(left, right) {
  if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
    return left.every((component, index) => sameF32(component, right[index]));
  }
  return false;
}

function assertChannelIdentities(source, output, operationId) {
  if (output.channelCount !== source.channelCount) {
    throw new Error(`${operationId} output channel count differs from the source`);
  }
  for (let index = 0; index < source.channels.length; index += 1) {
    if (
      output.channels[index].kind !== source.channels[index].kind ||
      output.channels[index].node !== source.channels[index].node
    ) {
      throw new Error(`${operationId} output channel identity/order differs from the source`);
    }
  }
}

function normalizeResampleObservations(value, source, output, parameters) {
  const observations = assertExactKeys(
    value,
    new Set(["sourceKeyframeCount", "resultKeyframeCount", "channelCount", "durationSeconds"]),
    `${RESAMPLE_OPERATION_ID} observations`,
  );
  const sourceKeyframeCount = positiveSafeInteger(
    observations.sourceKeyframeCount,
    "observations.sourceKeyframeCount",
  );
  const resultKeyframeCount = positiveSafeInteger(
    observations.resultKeyframeCount,
    "observations.resultKeyframeCount",
  );
  const channelCount = positiveSafeInteger(observations.channelCount, "observations.channelCount");
  const durationSeconds = finiteNonNegative(observations.durationSeconds, "observations.durationSeconds");
  if (sourceKeyframeCount !== source.keyframeCount) {
    throw new Error("observations.sourceKeyframeCount does not match the source animation");
  }
  if (resultKeyframeCount !== output.keyframeCount) {
    throw new Error("observations.resultKeyframeCount does not match the output animation");
  }
  if (channelCount !== output.channelCount || channelCount !== source.channelCount) {
    throw new Error("observations.channelCount does not match the animation channels");
  }
  if (resultKeyframeCount !== channelCount * parameters.targetTimesSeconds.length) {
    throw new Error("animation.resample result keyframe count does not match the target grid");
  }
  const expectedDuration = Math.fround(
    Math.fround(parameters.targetTimesSeconds[parameters.targetTimesSeconds.length - 1]) -
      Math.fround(parameters.targetTimesSeconds[0]),
  );
  if (!sameF32(durationSeconds, expectedDuration)) {
    throw new Error("observations.durationSeconds does not match the target grid");
  }
  return { sourceKeyframeCount, resultKeyframeCount, channelCount, durationSeconds };
}

function validateResampleOutput(source, output, parameters) {
  assertChannelIdentities(source, output, RESAMPLE_OPERATION_ID);
  if (
    !sameF32(source.startSeconds, parameters.sourceStartSeconds) ||
    !sameF32(source.endSeconds, parameters.sourceEndSeconds)
  ) {
    throw new Error("animation.resample source time bounds do not match parameters");
  }
  for (const channel of output.channels) {
    if (channel.keyframes.length !== parameters.targetTimesSeconds.length) {
      throw new Error("animation.resample output channel keyframe count does not match targetTimesSeconds");
    }
    channel.keyframes.forEach((keyframe, index) => {
      if (!sameF32(keyframe.time, parameters.targetTimesSeconds[index])) {
        throw new Error("animation.resample output keyframe time differs from targetTimesSeconds");
      }
    });
  }
}

function sourceKeyFor(outputKey, sourceChannel) {
  return sourceChannel.keyframes.find(
    (candidate) => sameF32(candidate.time, outputKey.time) && sameF32Value(candidate.value, outputKey.value),
  );
}

function validateReduceOutput(source, output) {
  assertChannelIdentities(source, output, REDUCE_OPERATION_ID);
  for (let channelIndex = 0; channelIndex < source.channels.length; channelIndex += 1) {
    const sourceChannel = source.channels[channelIndex];
    const outputChannel = output.channels[channelIndex];
    for (const keyframe of outputChannel.keyframes) {
      if (!sourceKeyFor(keyframe, sourceChannel)) {
        throw new Error("animation.reduce output contains a keyframe not present in the source channel");
      }
    }
  }
}

function endpointsPreserved(source, output) {
  return source.channels.every((sourceChannel, index) => {
    const outputChannel = output.channels[index];
    const sourceFirst = sourceChannel.keyframes[0];
    const sourceLast = sourceChannel.keyframes[sourceChannel.keyframes.length - 1];
    const outputFirst = outputChannel.keyframes[0];
    const outputLast = outputChannel.keyframes[outputChannel.keyframes.length - 1];
    return (
      sameF32(sourceFirst.time, outputFirst.time) &&
      sameF32Value(sourceFirst.value, outputFirst.value) &&
      sameF32(sourceLast.time, outputLast.time) &&
      sameF32Value(sourceLast.value, outputLast.value)
    );
  });
}

function normalizeReduceObservations(value, source, output, parameters) {
  const observations = assertExactKeys(
    value,
    new Set([
      "sourceKeyframeCount",
      "resultKeyframeCount",
      "maxTranslationError",
      "maxRotationErrorRadians",
      "maxScaleError",
      "endpointsPreserved",
    ]),
    `${REDUCE_OPERATION_ID} observations`,
  );
  const sourceKeyframeCount = positiveSafeInteger(
    observations.sourceKeyframeCount,
    "observations.sourceKeyframeCount",
  );
  const resultKeyframeCount = positiveSafeInteger(
    observations.resultKeyframeCount,
    "observations.resultKeyframeCount",
  );
  const maxTranslationError = finiteNonNegative(
    observations.maxTranslationError,
    "observations.maxTranslationError",
  );
  const maxRotationErrorRadians = finiteNonNegative(
    observations.maxRotationErrorRadians,
    "observations.maxRotationErrorRadians",
  );
  const maxScaleError = finiteNonNegative(observations.maxScaleError, "observations.maxScaleError");
  if (typeof observations.endpointsPreserved !== "boolean") {
    throw new Error("observations.endpointsPreserved must be a boolean");
  }
  if (sourceKeyframeCount !== source.keyframeCount) {
    throw new Error("observations.sourceKeyframeCount does not match the source animation");
  }
  if (resultKeyframeCount !== output.keyframeCount) {
    throw new Error("observations.resultKeyframeCount does not match the output animation");
  }
  if (resultKeyframeCount > sourceKeyframeCount) {
    throw new Error("animation.reduce resultKeyframeCount must not exceed the source count");
  }
  if (maxTranslationError > parameters.translationError) {
    throw new Error("observations.maxTranslationError exceeds parameters.translationError");
  }
  if (maxRotationErrorRadians > parameters.rotationErrorRadians) {
    throw new Error("observations.maxRotationErrorRadians exceeds parameters.rotationErrorRadians");
  }
  if (maxScaleError > parameters.scaleError) {
    throw new Error("observations.maxScaleError exceeds parameters.scaleError");
  }
  const actualEndpointsPreserved = endpointsPreserved(source, output);
  if (observations.endpointsPreserved !== actualEndpointsPreserved) {
    throw new Error("observations.endpointsPreserved does not match the emitted animation");
  }
  if (parameters.preserveEndpoints && !actualEndpointsPreserved) {
    throw new Error("animation.reduce did not preserve required source endpoints");
  }
  return {
    sourceKeyframeCount,
    resultKeyframeCount,
    maxTranslationError,
    maxRotationErrorRadians,
    maxScaleError,
    endpointsPreserved: observations.endpointsPreserved,
  };
}

async function createBuildIdentity(root, operation, parameters, inputs, processorValue, processorId) {
  const base = createAssetOperationBuildIdentity({
    operation,
    implementation: { id: processorId, version: "unprobed" },
    parameters,
    inputs,
  });
  const identity = await processorIdentity(root, processorValue, {
    operationId: operation.id,
    processorId,
  });
  return createAssetOperationBuildIdentity({
    operation,
    implementation: identity.implementation,
    parameters: base.parameters,
    inputs: base.inputs,
  });
}

async function executeOperation({
  root,
  operation,
  parameters,
  inputs,
  processorValue,
  processorId,
  normalizeObservations,
  validateOutput,
}) {
  const source = inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseAnimationDocument(sourceBytes, `${operation.id} source animation`);
  const identity = await processorIdentity(root, processorValue, {
    operationId: operation.id,
    processorId,
  });
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "animation.json",
    request: {
      schemaVersion: 1,
      operation: operation.id,
      inputPath: assetObjectPortablePath(source),
      parameters,
    },
  });
  const parsedOutput = parseAnimationDocument(result.bytes, `${operation.id} processor output`);
  validateOutput(parsedSource, parsedOutput, parameters);
  const observations = normalizeObservations(
    result.observations,
    parsedSource,
    parsedOutput,
    parameters,
  );
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "animation",
    mediaType: THREE_D_ANIMATION_MEDIA_TYPE,
    metadata: {
      animationSchemaVersion: 1,
      channelCount: parsedOutput.channelCount,
      keyframeCount: parsedOutput.keyframeCount,
      operation: operation.id,
      sourceSha256: source.sha256,
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations,
  });
}

export async function createAnimationResampleOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeResampleParameters(parameterValue);
  return createBuildIdentity(
    root,
    ANIMATION_RESAMPLE_OPERATION,
    parameters,
    inputs,
    processorValue,
    RESAMPLE_PROCESSOR_ID,
  );
}

export async function executeAnimationResampleOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeResampleParameters(parameterValue);
  const identity = createAssetOperationBuildIdentity({
    operation: ANIMATION_RESAMPLE_OPERATION,
    implementation: { id: RESAMPLE_PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  return executeOperation({
    root,
    operation: ANIMATION_RESAMPLE_OPERATION,
    parameters: identity.parameters,
    inputs: identity.inputs,
    processorValue,
    processorId: RESAMPLE_PROCESSOR_ID,
    normalizeObservations: normalizeResampleObservations,
    validateOutput: validateResampleOutput,
  });
}

export async function createAnimationReduceOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeReduceParameters(parameterValue);
  return createBuildIdentity(
    root,
    ANIMATION_REDUCE_OPERATION,
    parameters,
    inputs,
    processorValue,
    REDUCE_PROCESSOR_ID,
  );
}

export async function executeAnimationReduceOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeReduceParameters(parameterValue);
  const identity = createAssetOperationBuildIdentity({
    operation: ANIMATION_REDUCE_OPERATION,
    implementation: { id: REDUCE_PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  return executeOperation({
    root,
    operation: ANIMATION_REDUCE_OPERATION,
    parameters: identity.parameters,
    inputs: identity.inputs,
    processorValue,
    processorId: REDUCE_PROCESSOR_ID,
    normalizeObservations: normalizeReduceObservations,
    validateOutput: validateReduceOutput,
  });
}
