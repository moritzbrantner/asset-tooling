import path from "node:path";
import { storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { PROCEDURAL_RADIAL_SEGMENTS } from "./procedural-mesh.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_SIZE = 1_000_000;
const MICRO_SCALE = 1_000_000n;
const CIRCLE_SAMPLE_COUNT = 128;
const QUARTER_SINE_MICRO = Object.freeze([
  0, 49068, 98017, 146730, 195090, 242980, 290285, 336890, 382683, 427555, 471397,
  514103, 555570, 595699, 634393, 671559, 707107, 740951, 773010, 803208, 831470,
  857729, 881921, 903989, 923880, 941544, 956940, 970031, 980785, 989177, 995185,
  998795, 1000000,
]);

const meshOutput = {
  id: "output",
  label: "Generated parametric mesh",
  assetKinds: ["mesh"],
  mediaTypes: ["model/obj"],
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "mesh.procedural.torus",
    version: VERSION,
    label: "Generate torus mesh",
    description:
      "Generate a deterministic right-handed Y-up triangular OBJ torus from a fixed millionth-unit two-angle parameterization.",
    category: "procedural.mesh",
    inputs: [],
    outputs: [meshOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["majorRadius", "minorRadius", "majorSegments", "minorSegments"],
      properties: {
        majorRadius: { type: "integer", minimum: 2, maximum: MAX_SIZE },
        minorRadius: { type: "integer", minimum: 1, maximum: MAX_SIZE - 1 },
        majorSegments: { type: "integer", enum: [...PROCEDURAL_RADIAL_SEGMENTS] },
        minorSegments: { type: "integer", enum: [...PROCEDURAL_RADIAL_SEGMENTS] },
      },
    },
  },
]);

export const PROCEDURAL_TORUS_OPERATION = OPERATION_REGISTRY.get("mesh.procedural.torus", VERSION);
export const PARAMETRIC_SURFACE_OPERATIONS = OPERATION_REGISTRY.list();

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

function oneOfIntegers(value, location, allowed) {
  integer(value, location, allowed[0], allowed.at(-1));
  if (!allowed.includes(value)) {
    throw new Error(`${location} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function sineMicro(index) {
  const normalized = ((index % CIRCLE_SAMPLE_COUNT) + CIRCLE_SAMPLE_COUNT) % CIRCLE_SAMPLE_COUNT;
  const quadrant = Math.floor(normalized / 32);
  const offset = normalized % 32;
  if (quadrant === 0) return QUARTER_SINE_MICRO[offset];
  if (quadrant === 1) return QUARTER_SINE_MICRO[32 - offset];
  if (quadrant === 2) return -QUARTER_SINE_MICRO[offset];
  return -QUARTER_SINE_MICRO[32 - offset];
}

function cosineMicro(index) {
  return sineMicro(index + 32);
}

function roundDivide(numerator, denominator) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || denominator <= 0n) {
    throw new Error("parametric fixed-point division requires bigint numerator and positive bigint denominator");
  }
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function formatMicroUnits(value) {
  if (typeof value !== "bigint") throw new Error("parametric coordinate must be a bigint");
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MICRO_SCALE;
  const remainder = absolute % MICRO_SCALE;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole}`;
  const fraction = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function encodeObj(vertices, faces) {
  const lines = ["# asset-tooling canonical procedural OBJ v1"];
  for (const vertex of vertices) lines.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
  for (const face of faces) lines.push(`f ${face[0]} ${face[1]} ${face[2]}`);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function normalizeTorusParameters(value, location = "torus parameters") {
  const parameters = exactKeys(
    value,
    ["majorRadius", "minorRadius", "majorSegments", "minorSegments"],
    location,
  );
  const majorRadius = integer(parameters.majorRadius, `${location}.majorRadius`, 2);
  const minorRadius = integer(parameters.minorRadius, `${location}.minorRadius`, 1, MAX_SIZE - 1);
  if (minorRadius >= majorRadius) {
    throw new Error(`${location}.minorRadius must be smaller than majorRadius`);
  }
  return {
    majorRadius,
    minorRadius,
    majorSegments: oneOfIntegers(
      parameters.majorSegments,
      `${location}.majorSegments`,
      PROCEDURAL_RADIAL_SEGMENTS,
    ),
    minorSegments: oneOfIntegers(
      parameters.minorSegments,
      `${location}.minorSegments`,
      PROCEDURAL_RADIAL_SEGMENTS,
    ),
  };
}

export function generateTorusObj(value) {
  const { majorRadius, minorRadius, majorSegments, minorSegments } = normalizeTorusParameters(
    value,
    "torus",
  );
  const majorStep = CIRCLE_SAMPLE_COUNT / majorSegments;
  const minorStep = CIRCLE_SAMPLE_COUNT / minorSegments;
  const vertices = [];
  for (let major = 0; major < majorSegments; major += 1) {
    const majorIndex = major * majorStep;
    const majorCos = BigInt(cosineMicro(majorIndex));
    const majorSin = BigInt(sineMicro(majorIndex));
    for (let minor = 0; minor < minorSegments; minor += 1) {
      const minorIndex = minor * minorStep;
      const minorCos = BigInt(cosineMicro(minorIndex));
      const minorSin = BigInt(sineMicro(minorIndex));
      const radialMicro = BigInt(majorRadius) * MICRO_SCALE + BigInt(minorRadius) * minorCos;
      vertices.push([
        formatMicroUnits(roundDivide(radialMicro * majorCos, MICRO_SCALE)),
        formatMicroUnits(BigInt(minorRadius) * minorSin),
        formatMicroUnits(roundDivide(radialMicro * majorSin, MICRO_SCALE)),
      ]);
    }
  }

  const faces = [];
  for (let major = 0; major < majorSegments; major += 1) {
    const nextMajor = (major + 1) % majorSegments;
    for (let minor = 0; minor < minorSegments; minor += 1) {
      const nextMinor = (minor + 1) % minorSegments;
      const a = major * minorSegments + minor + 1;
      const b = nextMajor * minorSegments + minor + 1;
      const c = major * minorSegments + nextMinor + 1;
      const d = nextMajor * minorSegments + nextMinor + 1;
      faces.push([a, c, b], [b, c, d]);
    }
  }
  return {
    bytes: encodeObj(vertices, faces),
    vertexCount: vertices.length,
    triangleCount: faces.length,
  };
}

function normalizeParameters(operation, value) {
  if (operation.id === "mesh.procedural.torus") {
    return normalizeTorusParameters(value, `${operation.id} parameters`);
  }
  throw new Error(`unsupported parametric surface operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("parametric surface operation root must be an absolute path");
  }
  return root;
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: "canonical-triangular-obj-torus-fixed-micro-two-angle-v1",
    randomness: "none",
    meshFormat: "obj",
    coordinateSystem: "right-handed-y-up",
    coordinateQuantization: "1e-6-unit-fixed-table",
    tool: await captureToolIdentity(),
  };
}

async function createBuildIdentity(root, operation, parameters, inputs) {
  assertRoot(root);
  return createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizeParameters(operation, parameters),
    inputs,
  });
}

async function execute(root, operation, build) {
  const assetRoot = assertRoot(root);
  const generated = generateTorusObj(build.parameters);
  const stored = await storeAssetObject(assetRoot, {
    bytes: generated.bytes,
    kind: "mesh",
    mediaType: "model/obj",
    metadata: {
      meshFormat: "obj",
      topology: "triangles",
      coordinateSystem: "right-handed-y-up",
      coordinateQuantization: "1e-6-unit-fixed-table",
      vertexCount: generated.vertexCount,
      triangleCount: generated.triangleCount,
      generator: `${operation.id}@${operation.version}`,
      surface: "torus",
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

export async function createProceduralTorusOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PROCEDURAL_TORUS_OPERATION, parameters, inputs);
}

export async function executeProceduralTorusOperation(root, invocation = {}) {
  const build = await createProceduralTorusOperationBuildIdentity(root, invocation);
  return execute(root, PROCEDURAL_TORUS_OPERATION, build);
}
