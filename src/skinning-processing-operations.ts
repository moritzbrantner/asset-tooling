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
import { captureCargoRuntimeIdentity } from "./processor-runtime.js";
import { captureToolIdentity } from "./tool.js";

const execFileAsync = promisify(execFile);

export const THREE_D_SKINNING_MEDIA_TYPE =
  "application/vnd.moritzbrantner.three-d.skinning+json";

const OPERATION_ID = "mesh.skinning.validate";
const OPERATION_VERSION = "1";
const PROCESSOR_ID = "three-d-skinning-validate";
const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const PROCESSOR_CODEC = "three-d-skinning-json-v1";
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WEIGHT_SUM_TOLERANCE = 1.0e-5;

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Validate skinned-mesh production evidence",
    description:
      "Validate and normalize skeleton bind-pose and four-slot skin-influence evidence through the authoritative three-d-animation contract.",
    category: "mesh.processing",
    inputs: [
      {
        id: "source",
        label: "Source skinning evidence",
        assetKinds: ["skinning"],
        mediaTypes: [THREE_D_SKINNING_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Validated skinning evidence",
        assetKinds: ["skinning"],
        mediaTypes: [THREE_D_SKINNING_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["bindPoseIdentityTolerance"],
      properties: {
        bindPoseIdentityTolerance: { type: "number", minimum: 0 },
      },
    },
  },
]);

export const MESH_SKINNING_VALIDATE_OPERATION = OPERATION_REGISTRY.get(
  OPERATION_ID,
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
  return Object.is(normalized, -0) ? 0 : normalized;
}

function finiteNonNegativeF32(value, location) {
  const normalized = finiteF32(value, location);
  if (normalized < 0) throw new Error(`${location} must be non-negative`);
  return normalized;
}

function positiveSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeParameters(value) {
  const parameters = assertExactKeys(
    value,
    new Set(["bindPoseIdentityTolerance"]),
    `${OPERATION_ID} parameters`,
  );
  return {
    bindPoseIdentityTolerance: finiteNonNegativeF32(
      parameters.bindPoseIdentityTolerance,
      "parameters.bindPoseIdentityTolerance",
    ),
  };
}

function normalizeProcessor(value) {
  const processor = assertPlainObject(value, `${OPERATION_ID} processor`);
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
    if (!allowed.has(key)) throw new Error(`${OPERATION_ID} processor contains unknown field '${key}'`);
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
  if (
    /^cargo(?:\.exe)?$/i.test(path.basename(executable)) &&
    !prefixArguments.includes("--offline") &&
    !prefixArguments.includes("--frozen")
  ) {
    throw new Error(`${OPERATION_ID} cargo processor must run with --offline or --frozen`);
  }

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
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
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

async function verifyProcessorSource(processor, root) {
  if (processor.checkoutRoot !== undefined) {
    const actualRevision = await gitOutput(
      processor.checkoutRoot,
      ["rev-parse", "HEAD"],
      `${OPERATION_ID} processor checkout revision verification`,
    );
    if (actualRevision !== processor.revision) {
      throw new Error(
        `${OPERATION_ID} processor checkout HEAD '${actualRevision}' does not match declared revision '${processor.revision}'`,
      );
    }
    const status = await gitOutput(
      processor.checkoutRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      `${OPERATION_ID} processor checkout cleanliness verification`,
    );
    const unexpectedStatus = status
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && line !== "?? Cargo.lock");
    if (unexpectedStatus.length > 0) {
      throw new Error(`${OPERATION_ID} processor checkout must be source-clean at the declared revision`);
    }

    if (/^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))) {
      const manifestIndex = processor.prefixArguments.indexOf("--manifest-path");
      const manifestValue = processor.prefixArguments[manifestIndex + 1];
      if (manifestIndex < 0 || typeof manifestValue !== "string") {
        throw new Error(`${OPERATION_ID} cargo processor must declare --manifest-path`);
      }
      const manifestPath = path.resolve(manifestValue);
      if (!pathIsInside(processor.checkoutRoot, manifestPath)) {
        throw new Error(`${OPERATION_ID} processor manifest must be inside checkoutRoot`);
      }
      const manifestRelativePath = path.relative(processor.checkoutRoot, manifestPath);
      await gitOutput(
        processor.checkoutRoot,
        ["ls-files", "--error-unmatch", "--", manifestRelativePath],
        `${OPERATION_ID} processor manifest tracking verification`,
      );
    } else {
      const scriptPath = path.isAbsolute(processor.scriptPath)
        ? path.resolve(processor.scriptPath)
        : path.resolve(root, processor.scriptPath);
      if (!pathIsInside(processor.checkoutRoot, scriptPath)) {
        throw new Error(`${OPERATION_ID} processor script must be inside checkoutRoot`);
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
    throw new Error(`${OPERATION_ID} processor.sourceFiles must include the executed scriptPath`);
  }
  const fileHashes = [];
  for (const sourceFile of processor.sourceFiles) {
    let bytes;
    try {
      bytes = await readFile(sourceFile);
    } catch (error) {
      throw new Error(
        `${OPERATION_ID} processor source file '${sourceFile}' could not be read: ${error.message}`,
      );
    }
    fileHashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  fileHashes.sort();
  return {
    repository: processor.repository,
    revision: processor.revision,
    sourceSha256: createHash("sha256").update(JSON.stringify(fileHashes)).digest("hex"),
  };
}

function normalizeProbe(components) {
  const matching = components.filter((component) => component.id === PROCESSOR_ID);
  if (matching.length !== 1) {
    throw new Error(`processor probe must contain exactly one '${PROCESSOR_ID}' component`);
  }
  const component = assertPlainObject(matching[0], `${OPERATION_ID} processor probe component`);
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

async function processorIdentity(root, processorValue) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(`${OPERATION_ID} root must be an absolute path`);
  }
  const processor = normalizeProcessor(processorValue);
  const source = await verifyProcessorSource(processor, root);
  const environment = processorStorageEnvironment(processor);
  const runtime = /^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))
    ? await captureCargoRuntimeIdentity({
        executable: processor.executable,
        cwd: processor.checkoutRoot ?? root,
        environment,
      })
    : undefined;
  const components = await probeProcessAdapter({
    executable: processor.executable,
    scriptPath: processor.scriptPath,
    prefixArguments: processor.prefixArguments,
    cwd: root,
    environment,
  });
  const probe = normalizeProbe(components);
  return {
    processor,
    environment,
    implementation: {
      id: probe.id,
      version: probe.version,
      source,
      ...(runtime ? { runtime } : {}),
      probe,
      assetTooling: await captureToolIdentity(),
    },
  };
}

function matrix(value, location) {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new Error(`${location} must contain exactly 16 finite f32 values`);
  }
  return value.map((component, index) => finiteF32(component, `${location}[${index}]`));
}

function jointIndices(value, location) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${location} must contain exactly four u16 joint indices`);
  }
  return value.map((joint, index) => {
    if (!Number.isInteger(joint) || joint < 0 || joint > 65535) {
      throw new Error(`${location}[${index}] must be an integer in 0..65535`);
    }
    return joint;
  });
}

function weights(value, location) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${location} must contain exactly four finite non-negative f32 weights`);
  }
  const normalized = value.map((weight, index) =>
    finiteNonNegativeF32(weight, `${location}[${index}]`),
  );
  if (!normalized.some((weight) => weight > 0)) {
    throw new Error(`${location} must contain at least one positive weight`);
  }
  return normalized;
}

function parseSkinningDocument(bytes, location, { requireNormalizedWeights = false } = {}) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${location} is not valid JSON: ${error.message}`);
  }
  const document = assertExactKeys(value, new Set(["schemaVersion", "joints", "influences"]), location);
  if (document.schemaVersion !== 1) throw new Error(`${location} schemaVersion must be 1`);
  if (!Array.isArray(document.joints) || document.joints.length === 0) {
    throw new Error(`${location}.joints must be a non-empty array`);
  }
  if (!Array.isArray(document.influences) || document.influences.length === 0) {
    throw new Error(`${location}.influences must be a non-empty array`);
  }

  let rootJointCount = 0;
  const joints = document.joints.map((entry, index) => {
    const joint = assertExactKeys(
      entry,
      new Set(["parent", "inverseBind", "bindWorld"]),
      `${location}.joints[${index}]`,
    );
    let parent = joint.parent;
    if (parent === null) {
      rootJointCount += 1;
    } else {
      parent = nonNegativeSafeInteger(parent, `${location}.joints[${index}].parent`);
      if (parent >= index) {
        throw new Error(`${location}.joints[${index}].parent must reference an earlier joint`);
      }
    }
    return {
      parent,
      inverseBind: matrix(joint.inverseBind, `${location}.joints[${index}].inverseBind`),
      bindWorld: matrix(joint.bindWorld, `${location}.joints[${index}].bindWorld`),
    };
  });

  let maxActiveInfluences = 0;
  let activeJointIndicesInRange = true;
  const influences = document.influences.map((entry, index) => {
    const influence = assertExactKeys(
      entry,
      new Set(["joints", "weights"]),
      `${location}.influences[${index}]`,
    );
    const normalizedJoints = jointIndices(
      influence.joints,
      `${location}.influences[${index}].joints`,
    );
    const normalizedWeights = weights(
      influence.weights,
      `${location}.influences[${index}].weights`,
    );
    const active = normalizedWeights.reduce((count, weight, slot) => {
      if (weight <= 0) return count;
      if (normalizedJoints[slot] >= joints.length) activeJointIndicesInRange = false;
      return count + 1;
    }, 0);
    maxActiveInfluences = Math.max(maxActiveInfluences, active);
    if (requireNormalizedWeights) {
      const sum = normalizedWeights.reduce((total, weight) => total + weight, 0);
      if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
        throw new Error(`${location}.influences[${index}].weights must sum to one`);
      }
    }
    return { joints: normalizedJoints, weights: normalizedWeights };
  });

  return {
    joints,
    influences,
    jointCount: joints.length,
    rootJointCount,
    vertexInfluenceCount: influences.length,
    maxActiveInfluences,
    activeJointIndicesInRange,
  };
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateOutput(source, output) {
  if (output.jointCount !== source.jointCount) {
    throw new Error(`${OPERATION_ID} output joint count differs from the source`);
  }
  if (output.vertexInfluenceCount !== source.vertexInfluenceCount) {
    throw new Error(`${OPERATION_ID} output influence count differs from the source`);
  }
  for (let index = 0; index < source.joints.length; index += 1) {
    const sourceJoint = source.joints[index];
    const outputJoint = output.joints[index];
    if (
      sourceJoint.parent !== outputJoint.parent ||
      !sameArray(sourceJoint.inverseBind, outputJoint.inverseBind) ||
      !sameArray(sourceJoint.bindWorld, outputJoint.bindWorld)
    ) {
      throw new Error(`${OPERATION_ID} output changed skeleton or bind-pose data`);
    }
  }
  for (let index = 0; index < source.influences.length; index += 1) {
    if (!sameArray(source.influences[index].joints, output.influences[index].joints)) {
      throw new Error(`${OPERATION_ID} output changed skin joint slots`);
    }
  }
  if (!output.activeJointIndicesInRange) {
    throw new Error(`${OPERATION_ID} output contains an active joint index outside the skeleton`);
  }
}

function assertTrue(value, location) {
  if (value !== true) throw new Error(`${location} must be true`);
  return true;
}

function normalizeObservations(value, output, parameters) {
  const observations = assertExactKeys(
    value,
    new Set([
      "jointCount",
      "rootJointCount",
      "vertexInfluenceCount",
      "influenceSlotsPerVertex",
      "maxActiveInfluences",
      "parentBeforeChild",
      "weightsNormalized",
      "activeJointIndicesInRange",
      "inverseBindMatchesBindPose",
      "maxBindPoseIdentityError",
      "matrixLayout",
      "skinMatrixRule",
    ]),
    `${OPERATION_ID} observations`,
  );
  const jointCount = positiveSafeInteger(observations.jointCount, "observations.jointCount");
  const rootJointCount = positiveSafeInteger(
    observations.rootJointCount,
    "observations.rootJointCount",
  );
  const vertexInfluenceCount = positiveSafeInteger(
    observations.vertexInfluenceCount,
    "observations.vertexInfluenceCount",
  );
  if (observations.influenceSlotsPerVertex !== 4) {
    throw new Error("observations.influenceSlotsPerVertex must be 4");
  }
  const maxActiveInfluences = positiveSafeInteger(
    observations.maxActiveInfluences,
    "observations.maxActiveInfluences",
  );
  if (maxActiveInfluences > 4) {
    throw new Error("observations.maxActiveInfluences must not exceed 4");
  }
  const maxBindPoseIdentityError = finiteNonNegativeF32(
    observations.maxBindPoseIdentityError,
    "observations.maxBindPoseIdentityError",
  );
  if (maxBindPoseIdentityError > parameters.bindPoseIdentityTolerance) {
    throw new Error(
      "observations.maxBindPoseIdentityError exceeds parameters.bindPoseIdentityTolerance",
    );
  }
  if (jointCount !== output.jointCount) {
    throw new Error("observations.jointCount does not match the output skinning document");
  }
  if (rootJointCount !== output.rootJointCount) {
    throw new Error("observations.rootJointCount does not match the output skinning document");
  }
  if (vertexInfluenceCount !== output.vertexInfluenceCount) {
    throw new Error(
      "observations.vertexInfluenceCount does not match the output skinning document",
    );
  }
  if (maxActiveInfluences !== output.maxActiveInfluences) {
    throw new Error("observations.maxActiveInfluences does not match the output skinning document");
  }
  assertTrue(observations.parentBeforeChild, "observations.parentBeforeChild");
  assertTrue(observations.weightsNormalized, "observations.weightsNormalized");
  assertTrue(
    observations.activeJointIndicesInRange,
    "observations.activeJointIndicesInRange",
  );
  assertTrue(
    observations.inverseBindMatchesBindPose,
    "observations.inverseBindMatchesBindPose",
  );
  if (observations.matrixLayout !== "column-major-4x4") {
    throw new Error("observations.matrixLayout must be 'column-major-4x4'");
  }
  if (observations.skinMatrixRule !== "joint-world-times-inverse-bind") {
    throw new Error(
      "observations.skinMatrixRule must be 'joint-world-times-inverse-bind'",
    );
  }
  return {
    jointCount,
    rootJointCount,
    vertexInfluenceCount,
    influenceSlotsPerVertex: 4,
    maxActiveInfluences,
    parentBeforeChild: true,
    weightsNormalized: true,
    activeJointIndicesInRange: true,
    inverseBindMatchesBindPose: true,
    maxBindPoseIdentityError,
    matrixLayout: "column-major-4x4",
    skinMatrixRule: "joint-world-times-inverse-bind",
  };
}

export async function createMeshSkinningValidateOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue);
  const base = createAssetOperationBuildIdentity({
    operation: MESH_SKINNING_VALIDATE_OPERATION,
    implementation: { id: PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const identity = await processorIdentity(root, processorValue);
  return createAssetOperationBuildIdentity({
    operation: MESH_SKINNING_VALIDATE_OPERATION,
    implementation: identity.implementation,
    parameters: base.parameters,
    inputs: base.inputs,
  });
}

export async function executeMeshSkinningValidateOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue);
  const invocation = createAssetOperationBuildIdentity({
    operation: MESH_SKINNING_VALIDATE_OPERATION,
    implementation: { id: PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const source = invocation.inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseSkinningDocument(sourceBytes, `${OPERATION_ID} source`);
  const identity = await processorIdentity(root, processorValue);
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "skinning.json",
    request: {
      schemaVersion: 1,
      operation: OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: invocation.parameters,
    },
  });
  const parsedOutput = parseSkinningDocument(
    result.bytes,
    `${OPERATION_ID} processor output`,
    { requireNormalizedWeights: true },
  );
  validateOutput(parsedSource, parsedOutput);
  const observations = normalizeObservations(
    result.observations,
    parsedOutput,
    invocation.parameters,
  );
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "skinning",
    mediaType: THREE_D_SKINNING_MEDIA_TYPE,
    metadata: {
      skinningSchemaVersion: 1,
      jointCount: parsedOutput.jointCount,
      vertexInfluenceCount: parsedOutput.vertexInfluenceCount,
      influenceSlotsPerVertex: 4,
      maxActiveInfluences: parsedOutput.maxActiveInfluences,
      operation: OPERATION_ID,
      sourceSha256: source.sha256,
    },
  });
  return normalizeAssetOperationResult(MESH_SKINNING_VALIDATE_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}
