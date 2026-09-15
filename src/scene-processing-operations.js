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

export const THREE_D_SCENE_MEDIA_TYPE = "application/vnd.moritzbrantner.three-d.scene+json";
export const GLB_MEDIA_TYPE = "model/gltf-binary";

const NORMALIZE_OPERATION_ID = "scene.normalize";
const EXPORT_OPERATION_ID = "scene.export.glb";
const OPERATION_VERSION = "1";
const NORMALIZE_PROCESSOR_ID = "three-d-scene-normalize";
const EXPORT_PROCESSOR_ID = "three-d-scene-export-glb";
const PROCESSOR_PROTOCOL = "asset-tooling-process-adapter-v1";
const NORMALIZE_PROCESSOR_CODEC = "three-d-scene-json-v1";
const EXPORT_PROCESSOR_CODEC = "gltf-binary-v2";
const COORDINATE_SYSTEM = "right-handed-y-up";
const NORMALIZED_UNIT = "meter";
const SOURCE_UNITS = new Set(["meter", "centimeter", "millimeter"]);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UNIT_QUATERNION_TOLERANCE = 1.0e-4;
const GLB_JSON_CHUNK = 0x4e4f534a;

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: NORMALIZE_OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Normalize 3D scene",
    description:
      "Normalize renderer-neutral scene hierarchy, mesh indexing, stable ordering, quaternion representation, and supported source units through the authoritative 3d-lab scene contract.",
    category: "scene.processing",
    inputs: [
      {
        id: "source",
        label: "Source scene",
        assetKinds: ["scene"],
        mediaTypes: [THREE_D_SCENE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Normalized scene",
        assetKinds: ["scene"],
        mediaTypes: [THREE_D_SCENE_MEDIA_TYPE],
      },
    ],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: EXPORT_OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Export canonical GLB",
    description:
      "Normalize a renderer-neutral scene and serialize deterministic GLB 2.0 bytes through the authoritative 3d-lab export contract.",
    category: "scene.export",
    inputs: [
      {
        id: "source",
        label: "Source scene",
        assetKinds: ["scene"],
        mediaTypes: [THREE_D_SCENE_MEDIA_TYPE],
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Canonical GLB",
        assetKinds: ["scene"],
        mediaTypes: [GLB_MEDIA_TYPE],
      },
    ],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
]);

export const SCENE_NORMALIZE_OPERATION = OPERATION_REGISTRY.get(
  NORMALIZE_OPERATION_ID,
  OPERATION_VERSION,
);
export const SCENE_EXPORT_GLB_OPERATION = OPERATION_REGISTRY.get(
  EXPORT_OPERATION_ID,
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

function assertAllowedKeys(value, allowed, required, location) {
  const object = assertPlainObject(value, location);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of required) {
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

function finiteF32(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${location} must be a finite number`);
  }
  const normalized = Math.fround(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${location} must be representable as a finite f32`);
  }
  return Object.is(normalized, -0) ? 0 : normalized;
}

function nonNegativeSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} must be a non-negative safe integer`);
  }
  return value;
}

function vec(value, width, location) {
  if (!Array.isArray(value) || value.length !== width) {
    throw new Error(`${location} must contain exactly ${width} finite f32 values`);
  }
  return value.map((component, index) => finiteF32(component, `${location}[${index}]`));
}

function normalizeParameters(value, operationId) {
  assertExactKeys(value, new Set(), `${operationId} parameters`);
  return {};
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
  if (
    /^cargo(?:\.exe)?$/i.test(path.basename(executable)) &&
    !prefixArguments.includes("--offline") &&
    !prefixArguments.includes("--frozen")
  ) {
    throw new Error(`${operationId} cargo processor must run with --offline or --frozen`);
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
    const unexpectedStatus = status
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && line !== "?? Cargo.lock");
    if (unexpectedStatus.length > 0) {
      throw new Error(`${operationId} processor checkout must be source-clean at the declared revision`);
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
      throw new Error(
        `${operationId} processor source file '${sourceFile}' could not be read: ${error.message}`,
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

function normalizeProbe(components, { operationId, processorId, codec }) {
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
  if (component.codec !== codec) {
    throw new Error(`processor probe codec must be '${codec}'`);
  }
  assertPlainObject(component.dependencies, "processor probe dependencies");
  assertNonEmptyString(component.cargoLock, "processor probe cargoLock");
  return component;
}

async function processorIdentity(root, processorValue, identity) {
  const { operationId, processorId, codec } = identity;
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(`${operationId} root must be an absolute path`);
  }
  const processor = normalizeProcessor(processorValue, operationId);
  const source = await verifyProcessorSource(processor, root, operationId);
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
  const probe = normalizeProbe(components, { operationId, processorId, codec });
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

function parseMesh(entry, index, location) {
  const meshLocation = `${location}.meshes[${index}]`;
  const mesh = assertAllowedKeys(
    entry,
    new Set(["id", "vertices", "indices", "normals", "tangents", "uvs", "colors"]),
    new Set(["id", "vertices", "indices"]),
    meshLocation,
  );
  const id = assertNonEmptyString(mesh.id, `${meshLocation}.id`);
  if (!Array.isArray(mesh.vertices)) throw new Error(`${meshLocation}.vertices must be an array`);
  const vertices = mesh.vertices.map((value, vertexIndex) =>
    vec(value, 3, `${meshLocation}.vertices[${vertexIndex}]`),
  );
  if (!Array.isArray(mesh.indices) || !mesh.indices.length % 3 === 0) {
    throw new Error(`${meshLocation}.indices must be an array with a triangle index count`);
  }
  const indices = mesh.indices.map((value, indexIndex) => {
    const normalized = nonNegativeSafeInteger(value, `${meshLocation}.indices[${indexIndex}]`);
    if (normalized > 0xffffffff) {
      throw new Error(`${meshLocation}.indices[${indexIndex}] must fit u32`);
    }
    if (normalized >= vertices.length) {
      throw new Error(`${meshLocation}.indices[${indexIndex}] references a missing vertex`);
    }
    return normalized;
  });
  if (indices.length % 3 !== 0) {
    throw new Error(`${meshLocation}.indices length must be divisible by three`);
  }

  function attribute(name, width) {
    if (!Object.hasOwn(mesh, name)) return undefined;
    const values = mesh[name];
    if (!Array.isArray(values) || values.length !== vertices.length) {
      throw new Error(`${meshLocation}.${name} must match the vertex count`);
    }
    return values.map((value, valueIndex) =>
      vec(value, width, `${meshLocation}.${name}[${valueIndex}]`),
    );
  }

  return {
    id,
    vertices,
    indices,
    normals: attribute("normals", 3),
    tangents: attribute("tangents", 4),
    uvs: attribute("uvs", 2),
    colors: attribute("colors", 3),
    triangleCount: indices.length / 3,
  };
}

function parseNode(entry, index, location) {
  const nodeLocation = `${location}.nodes[${index}]`;
  const node = assertExactKeys(
    entry,
    new Set(["id", "parent", "mesh", "translation", "rotation", "scale"]),
    nodeLocation,
  );
  const id = assertNonEmptyString(node.id, `${nodeLocation}.id`);
  const parent = node.parent === null ? null : assertNonEmptyString(node.parent, `${nodeLocation}.parent`);
  const mesh = node.mesh === null ? null : assertNonEmptyString(node.mesh, `${nodeLocation}.mesh`);
  const translation = vec(node.translation, 3, `${nodeLocation}.translation`);
  const rotation = vec(node.rotation, 4, `${nodeLocation}.rotation`);
  const rotationLength = Math.hypot(...rotation);
  if (Math.abs(rotationLength - 1) > UNIT_QUATERNION_TOLERANCE) {
    throw new Error(`${nodeLocation}.rotation must be a normalized quaternion`);
  }
  const scale = vec(node.scale, 3, `${nodeLocation}.scale`);
  return { id, parent, mesh, translation, rotation, scale };
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalNodeOrder(nodes, location) {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const children = new Map(nodes.map((node) => [node.id, []]));
  const roots = [];
  for (const node of nodes) {
    if (node.parent === null) roots.push(node.id);
    else children.get(node.parent).push(node.id);
  }
  roots.sort(compareCodeUnits);
  for (const entries of children.values()) entries.sort(compareCodeUnits);
  const order = [];
  const visiting = new Set();
  const visited = new Set();
  function append(id) {
    if (visiting.has(id)) throw new Error(`${location} node hierarchy contains a cycle`);
    if (visited.has(id)) return;
    visiting.add(id);
    order.push(id);
    for (const child of children.get(id)) append(child);
    visiting.delete(id);
    visited.add(id);
  }
  for (const root of roots) append(root);
  if (order.length !== nodes.length || indexById.size !== nodes.length) {
    throw new Error(`${location} node hierarchy contains a cycle or disconnected parent chain`);
  }
  return order;
}

function quaternionHasCanonicalSign([x, y, z, w]) {
  if (w > 0) return true;
  if (w < 0) return false;
  if (x > 0) return true;
  if (x < 0) return false;
  if (y > 0) return true;
  if (y < 0) return false;
  return z >= 0;
}

function parseSceneDocument(bytes, location, { requireCanonical = false } = {}) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${location} is not valid JSON: ${error.message}`);
  }
  const document = assertExactKeys(
    value,
    new Set(["schemaVersion", "coordinateSystem", "unit", "meshes", "nodes"]),
    location,
  );
  if (document.schemaVersion !== 1) throw new Error(`${location}.schemaVersion must be 1`);
  if (document.coordinateSystem !== COORDINATE_SYSTEM) {
    throw new Error(`${location}.coordinateSystem must be '${COORDINATE_SYSTEM}'`);
  }
  if (!SOURCE_UNITS.has(document.unit)) {
    throw new Error(`${location}.unit must be meter, centimeter, or millimeter`);
  }
  if (!Array.isArray(document.meshes)) throw new Error(`${location}.meshes must be an array`);
  if (!Array.isArray(document.nodes) || document.nodes.length === 0) {
    throw new Error(`${location}.nodes must be a non-empty array`);
  }

  const meshes = document.meshes.map((mesh, index) => parseMesh(mesh, index, location));
  const meshIds = new Set();
  let vertexCount = 0;
  let triangleCount = 0;
  for (const mesh of meshes) {
    if (meshIds.has(mesh.id)) throw new Error(`${location} contains duplicate mesh id '${mesh.id}'`);
    meshIds.add(mesh.id);
    vertexCount += mesh.vertices.length;
    triangleCount += mesh.triangleCount;
  }

  const nodes = document.nodes.map((node, index) => parseNode(node, index, location));
  const nodeIds = new Set();
  let rootNodeCount = 0;
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`${location} contains duplicate node id '${node.id}'`);
    nodeIds.add(node.id);
    if (node.parent === null) rootNodeCount += 1;
  }
  for (const node of nodes) {
    if (node.parent !== null && !nodeIds.has(node.parent)) {
      throw new Error(`${location} node '${node.id}' references unknown parent '${node.parent}'`);
    }
    if (node.mesh !== null && !meshIds.has(node.mesh)) {
      throw new Error(`${location} node '${node.id}' references unknown mesh '${node.mesh}'`);
    }
  }
  const canonicalOrder = canonicalNodeOrder(nodes, location);

  if (requireCanonical) {
    if (document.unit !== NORMALIZED_UNIT) {
      throw new Error(`${location}.unit must be '${NORMALIZED_UNIT}' after normalization`);
    }
    const meshOrder = meshes.map((mesh) => mesh.id);
    const sortedMeshes = [...meshOrder].sort(compareCodeUnits);
    if (meshOrder.some((id, index) => id !== sortedMeshes[index])) {
      throw new Error(`${location}.meshes must use canonical id order`);
    }
    const nodeOrder = nodes.map((node) => node.id);
    if (nodeOrder.some((id, index) => id !== canonicalOrder[index])) {
      throw new Error(`${location}.nodes must use canonical parent-before-child id order`);
    }
    for (const node of nodes) {
      if (!quaternionHasCanonicalSign(node.rotation)) {
        throw new Error(`${location} node '${node.id}' quaternion sign is not canonical`);
      }
    }
  }

  return {
    coordinateSystem: document.coordinateSystem,
    unit: document.unit,
    meshes,
    nodes,
    meshCount: meshes.length,
    nodeCount: nodes.length,
    rootNodeCount,
    vertexCount,
    triangleCount,
    canonicalOrder,
  };
}

function assertTrue(value, location) {
  if (value !== true) throw new Error(`${location} must be true`);
  return true;
}

function positiveOrZeroSafeInteger(value, location) {
  return nonNegativeSafeInteger(value, location);
}

function normalizeNormalizeObservations(value, source, output) {
  const observations = assertExactKeys(
    value,
    new Set([
      "sourceMeshCount",
      "resultMeshCount",
      "nodeCount",
      "rootNodeCount",
      "sourceVertexCount",
      "resultVertexCount",
      "removedUnusedVertexCount",
      "triangleCount",
      "sourceUnit",
      "outputUnit",
      "coordinateSystem",
      "canonicalOrder",
      "canonicalQuaternionSign",
    ]),
    `${NORMALIZE_OPERATION_ID} observations`,
  );
  const sourceMeshCount = positiveOrZeroSafeInteger(
    observations.sourceMeshCount,
    "observations.sourceMeshCount",
  );
  const resultMeshCount = positiveOrZeroSafeInteger(
    observations.resultMeshCount,
    "observations.resultMeshCount",
  );
  const nodeCount = nonNegativeSafeInteger(observations.nodeCount, "observations.nodeCount");
  const rootNodeCount = nonNegativeSafeInteger(
    observations.rootNodeCount,
    "observations.rootNodeCount",
  );
  const sourceVertexCount = nonNegativeSafeInteger(
    observations.sourceVertexCount,
    "observations.sourceVertexCount",
  );
  const resultVertexCount = nonNegativeSafeInteger(
    observations.resultVertexCount,
    "observations.resultVertexCount",
  );
  const removedUnusedVertexCount = nonNegativeSafeInteger(
    observations.removedUnusedVertexCount,
    "observations.removedUnusedVertexCount",
  );
  const triangleCount = nonNegativeSafeInteger(
    observations.triangleCount,
    "observations.triangleCount",
  );
  if (sourceMeshCount !== source.meshCount || resultMeshCount !== output.meshCount) {
    throw new Error("scene normalization mesh-count observations do not match source/output");
  }
  if (nodeCount !== source.nodeCount || nodeCount !== output.nodeCount) {
    throw new Error("scene normalization node-count observation does not match source/output");
  }
  if (rootNodeCount !== source.rootNodeCount || rootNodeCount !== output.rootNodeCount) {
    throw new Error("scene normalization root-node observation does not match source/output");
  }
  if (sourceVertexCount !== source.vertexCount || resultVertexCount !== output.vertexCount) {
    throw new Error("scene normalization vertex-count observations do not match source/output");
  }
  if (removedUnusedVertexCount !== sourceVertexCount - resultVertexCount) {
    throw new Error("observations.removedUnusedVertexCount does not match source/result vertices");
  }
  if (resultVertexCount > sourceVertexCount) {
    throw new Error("scene normalization must not increase the vertex count");
  }
  if (triangleCount !== source.triangleCount || triangleCount !== output.triangleCount) {
    throw new Error("scene normalization triangle-count observation does not match source/output");
  }
  if (observations.sourceUnit !== source.unit) {
    throw new Error("observations.sourceUnit does not match the source scene");
  }
  if (observations.outputUnit !== NORMALIZED_UNIT || output.unit !== NORMALIZED_UNIT) {
    throw new Error(`scene normalization output unit must be '${NORMALIZED_UNIT}'`);
  }
  if (observations.coordinateSystem !== COORDINATE_SYSTEM) {
    throw new Error(`observations.coordinateSystem must be '${COORDINATE_SYSTEM}'`);
  }
  assertTrue(observations.canonicalOrder, "observations.canonicalOrder");
  assertTrue(observations.canonicalQuaternionSign, "observations.canonicalQuaternionSign");
  return {
    sourceMeshCount,
    resultMeshCount,
    nodeCount,
    rootNodeCount,
    sourceVertexCount,
    resultVertexCount,
    removedUnusedVertexCount,
    triangleCount,
    sourceUnit: source.unit,
    outputUnit: NORMALIZED_UNIT,
    coordinateSystem: COORDINATE_SYSTEM,
    canonicalOrder: true,
    canonicalQuaternionSign: true,
  };
}

function parseGlb(bytes, location) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) {
    throw new Error(`${location} must be a GLB 2.0 byte sequence`);
  }
  if (bytes.toString("ascii", 0, 4) !== "glTF") throw new Error(`${location} has invalid GLB magic`);
  if (bytes.readUInt32LE(4) !== 2) throw new Error(`${location} GLB version must be 2`);
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${location} GLB declared byte length does not match output bytes`);
  }
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== GLB_JSON_CHUNK) throw new Error(`${location} first GLB chunk must be JSON`);
  const jsonEnd = 20 + jsonLength;
  if (jsonEnd > bytes.length) throw new Error(`${location} JSON chunk exceeds GLB bytes`);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8", 20, jsonEnd).trimEnd());
  } catch (error) {
    throw new Error(`${location} contains invalid GLB JSON: ${error.message}`);
  }
  if (!isPlainObject(document) || document.asset?.version !== "2.0") {
    throw new Error(`${location} GLB JSON must declare glTF 2.0`);
  }
  if (!Array.isArray(document.meshes) || !Array.isArray(document.nodes)) {
    throw new Error(`${location} GLB JSON must contain mesh and node arrays`);
  }
  if (!Array.isArray(document.accessors)) {
    throw new Error(`${location} GLB JSON must contain accessors`);
  }
  const sceneIndex = document.scene;
  if (!Number.isInteger(sceneIndex) || !Array.isArray(document.scenes) || !document.scenes[sceneIndex]) {
    throw new Error(`${location} GLB JSON must select a valid scene`);
  }
  const roots = document.scenes[sceneIndex].nodes;
  if (!Array.isArray(roots)) throw new Error(`${location} selected GLB scene must contain root nodes`);

  let vertexCount = 0;
  let triangleCount = 0;
  for (const [meshIndex, mesh] of document.meshes.entries()) {
    if (!isPlainObject(mesh) || !Array.isArray(mesh.primitives) || mesh.primitives.length !== 1) {
      throw new Error(`${location} mesh ${meshIndex} must contain exactly one canonical primitive`);
    }
    const primitive = mesh.primitives[0];
    const positionAccessor = primitive?.attributes?.POSITION;
    const indexAccessor = primitive?.indices;
    if (!Number.isInteger(positionAccessor) || !document.accessors[positionAccessor]) {
      throw new Error(`${location} mesh ${meshIndex} has no valid POSITION accessor`);
    }
    if (!Number.isInteger(indexAccessor) || !document.accessors[indexAccessor]) {
      throw new Error(`${location} mesh ${meshIndex} has no valid index accessor`);
    }
    const positions = document.accessors[positionAccessor];
    const indices = document.accessors[indexAccessor];
    const positionsCount = nonNegativeSafeInteger(
      positions.count,
      `${location}.accessors[${positionAccessor}].count`,
    );
    const indexCount = nonNegativeSafeInteger(
      indices.count,
      `${location}.accessors[${indexAccessor}].count`,
    );
    if (indexCount % 3 !== 0) throw new Error(`${location} mesh ${meshIndex} index count is not triangular`);
    vertexCount += positionsCount;
    triangleCount += indexCount / 3;
  }
  return {
    meshCount: document.meshes.length,
    nodeCount: document.nodes.length,
    rootNodeCount: roots.length,
    vertexCount,
    triangleCount,
  };
}

function normalizeExportObservations(value, source, glb, byteLength) {
  const observations = assertExactKeys(
    value,
    new Set([
      "meshCount",
      "nodeCount",
      "rootNodeCount",
      "vertexCount",
      "triangleCount",
      "coordinateSystem",
      "unit",
      "format",
      "normalizedBeforeExport",
      "byteLength",
    ]),
    `${EXPORT_OPERATION_ID} observations`,
  );
  const meshCount = nonNegativeSafeInteger(observations.meshCount, "observations.meshCount");
  const nodeCount = nonNegativeSafeInteger(observations.nodeCount, "observations.nodeCount");
  const rootNodeCount = nonNegativeSafeInteger(
    observations.rootNodeCount,
    "observations.rootNodeCount",
  );
  const vertexCount = nonNegativeSafeInteger(observations.vertexCount, "observations.vertexCount");
  const triangleCount = nonNegativeSafeInteger(
    observations.triangleCount,
    "observations.triangleCount",
  );
  const observedByteLength = nonNegativeSafeInteger(
    observations.byteLength,
    "observations.byteLength",
  );
  if (meshCount !== source.meshCount || meshCount !== glb.meshCount) {
    throw new Error("scene export mesh-count observation does not match source/GLB");
  }
  if (nodeCount !== source.nodeCount || nodeCount !== glb.nodeCount) {
    throw new Error("scene export node-count observation does not match source/GLB");
  }
  if (rootNodeCount !== source.rootNodeCount || rootNodeCount !== glb.rootNodeCount) {
    throw new Error("scene export root-node observation does not match source/GLB");
  }
  if (vertexCount !== glb.vertexCount || vertexCount > source.vertexCount) {
    throw new Error("scene export vertex-count observation does not match normalized GLB geometry");
  }
  if (triangleCount !== source.triangleCount || triangleCount !== glb.triangleCount) {
    throw new Error("scene export triangle-count observation does not match source/GLB");
  }
  if (observations.coordinateSystem !== COORDINATE_SYSTEM) {
    throw new Error(`observations.coordinateSystem must be '${COORDINATE_SYSTEM}'`);
  }
  if (observations.unit !== NORMALIZED_UNIT) {
    throw new Error(`observations.unit must be '${NORMALIZED_UNIT}'`);
  }
  if (observations.format !== "glb-2.0") throw new Error("observations.format must be 'glb-2.0'");
  assertTrue(observations.normalizedBeforeExport, "observations.normalizedBeforeExport");
  if (observedByteLength !== byteLength) {
    throw new Error("observations.byteLength does not match emitted GLB bytes");
  }
  return {
    meshCount,
    nodeCount,
    rootNodeCount,
    vertexCount,
    triangleCount,
    coordinateSystem: COORDINATE_SYSTEM,
    unit: NORMALIZED_UNIT,
    format: "glb-2.0",
    normalizedBeforeExport: true,
    byteLength: observedByteLength,
  };
}

async function createBuildIdentity(root, operation, parameters, inputs, processorValue, identity) {
  const base = createAssetOperationBuildIdentity({
    operation,
    implementation: { id: identity.processorId, version: "unprobed" },
    parameters,
    inputs,
  });
  const processor = await processorIdentity(root, processorValue, identity);
  return createAssetOperationBuildIdentity({
    operation,
    implementation: processor.implementation,
    parameters: base.parameters,
    inputs: base.inputs,
  });
}

const NORMALIZE_PROCESSOR = {
  operationId: NORMALIZE_OPERATION_ID,
  processorId: NORMALIZE_PROCESSOR_ID,
  codec: NORMALIZE_PROCESSOR_CODEC,
};
const EXPORT_PROCESSOR = {
  operationId: EXPORT_OPERATION_ID,
  processorId: EXPORT_PROCESSOR_ID,
  codec: EXPORT_PROCESSOR_CODEC,
};

export async function createSceneNormalizeOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  return createBuildIdentity(
    root,
    SCENE_NORMALIZE_OPERATION,
    normalizeParameters(parameterValue, NORMALIZE_OPERATION_ID),
    inputs,
    processorValue,
    NORMALIZE_PROCESSOR,
  );
}

export async function executeSceneNormalizeOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue, NORMALIZE_OPERATION_ID);
  const invocation = createAssetOperationBuildIdentity({
    operation: SCENE_NORMALIZE_OPERATION,
    implementation: { id: NORMALIZE_PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const source = invocation.inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseSceneDocument(sourceBytes, `${NORMALIZE_OPERATION_ID} source`);
  const identity = await processorIdentity(root, processorValue, NORMALIZE_PROCESSOR);
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "scene.json",
    request: {
      schemaVersion: 1,
      operation: NORMALIZE_OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: invocation.parameters,
    },
  });
  const parsedOutput = parseSceneDocument(
    result.bytes,
    `${NORMALIZE_OPERATION_ID} processor output`,
    { requireCanonical: true },
  );
  const observations = normalizeNormalizeObservations(
    result.observations,
    parsedSource,
    parsedOutput,
  );
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "scene",
    mediaType: THREE_D_SCENE_MEDIA_TYPE,
    metadata: {
      sceneSchemaVersion: 1,
      coordinateSystem: COORDINATE_SYSTEM,
      unit: NORMALIZED_UNIT,
      meshCount: parsedOutput.meshCount,
      nodeCount: parsedOutput.nodeCount,
      vertexCount: parsedOutput.vertexCount,
      triangleCount: parsedOutput.triangleCount,
      operation: NORMALIZE_OPERATION_ID,
      sourceSha256: source.sha256,
    },
  });
  return normalizeAssetOperationResult(SCENE_NORMALIZE_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}

export async function createSceneExportGlbOperationBuildIdentity(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  return createBuildIdentity(
    root,
    SCENE_EXPORT_GLB_OPERATION,
    normalizeParameters(parameterValue, EXPORT_OPERATION_ID),
    inputs,
    processorValue,
    EXPORT_PROCESSOR,
  );
}

export async function executeSceneExportGlbOperation(
  root,
  { parameters: parameterValue = {}, inputs = {} } = {},
  processorValue,
) {
  const parameters = normalizeParameters(parameterValue, EXPORT_OPERATION_ID);
  const invocation = createAssetOperationBuildIdentity({
    operation: SCENE_EXPORT_GLB_OPERATION,
    implementation: { id: EXPORT_PROCESSOR_ID, version: "unprobed" },
    parameters,
    inputs,
  });
  const source = invocation.inputs.source;
  const sourceBytes = await resolveAssetObject(root, source);
  const parsedSource = parseSceneDocument(sourceBytes, `${EXPORT_OPERATION_ID} source`);
  const identity = await processorIdentity(root, processorValue, EXPORT_PROCESSOR);
  const result = await runProcessAdapter({
    executable: identity.processor.executable,
    scriptPath: identity.processor.scriptPath,
    prefixArguments: identity.processor.prefixArguments,
    cwd: root,
    environment: identity.environment,
    outputName: "scene.glb",
    request: {
      schemaVersion: 1,
      operation: EXPORT_OPERATION_ID,
      inputPath: assetObjectPortablePath(source),
      parameters: invocation.parameters,
    },
  });
  const parsedGlb = parseGlb(result.bytes, `${EXPORT_OPERATION_ID} processor output`);
  const observations = normalizeExportObservations(
    result.observations,
    parsedSource,
    parsedGlb,
    result.bytes.length,
  );
  const stored = await storeAssetObject(root, {
    bytes: result.bytes,
    kind: "scene",
    mediaType: GLB_MEDIA_TYPE,
    metadata: {
      format: "glb-2.0",
      coordinateSystem: COORDINATE_SYSTEM,
      unit: NORMALIZED_UNIT,
      meshCount: parsedGlb.meshCount,
      nodeCount: parsedGlb.nodeCount,
      vertexCount: parsedGlb.vertexCount,
      triangleCount: parsedGlb.triangleCount,
      operation: EXPORT_OPERATION_ID,
      sourceSha256: source.sha256,
    },
  });
  return normalizeAssetOperationResult(SCENE_EXPORT_GLB_OPERATION, {
    outputs: { output: stored.asset },
    observations,
  });
}
