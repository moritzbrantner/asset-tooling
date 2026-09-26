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

export const THREE_D_RIGGED_COLLISION_INPUT_MEDIA_TYPE =
  "application/vnd.moritzbrantner.three-d.rigged-collision-input+json";
export const THREE_D_RIGGED_COLLISION_MEDIA_TYPE =
  "application/vnd.moritzbrantner.three-d.rigged-collision+json";

const OPERATION_ID = "mesh.rigged-collision.fit";
const OPERATION_VERSION = "1";
const PROCESSOR_ID = "three-d-rigged-collision-fit";
const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const PROCESSOR_CODEC = "three-d-rigged-collision-json-v1";
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Fit rigged collision proxies",
    description:
      "Fit deterministic joint-local primitive collision proxies through the authoritative three-d-rigged-assets contract.",
    category: "mesh.processing",
    inputs: [
      {
        id: "source",
        label: "Rigged bind-pose source",
        assetKinds: ["rigged-mesh"],
        mediaTypes: [THREE_D_RIGGED_COLLISION_INPUT_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Joint collision proxies",
        assetKinds: ["collision"],
        mediaTypes: [THREE_D_RIGGED_COLLISION_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "minVerticesPerJoint",
        "minDominantWeight",
        "padding",
        "minimumExtent",
        "sphereAspectRatio",
        "capsuleAspectRatio",
      ],
      properties: {
        minVerticesPerJoint: { type: "integer", minimum: 1 },
        minDominantWeight: { type: "number", minimum: 0, maximum: 1 },
        padding: { type: "number", minimum: 0 },
        minimumExtent: { type: "number", exclusiveMinimum: 0 },
        sphereAspectRatio: { type: "number", minimum: 1 },
        capsuleAspectRatio: { type: "number", exclusiveMinimum: 1 },
      },
    },
  },
]);

export const MESH_RIGGED_COLLISION_FIT_OPERATION = OPERATION_REGISTRY.get(
  OPERATION_ID,
  OPERATION_VERSION,
);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, location) {
  if (!isPlainObject(value)) throw new Error(location + " must be a plain object");
  return value;
}

function assertExactKeys(value, keys, location) {
  const object = assertPlainObject(value, location);
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) throw new Error(location + " contains unknown field '" + key + "'");
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(location + " is missing '" + key + "'");
  }
  return object;
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(location + " must be a non-empty string");
  }
  return value;
}

function finiteNumber(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(location + " must be a finite number");
  }
  return value;
}

function finiteF32(value, location) {
  const normalized = Math.fround(finiteNumber(value, location));
  if (!Number.isFinite(normalized)) {
    throw new Error(location + " must be representable as a finite f32");
  }
  return Object.is(normalized, -0) ? 0 : normalized;
}

function finiteNonNegativeF32(value, location) {
  const normalized = finiteF32(value, location);
  if (normalized < 0) throw new Error(location + " must be non-negative");
  return normalized;
}

function finitePositiveF32(value, location) {
  const normalized = finiteF32(value, location);
  if (normalized <= 0) throw new Error(location + " must be positive");
  return normalized;
}

function positiveSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(location + " must be a positive safe integer");
  }
  return value;
}

function nonNegativeSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(location + " must be a non-negative safe integer");
  }
  return value;
}

function normalizeParameters(value) {
  const parameters = assertExactKeys(
    value,
    new Set([
      "minVerticesPerJoint",
      "minDominantWeight",
      "padding",
      "minimumExtent",
      "sphereAspectRatio",
      "capsuleAspectRatio",
    ]),
    OPERATION_ID + " parameters",
  );
  const minDominantWeight = finiteNonNegativeF32(
    parameters.minDominantWeight,
    "parameters.minDominantWeight",
  );
  if (minDominantWeight > 1) {
    throw new Error("parameters.minDominantWeight must not exceed 1");
  }
  const sphereAspectRatio = finitePositiveF32(
    parameters.sphereAspectRatio,
    "parameters.sphereAspectRatio",
  );
  if (sphereAspectRatio < 1) {
    throw new Error("parameters.sphereAspectRatio must be at least 1");
  }
  const capsuleAspectRatio = finitePositiveF32(
    parameters.capsuleAspectRatio,
    "parameters.capsuleAspectRatio",
  );
  if (capsuleAspectRatio <= 1) {
    throw new Error("parameters.capsuleAspectRatio must be greater than 1");
  }
  return {
    minVerticesPerJoint: positiveSafeInteger(
      parameters.minVerticesPerJoint,
      "parameters.minVerticesPerJoint",
    ),
    minDominantWeight,
    padding: finiteNonNegativeF32(parameters.padding, "parameters.padding"),
    minimumExtent: finitePositiveF32(parameters.minimumExtent, "parameters.minimumExtent"),
    sphereAspectRatio,
    capsuleAspectRatio,
  };
}

function normalizeProcessor(value) {
  const processor = assertPlainObject(value, OPERATION_ID + " processor");
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
    if (!allowed.has(key)) throw new Error(OPERATION_ID + " processor contains unknown field '" + key + "'");
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
    assertNonEmptyString(argument, "processor.prefixArguments[" + index + "]"),
  );
  if (
    /^cargo(?:\.exe)?$/i.test(path.basename(executable)) &&
    !prefixArguments.includes("--offline") &&
    !prefixArguments.includes("--frozen")
  ) {
    throw new Error(OPERATION_ID + " cargo processor must run with --offline or --frozen");
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
      const normalized = assertNonEmptyString(file, "processor.sourceFiles[" + index + "]");
      if (!path.isAbsolute(normalized)) {
        throw new Error("processor.sourceFiles[" + index + "] must be an absolute path");
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
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
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
    throw new Error(location + " failed: " + error.message);
  }
}

async function verifyProcessorSource(processor, root) {
  if (processor.checkoutRoot !== undefined) {
    const actualRevision = await gitOutput(
      processor.checkoutRoot,
      ["rev-parse", "HEAD"],
      OPERATION_ID + " processor checkout revision verification",
    );
    if (actualRevision !== processor.revision) {
      throw new Error(
        OPERATION_ID + " processor checkout HEAD '" + actualRevision +
          "' does not match declared revision '" + processor.revision + "'",
      );
    }
    const status = await gitOutput(
      processor.checkoutRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      OPERATION_ID + " processor checkout cleanliness verification",
    );
    const unexpectedStatus = status
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && line !== "?? Cargo.lock");
    if (unexpectedStatus.length > 0) {
      throw new Error(OPERATION_ID + " processor checkout must be source-clean at the declared revision");
    }

    if (/^cargo(?:\.exe)?$/i.test(path.basename(processor.executable))) {
      const manifestIndex = processor.prefixArguments.indexOf("--manifest-path");
      const manifestValue = processor.prefixArguments[manifestIndex + 1];
      if (manifestIndex < 0 || typeof manifestValue !== "string") {
        throw new Error(OPERATION_ID + " cargo processor must declare --manifest-path");
      }
      const manifestPath = path.resolve(manifestValue);
      if (!pathIsInside(processor.checkoutRoot, manifestPath)) {
        throw new Error(OPERATION_ID + " processor manifest must be inside checkoutRoot");
      }
      const manifestRelativePath = path.relative(processor.checkoutRoot, manifestPath);
      await gitOutput(
        processor.checkoutRoot,
        ["ls-files", "--error-unmatch", "--", manifestRelativePath],
        OPERATION_ID + " processor manifest tracking verification",
      );
    } else {
      const scriptPath = path.isAbsolute(processor.scriptPath)
        ? path.resolve(processor.scriptPath)
        : path.resolve(root, processor.scriptPath);
      if (!pathIsInside(processor.checkoutRoot, scriptPath)) {
        throw new Error(OPERATION_ID + " processor script must be inside checkoutRoot");
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
    throw new Error(OPERATION_ID + " processor.sourceFiles must include the executed scriptPath");
  }
  const fileHashes = [];
  for (const sourceFile of processor.sourceFiles) {
    let bytes;
    try {
      bytes = await readFile(sourceFile);
    } catch (error) {
      throw new Error(
        OPERATION_ID + " processor source file '" + sourceFile + "' could not be read: " + error.message,
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
    throw new Error("processor probe must contain exactly one '" + PROCESSOR_ID + "' component");
  }
  const component = assertPlainObject(matching[0], OPERATION_ID + " processor probe component");
  assertNonEmptyString(component.version, "processor probe version");
  assertNonEmptyString(component.algorithm, "processor probe algorithm");
  if (component.protocol !== PROCESSOR_PROTOCOL) {
    throw new Error("processor probe protocol must be '" + PROCESSOR_PROTOCOL + "'");
  }
  if (component.codec !== PROCESSOR_CODEC) {
    throw new Error("processor probe codec must be '" + PROCESSOR_CODEC + "'");
  }
  assertPlainObject(component.dependencies, "processor probe dependencies");
  assertNonEmptyString(component.cargoLock, "processor probe cargoLock");
  return component;
}

async function processorIdentity(root, processorValue) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(OPERATION_ID + " root must be an absolute path");
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

function vector3(value, location, positive = false) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(location + " must contain exactly three finite f32 values");
  }
  return value.map((component, index) =>
    positive
      ? finitePositiveF32(component, location + "[" + index + "]")
      : finiteF32(component, location + "[" + index + "]"),
  );
}

function matrix(value, location) {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new Error(location + " must contain exactly 16 finite f32 values");
  }
  return value.map((component, index) => finiteF32(component, location + "[" + index + "]"));
}

function jointIndices(value, location) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(location + " must contain exactly four u16 joint indices");
  }
  return value.map((joint, index) => {
    if (!Number.isInteger(joint) || joint < 0 || joint > 65535) {
      throw new Error(location + "[" + index + "] must be an integer in 0..65535");
    }
    return joint;
  });
}

function weights(value, location) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(location + " must contain exactly four finite non-negative f32 weights");
  }
  const normalized = value.map((weight, index) =>
    finiteNonNegativeF32(weight, location + "[" + index + "]"),
  );
  if (!normalized.some((weight) => weight > 0)) {
    throw new Error(location + " must contain at least one positive weight");
  }
  return normalized;
}

function parseSourceDocument(bytes, location) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(location + " is not valid JSON: " + error.message);
  }
  const document = assertExactKeys(
    value,
    new Set(["schemaVersion", "positions", "joints", "influences"]),
    location,
  );
  if (document.schemaVersion !== 1) throw new Error(location + " schemaVersion must be 1");
  if (!Array.isArray(document.positions) || document.positions.length === 0) {
    throw new Error(location + ".positions must be a non-empty array");
  }
  if (!Array.isArray(document.joints) || document.joints.length === 0) {
    throw new Error(location + ".joints must be a non-empty array");
  }
  if (!Array.isArray(document.influences) || document.influences.length !== document.positions.length) {
    throw new Error(location + ".influences must contain one entry per position");
  }

  const positions = document.positions.map((position, index) =>
    vector3(position, location + ".positions[" + index + "]"),
  );
  const joints = document.joints.map((entry, index) => {
    const joint = assertExactKeys(
      entry,
      new Set(["parent", "inverseBind"]),
      location + ".joints[" + index + "]",
    );
    let parent = joint.parent;
    if (parent !== null) {
      parent = nonNegativeSafeInteger(parent, location + ".joints[" + index + "].parent");
      if (parent >= index) {
        throw new Error(location + ".joints[" + index + "].parent must reference an earlier joint");
      }
    }
    return {
      parent,
      inverseBind: matrix(joint.inverseBind, location + ".joints[" + index + "].inverseBind"),
    };
  });
  if (joints.length > 65536) {
    throw new Error(location + ".joints must fit u16 skin indices");
  }

  const influences = document.influences.map((entry, index) => {
    const influence = assertExactKeys(
      entry,
      new Set(["joints", "weights"]),
      location + ".influences[" + index + "]",
    );
    const normalizedJoints = jointIndices(
      influence.joints,
      location + ".influences[" + index + "].joints",
    );
    const normalizedWeights = weights(
      influence.weights,
      location + ".influences[" + index + "].weights",
    );
    for (let slot = 0; slot < 4; slot += 1) {
      if (normalizedWeights[slot] > 0 && normalizedJoints[slot] >= joints.length) {
        throw new Error(
          location + ".influences[" + index + "].joints[" + slot + "] is outside the skeleton",
        );
      }
    }
    return { joints: normalizedJoints, weights: normalizedWeights };
  });

  return {
    positions,
    joints,
    influences,
    vertexCount: positions.length,
    jointCount: joints.length,
  };
}

function parseOutputDocument(bytes, location, source) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(location + " is not valid JSON: " + error.message);
  }
  const document = assertExactKeys(
    value,
    new Set(["schemaVersion", "coordinateSystem", "transformSpace", "capsuleAxis", "proxies"]),
    location,
  );
  if (document.schemaVersion !== 1) throw new Error(location + " schemaVersion must be 1");
  if (document.coordinateSystem !== "right-handed-y-up") {
    throw new Error(location + ".coordinateSystem must be 'right-handed-y-up'");
  }
  if (document.transformSpace !== "joint-bind-local") {
    throw new Error(location + ".transformSpace must be 'joint-bind-local'");
  }
  if (document.capsuleAxis !== "local-y") {
    throw new Error(location + ".capsuleAxis must be 'local-y'");
  }
  if (!Array.isArray(document.proxies)) throw new Error(location + ".proxies must be an array");

  const seenJoints = new Set();
  let previousJoint = -1;
  const shapeCounts = { boxCount: 0, sphereCount: 0, capsuleCount: 0 };
  const proxies = document.proxies.map((entry, index) => {
    const base = assertPlainObject(entry, location + ".proxies[" + index + "]");
    const joint = nonNegativeSafeInteger(base.joint, location + ".proxies[" + index + "].joint");
    if (joint >= source.jointCount) {
      throw new Error(location + ".proxies[" + index + "].joint is outside the skeleton");
    }
    if (seenJoints.has(joint)) {
      throw new Error(location + ".proxies must not contain duplicate joint targets");
    }
    if (joint <= previousJoint) {
      throw new Error(location + ".proxies must be ordered by ascending joint");
    }
    seenJoints.add(joint);
    previousJoint = joint;

    const center = vector3(base.center, location + ".proxies[" + index + "].center");
    if (base.shape === "box") {
      const proxy = assertExactKeys(
        base,
        new Set(["shape", "joint", "center", "size"]),
        location + ".proxies[" + index + "]",
      );
      shapeCounts.boxCount += 1;
      return {
        shape: "box",
        joint,
        center,
        size: vector3(proxy.size, location + ".proxies[" + index + "].size", true),
      };
    }
    if (base.shape === "sphere") {
      const proxy = assertExactKeys(
        base,
        new Set(["shape", "joint", "center", "radius"]),
        location + ".proxies[" + index + "]",
      );
      shapeCounts.sphereCount += 1;
      return {
        shape: "sphere",
        joint,
        center,
        radius: finitePositiveF32(proxy.radius, location + ".proxies[" + index + "].radius"),
      };
    }
    if (base.shape === "capsule") {
      const proxy = assertExactKeys(
        base,
        new Set(["shape", "joint", "center", "radius", "segmentLength"]),
        location + ".proxies[" + index + "]",
      );
      shapeCounts.capsuleCount += 1;
      return {
        shape: "capsule",
        joint,
        center,
        radius: finitePositiveF32(proxy.radius, location + ".proxies[" + index + "].radius"),
        segmentLength: finitePositiveF32(
          proxy.segmentLength,
          location + ".proxies[" + index + "].segmentLength",
        ),
      };
    }
    throw new Error(location + ".proxies[" + index + "].shape must be box, sphere, or capsule");
  });

  return {
    proxies,
    proxyCount: proxies.length,
    shapeCounts,
  };
}

function normalizeShapeCounts(value, expected) {
  const counts = assertExactKeys(
    value,
    new Set(["boxCount", "sphereCount", "capsuleCount"]),
    "observations.shapeCounts",
  );
  const normalized = {
    boxCount: nonNegativeSafeInteger(counts.boxCount, "observations.shapeCounts.boxCount"),
    sphereCount: nonNegativeSafeInteger(counts.sphereCount, "observations.shapeCounts.sphereCount"),
    capsuleCount: nonNegativeSafeInteger(
      counts.capsuleCount,
      "observations.shapeCounts.capsuleCount",
    ),
  };
  for (const key of Object.keys(normalized)) {
    if (normalized[key] !== expected[key]) {
      throw new Error("observations.shapeCounts does not match processor output");
    }
  }
  return normalized;
}

function normalizeObservations(value, source, output) {
  const observations = assertExactKeys(
    value,
    new Set([
      "jointCount",
      "vertexCount",
      "assignedVertices",
      "lowConfidenceVertices",
      "representedVertices",
      "unrepresentedAssignedVertices",
      "representedJointCount",
      "proxyCount",
      "shapeCounts",
      "capsuleAxis",
      "transformSpace",
    ]),
    OPERATION_ID + " observations",
  );
  const jointCount = positiveSafeInteger(observations.jointCount, "observations.jointCount");
  const vertexCount = positiveSafeInteger(observations.vertexCount, "observations.vertexCount");
  const assignedVertices = nonNegativeSafeInteger(
    observations.assignedVertices,
    "observations.assignedVertices",
  );
  const lowConfidenceVertices = nonNegativeSafeInteger(
    observations.lowConfidenceVertices,
    "observations.lowConfidenceVertices",
  );
  const representedVertices = nonNegativeSafeInteger(
    observations.representedVertices,
    "observations.representedVertices",
  );
  const unrepresentedAssignedVertices = nonNegativeSafeInteger(
    observations.unrepresentedAssignedVertices,
    "observations.unrepresentedAssignedVertices",
  );
  const representedJointCount = nonNegativeSafeInteger(
    observations.representedJointCount,
    "observations.representedJointCount",
  );
  const proxyCount = nonNegativeSafeInteger(observations.proxyCount, "observations.proxyCount");
  const shapeCounts = normalizeShapeCounts(observations.shapeCounts, output.shapeCounts);

  if (jointCount !== source.jointCount) throw new Error("observations.jointCount does not match source");
  if (vertexCount !== source.vertexCount) throw new Error("observations.vertexCount does not match source");
  if (assignedVertices + lowConfidenceVertices !== vertexCount) {
    throw new Error("observations assigned/low-confidence counts must partition source vertices");
  }
  if (representedVertices > assignedVertices) {
    throw new Error("observations.representedVertices must not exceed assignedVertices");
  }
  if (unrepresentedAssignedVertices !== assignedVertices - representedVertices) {
    throw new Error("observations.unrepresentedAssignedVertices is inconsistent");
  }
  if (representedJointCount !== output.proxyCount || proxyCount !== output.proxyCount) {
    throw new Error("observations proxy counts do not match processor output");
  }
  if (shapeCounts.boxCount + shapeCounts.sphereCount + shapeCounts.capsuleCount !== proxyCount) {
    throw new Error("observations.shapeCounts must sum to proxyCount");
  }
  if (observations.capsuleAxis !== "local-y") {
    throw new Error("observations.capsuleAxis must be 'local-y'");
  }
  if (observations.transformSpace !== "joint-bind-local") {
    throw new Error("observations.transformSpace must be 'joint-bind-local'");
  }

  return {
    jointCount,
    vertexCount,
    assignedVertices,
    lowConfidenceVertices,
    representedVertices,
    unrepresentedAssignedVertices,
    representedJointCount,
    proxyCount,
    shapeCounts,
    capsuleAxis: "local-y",
    transformSpace: "joint-bind-local",
  };
}

export async function createMeshRiggedCollisionFitOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue);
  const base = createAssetOperationBuildIdentity({
    operation: MESH_RIGGED_COLLISION_FIT_OPERATION,
    implementation: { id: PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const identity = await processorIdentity(root, processorValue);
  return createAssetOperationBuildIdentity({
    operation: MESH_RIGGED_COLLISION_FIT_OPERATION,
    implementation: identity.implementation,
    parameters: base.parameters,
    inputs: base.inputs,
  });
}

export async function executeMeshRiggedCollisionFitOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue);
  const invocation = createAssetOperationBuildIdentity({
    operation: MESH_RIGGED_COLLISION_FIT_OPERATION,
    implementation: { id: PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const source = invocation.inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseSourceDocument(sourceBytes, OPERATION_ID + " source");
  const identity = await processorIdentity(root, processorValue);
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "rigged-collision.json",
    request: {
      schemaVersion: 1,
      operation: OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: invocation.parameters,
    },
  });
  const parsedOutput = parseOutputDocument(
    result.bytes,
    OPERATION_ID + " processor output",
    parsedSource,
  );
  const observations = normalizeObservations(result.observations, parsedSource, parsedOutput);
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "collision",
    mediaType: THREE_D_RIGGED_COLLISION_MEDIA_TYPE,
    metadata: {
      collisionSchemaVersion: 1,
      operation: OPERATION_ID,
      sourceSha256: source.sha256,
      jointCount: parsedSource.jointCount,
      vertexCount: parsedSource.vertexCount,
      proxyCount: parsedOutput.proxyCount,
      capsuleAxis: "local-y",
      transformSpace: "joint-bind-local",
    },
  });
  return normalizeAssetOperationResult(MESH_RIGGED_COLLISION_FIT_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}
