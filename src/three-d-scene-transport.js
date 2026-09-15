export const THREE_D_SCENE_MEDIA_TYPE = "application/vnd.moritzbrantner.three-d.scene+json";
export const GLB_MEDIA_TYPE = "model/gltf-binary";
export const THREE_D_SCENE_COORDINATE_SYSTEM = "right-handed-y-up";
export const THREE_D_SCENE_NORMALIZED_UNIT = "meter";
export { parseCanonicalGlbBytes } from "./canonical-glb-validation.js";

const SOURCE_UNITS = new Set(["meter", "centimeter", "millimeter"]);
const UNIT_QUATERNION_TOLERANCE = 1.0e-4;

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

function nonEmptyString(value, location) {
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

function vector(value, width, location) {
  if (!Array.isArray(value) || value.length !== width) {
    throw new Error(`${location} must contain exactly ${width} finite f32 values`);
  }
  return value.map((component, index) => finiteF32(component, `${location}[${index}]`));
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalPositiveZero(value, location) {
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      throw new Error(`${location} must use positive zero in canonical output`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCanonicalPositiveZero(entry, `${location}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertCanonicalPositiveZero(entry, `${location}.${key}`);
    }
  }
}

function parseMesh(entry, index, location) {
  const meshLocation = `${location}.meshes[${index}]`;
  const mesh = assertAllowedKeys(
    entry,
    new Set(["id", "vertices", "indices", "normals", "tangents", "uvs", "colors"]),
    new Set(["id", "vertices", "indices"]),
    meshLocation,
  );
  const id = nonEmptyString(mesh.id, `${meshLocation}.id`);
  if (!Array.isArray(mesh.vertices)) throw new Error(`${meshLocation}.vertices must be an array`);
  const vertices = mesh.vertices.map((value, vertexIndex) =>
    vector(value, 3, `${meshLocation}.vertices[${vertexIndex}]`),
  );
  if (!Array.isArray(mesh.indices)) throw new Error(`${meshLocation}.indices must be an array`);
  if (mesh.indices.length % 3 !== 0) {
    throw new Error(`${meshLocation}.indices length must be divisible by three`);
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

  function attribute(name, width) {
    if (!Object.hasOwn(mesh, name)) return undefined;
    const values = mesh[name];
    if (!Array.isArray(values) || values.length !== vertices.length) {
      throw new Error(`${meshLocation}.${name} must match the vertex count`);
    }
    return values.map((value, valueIndex) =>
      vector(value, width, `${meshLocation}.${name}[${valueIndex}]`),
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

function assertCanonicalVertexCompaction(mesh, location) {
  const referenced = new Set();
  let nextFirstUse = 0;
  for (const vertexIndex of mesh.indices) {
    if (referenced.has(vertexIndex)) continue;
    if (vertexIndex !== nextFirstUse) {
      throw new Error(`${location}.indices must use canonical first-index-use vertex order`);
    }
    referenced.add(vertexIndex);
    nextFirstUse += 1;
  }
  if (referenced.size !== mesh.vertices.length) {
    throw new Error(`${location}.vertices must not contain unused vertices after normalization`);
  }
}

function parseNode(entry, index, location) {
  const nodeLocation = `${location}.nodes[${index}]`;
  const node = assertExactKeys(
    entry,
    new Set(["id", "parent", "mesh", "translation", "rotation", "scale"]),
    nodeLocation,
  );
  const id = nonEmptyString(node.id, `${nodeLocation}.id`);
  const parent = node.parent === null ? null : nonEmptyString(node.parent, `${nodeLocation}.parent`);
  const mesh = node.mesh === null ? null : nonEmptyString(node.mesh, `${nodeLocation}.mesh`);
  const translation = vector(node.translation, 3, `${nodeLocation}.translation`);
  const rotation = vector(node.rotation, 4, `${nodeLocation}.rotation`);
  if (Math.abs(Math.hypot(...rotation) - 1) > UNIT_QUATERNION_TOLERANCE) {
    throw new Error(`${nodeLocation}.rotation must be a normalized quaternion`);
  }
  const scale = vector(node.scale, 3, `${nodeLocation}.scale`);
  return { id, parent, mesh, translation, rotation, scale };
}

function canonicalNodeOrder(nodes, location) {
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
  if (order.length !== nodes.length) {
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

export function parseThreeDSceneBytes(bytes, location, { requireCanonical = false } = {}) {
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
  if (requireCanonical) assertCanonicalPositiveZero(document, location);
  if (document.schemaVersion !== 1) throw new Error(`${location}.schemaVersion must be 1`);
  if (document.coordinateSystem !== THREE_D_SCENE_COORDINATE_SYSTEM) {
    throw new Error(
      `${location}.coordinateSystem must be '${THREE_D_SCENE_COORDINATE_SYSTEM}'`,
    );
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
    if (document.unit !== THREE_D_SCENE_NORMALIZED_UNIT) {
      throw new Error(
        `${location}.unit must be '${THREE_D_SCENE_NORMALIZED_UNIT}' after normalization`,
      );
    }
    const meshOrder = meshes.map((mesh) => mesh.id);
    const sortedMeshes = [...meshOrder].sort(compareCodeUnits);
    if (meshOrder.some((id, index) => id !== sortedMeshes[index])) {
      throw new Error(`${location}.meshes must use canonical id order`);
    }
    for (const [meshIndex, mesh] of meshes.entries()) {
      assertCanonicalVertexCompaction(mesh, `${location}.meshes[${meshIndex}]`);
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
  };
}

function trueValue(value, location) {
  if (value !== true) throw new Error(`${location} must be true`);
  return true;
}

export function normalizeSceneNormalizeObservations(value, source, output) {
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
    "scene.normalize observations",
  );
  const sourceMeshCount = nonNegativeSafeInteger(
    observations.sourceMeshCount,
    "observations.sourceMeshCount",
  );
  const resultMeshCount = nonNegativeSafeInteger(
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
  if (resultVertexCount > sourceVertexCount) {
    throw new Error("scene normalization must not increase the vertex count");
  }
  if (removedUnusedVertexCount !== sourceVertexCount - resultVertexCount) {
    throw new Error("observations.removedUnusedVertexCount does not match source/result vertices");
  }
  if (triangleCount !== source.triangleCount || triangleCount !== output.triangleCount) {
    throw new Error("scene normalization triangle-count observation does not match source/output");
  }
  if (observations.sourceUnit !== source.unit) {
    throw new Error("observations.sourceUnit does not match the source scene");
  }
  if (
    observations.outputUnit !== THREE_D_SCENE_NORMALIZED_UNIT ||
    output.unit !== THREE_D_SCENE_NORMALIZED_UNIT
  ) {
    throw new Error(`scene normalization output unit must be '${THREE_D_SCENE_NORMALIZED_UNIT}'`);
  }
  if (observations.coordinateSystem !== THREE_D_SCENE_COORDINATE_SYSTEM) {
    throw new Error(
      `observations.coordinateSystem must be '${THREE_D_SCENE_COORDINATE_SYSTEM}'`,
    );
  }
  trueValue(observations.canonicalOrder, "observations.canonicalOrder");
  trueValue(observations.canonicalQuaternionSign, "observations.canonicalQuaternionSign");
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
    outputUnit: THREE_D_SCENE_NORMALIZED_UNIT,
    coordinateSystem: THREE_D_SCENE_COORDINATE_SYSTEM,
    canonicalOrder: true,
    canonicalQuaternionSign: true,
  };
}

export function normalizeSceneExportObservations(value, source, glb, byteLength) {
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
    "scene.export.glb observations",
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
  if (observations.coordinateSystem !== THREE_D_SCENE_COORDINATE_SYSTEM) {
    throw new Error(
      `observations.coordinateSystem must be '${THREE_D_SCENE_COORDINATE_SYSTEM}'`,
    );
  }
  if (observations.unit !== THREE_D_SCENE_NORMALIZED_UNIT) {
    throw new Error(`observations.unit must be '${THREE_D_SCENE_NORMALIZED_UNIT}'`);
  }
  if (observations.format !== "glb-2.0") throw new Error("observations.format must be 'glb-2.0'");
  trueValue(observations.normalizedBeforeExport, "observations.normalizedBeforeExport");
  if (observedByteLength !== byteLength) {
    throw new Error("observations.byteLength does not match emitted GLB bytes");
  }
  return {
    meshCount,
    nodeCount,
    rootNodeCount,
    vertexCount,
    triangleCount,
    coordinateSystem: THREE_D_SCENE_COORDINATE_SYSTEM,
    unit: THREE_D_SCENE_NORMALIZED_UNIT,
    format: "glb-2.0",
    normalizedBeforeExport: true,
    byteLength: observedByteLength,
  };
}
