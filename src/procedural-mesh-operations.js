import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  generateBoxObj,
  generateHeightfieldObj,
  generatePlaneObj,
  PROCEDURAL_HEIGHTFIELD_MAX_DIMENSION,
} from "./procedural-mesh.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_SIZE = 1_000_000;
const meshOutput = {
  id: "output",
  label: "Generated mesh",
  assetKinds: ["mesh"],
  mediaTypes: ["model/obj"],
};
const heightInput = {
  id: "source",
  label: "Height source",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "mesh.procedural.box",
    version: VERSION,
    label: "Generate box mesh",
    description: "Generate a deterministic centered right-handed Y-up triangular OBJ box from exact integer dimensions.",
    category: "procedural.mesh",
    inputs: [],
    outputs: [meshOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height", "depth"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX_SIZE },
        height: { type: "integer", minimum: 1, maximum: MAX_SIZE },
        depth: { type: "integer", minimum: 1, maximum: MAX_SIZE },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "mesh.procedural.plane",
    version: VERSION,
    label: "Generate plane mesh",
    description: "Generate a deterministic centered right-handed Y-up triangular OBJ plane in the XZ plane.",
    category: "procedural.mesh",
    inputs: [],
    outputs: [meshOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["width", "depth"],
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX_SIZE },
        depth: { type: "integer", minimum: 1, maximum: MAX_SIZE },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "mesh.heightfield.from-image",
    version: VERSION,
    label: "Generate mesh from height field",
    description:
      "Convert canonical RGBA8 Q8 Rec.709 luma into a deterministic centered triangular OBJ height field using integer rounding.",
    category: "procedural.mesh",
    inputs: [heightInput],
    outputs: [meshOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cellSize", "heightScale"],
      properties: {
        cellSize: { type: "integer", minimum: 1, maximum: MAX_SIZE },
        heightScale: { type: "integer", minimum: 0, maximum: MAX_SIZE },
      },
    },
  },
]);

export const PROCEDURAL_BOX_MESH_OPERATION = OPERATION_REGISTRY.get("mesh.procedural.box", VERSION);
export const PROCEDURAL_PLANE_MESH_OPERATION = OPERATION_REGISTRY.get("mesh.procedural.plane", VERSION);
export const HEIGHTFIELD_MESH_OPERATION = OPERATION_REGISTRY.get("mesh.heightfield.from-image", VERSION);
export const PROCEDURAL_MESH_OPERATIONS = OPERATION_REGISTRY.list();

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, location) {
  const object = plainObject(value, location);
  const expected = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return object;
}

function integer(value, location, minimum, maximum = MAX_SIZE) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function normalizeParameters(operation, value) {
  if (operation.id === "mesh.procedural.box") {
    const parameters = exactKeys(value, ["width", "height", "depth"], `${operation.id} parameters`);
    return {
      width: integer(parameters.width, "parameters.width", 1),
      height: integer(parameters.height, "parameters.height", 1),
      depth: integer(parameters.depth, "parameters.depth", 1),
    };
  }
  if (operation.id === "mesh.procedural.plane") {
    const parameters = exactKeys(value, ["width", "depth"], `${operation.id} parameters`);
    return {
      width: integer(parameters.width, "parameters.width", 1),
      depth: integer(parameters.depth, "parameters.depth", 1),
    };
  }
  if (operation.id === "mesh.heightfield.from-image") {
    const parameters = exactKeys(value, ["cellSize", "heightScale"], `${operation.id} parameters`);
    return {
      cellSize: integer(parameters.cellSize, "parameters.cellSize", 1),
      heightScale: integer(parameters.heightScale, "parameters.heightScale", 0),
    };
  }
  throw new Error(`unsupported procedural mesh operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("procedural mesh operation root must be an absolute path");
  }
  return root;
}

function algorithm(operation) {
  const algorithms = {
    "mesh.procedural.box": "canonical-triangular-obj-box-half-unit-v1",
    "mesh.procedural.plane": "canonical-triangular-obj-plane-half-unit-v1",
    "mesh.heightfield.from-image": "q8-rec709-integer-heightfield-obj-v1",
  };
  return algorithms[operation.id];
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    randomness: "none",
    meshFormat: "obj",
    coordinateSystem: "right-handed-y-up",
    tool: await captureToolIdentity(),
  };
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  const assetRoot = assertRoot(root);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizeParameters(operation, parameters),
    inputs,
  });
  if (operation.id === "mesh.heightfield.from-image") {
    const source = parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source));
    if (source.width < 2 || source.height < 2) {
      throw new Error("heightfield source dimensions must both be at least 2");
    }
    if (source.width > PROCEDURAL_HEIGHTFIELD_MAX_DIMENSION || source.height > PROCEDURAL_HEIGHTFIELD_MAX_DIMENSION) {
      throw new Error(
        `heightfield source dimensions must not exceed ${PROCEDURAL_HEIGHTFIELD_MAX_DIMENSION}x${PROCEDURAL_HEIGHTFIELD_MAX_DIMENSION}`,
      );
    }
  }
  return build;
}

function generate(operation, parameters, source) {
  if (operation.id === "mesh.procedural.box") return generateBoxObj(parameters);
  if (operation.id === "mesh.procedural.plane") return generatePlaneObj(parameters);
  if (operation.id === "mesh.heightfield.from-image") return generateHeightfieldObj(source, parameters);
  throw new Error(`unsupported procedural mesh operation '${operation.id}'`);
}

async function execute(root, operation, build) {
  const assetRoot = assertRoot(root);
  const source =
    operation.id === "mesh.heightfield.from-image"
      ? parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.source))
      : undefined;
  const generated = generate(operation, build.parameters, source);
  const stored = await storeAssetObject(assetRoot, {
    bytes: generated.bytes,
    kind: "mesh",
    mediaType: "model/obj",
    metadata: {
      meshFormat: "obj",
      topology: "triangles",
      coordinateSystem: "right-handed-y-up",
      vertexCount: generated.vertexCount,
      triangleCount: generated.triangleCount,
      generator: `${operation.id}@${operation.version}`,
      ...(operation.id === "mesh.heightfield.from-image"
        ? {
            sourceSha256: build.inputs.source.sha256,
            heightEncoding: "q8-rec709-luma",
            maxSourceDimension: PROCEDURAL_HEIGHTFIELD_MAX_DIMENSION,
          }
        : {}),
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      vertexCount: generated.vertexCount,
      triangleCount: generated.triangleCount,
      algorithm: build.implementation.algorithm,
      randomness: "none",
      parameters: build.parameters,
    },
  });
}

export async function createProceduralBoxMeshOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_BOX_MESH_OPERATION, parameters, inputs);
}

export async function executeProceduralBoxMeshOperation(root, invocation = {}) {
  const build = await createProceduralBoxMeshOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_BOX_MESH_OPERATION, build);
}

export async function createProceduralPlaneMeshOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_PLANE_MESH_OPERATION, parameters, inputs);
}

export async function executeProceduralPlaneMeshOperation(root, invocation = {}) {
  const build = await createProceduralPlaneMeshOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_PLANE_MESH_OPERATION, build);
}

export async function createHeightfieldMeshOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, HEIGHTFIELD_MESH_OPERATION, parameters, inputs);
}

export async function executeHeightfieldMeshOperation(root, invocation = {}) {
  const build = await createHeightfieldMeshOperationBuildIdentity(root, invocation);
  return execute(root, HEIGHTFIELD_MESH_OPERATION, build);
}
