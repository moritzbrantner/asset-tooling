import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Text } from "./hash.js";
import { lumaRgba8 } from "./image-color.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  centeredInstanceBounds,
  createInstanceSet,
  encodeInstanceSet,
  INSTANCE_SET_ASSET_KIND,
  INSTANCE_SET_COORDINATE_QUANTIZATION,
  INSTANCE_SET_COORDINATE_SYSTEM,
  INSTANCE_SET_MAX_INSTANCES,
  INSTANCE_SET_MEDIA_TYPE,
  INSTANCE_SET_MICRO_SCALE,
  INSTANCE_SET_SCHEMA_VERSION,
  parseInstanceSet,
} from "./instance-set.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_WORLD_UNITS = 1_000_000;
const CANDIDATES_PER_INSTANCE = 256;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;
const MASK64 = 0xffffffffffffffffn;
const SPLITMIX_INCREMENT = 0x9e3779b97f4a7c15n;
const SPLITMIX_MIX_1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_MIX_2 = 0x94d049bb133111ebn;

const instanceSetOutput = {
  id: "output",
  label: "Instance set",
  assetKinds: [INSTANCE_SET_ASSET_KIND],
  mediaTypes: [INSTANCE_SET_MEDIA_TYPE],
};
const instanceSetInput = {
  id: "source",
  label: "Source instance set",
  assetKinds: [INSTANCE_SET_ASSET_KIND],
  mediaTypes: [INSTANCE_SET_MEDIA_TYPE],
};
const heightInput = {
  id: "height",
  label: "Height field",
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
};

const scatterBaseProperties = {
  seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  count: { type: "integer", minimum: 1, maximum: INSTANCE_SET_MAX_INSTANCES },
  width: { type: "integer", minimum: 1, maximum: MAX_WORLD_UNITS },
  depth: { type: "integer", minimum: 1, maximum: MAX_WORLD_UNITS },
};

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "instances.project.heightfield",
    version: VERSION,
    label: "Project instances onto height field",
    description:
      "Project an existing fixed-micro-unit XZ instance distribution onto canonical RGBA8 height luma using exact nearest-sample integer mapping.",
    category: "instances.transform",
    inputs: [instanceSetInput, heightInput],
    outputs: [instanceSetOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["heightScale"],
      properties: {
        heightScale: { type: "integer", minimum: 0, maximum: MAX_WORLD_UNITS },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "instances.scatter.minimum-distance",
    version: VERSION,
    label: "Scatter instances with minimum distance",
    description:
      "Generate deterministic seeded XZ instance positions with an exact minimum-distance guarantee using fixed micro-unit rejection sampling and spatial buckets.",
    category: "procedural.instances",
    inputs: [],
    outputs: [instanceSetOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["seed", "count", "width", "depth", "minDistance"],
      properties: {
        ...scatterBaseProperties,
        minDistance: { type: "integer", minimum: 1, maximum: MAX_WORLD_UNITS },
      },
    },
  },
  {
    schemaVersion: 1,
    id: "instances.scatter.uniform",
    version: VERSION,
    label: "Scatter instances uniformly",
    description:
      "Generate deterministic seeded unique XZ instance positions from a SHA-256-seeded SplitMix64 candidate stream at fixed micro-unit precision.",
    category: "procedural.instances",
    inputs: [],
    outputs: [instanceSetOutput],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["seed", "count", "width", "depth"],
      properties: scatterBaseProperties,
    },
  },
]);

export const INSTANCE_HEIGHTFIELD_PROJECT_OPERATION = OPERATION_REGISTRY.get(
  "instances.project.heightfield",
  VERSION,
);
export const INSTANCE_MINIMUM_DISTANCE_SCATTER_OPERATION = OPERATION_REGISTRY.get(
  "instances.scatter.minimum-distance",
  VERSION,
);
export const INSTANCE_UNIFORM_SCATTER_OPERATION = OPERATION_REGISTRY.get(
  "instances.scatter.uniform",
  VERSION,
);
export const INSTANCE_OPERATIONS = OPERATION_REGISTRY.list();

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

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function seed(value) {
  if (typeof value !== "string" || !SEED_PATTERN.test(value)) {
    throw new Error("parameters.seed must be a non-negative decimal integer string");
  }
  return value;
}

function normalizeScatterBase(value, keys, location) {
  const parameters = exactKeys(value, keys, location);
  return {
    seed: seed(parameters.seed),
    count: integer(parameters.count, "parameters.count", 1, INSTANCE_SET_MAX_INSTANCES),
    width: integer(parameters.width, "parameters.width", 1, MAX_WORLD_UNITS),
    depth: integer(parameters.depth, "parameters.depth", 1, MAX_WORLD_UNITS),
  };
}

function normalizeParameters(operation, value) {
  if (operation.id === "instances.scatter.uniform") {
    return normalizeScatterBase(
      value,
      ["seed", "count", "width", "depth"],
      `${operation.id} parameters`,
    );
  }
  if (operation.id === "instances.scatter.minimum-distance") {
    const base = normalizeScatterBase(
      value,
      ["seed", "count", "width", "depth", "minDistance"],
      `${operation.id} parameters`,
    );
    return {
      ...base,
      minDistance: integer(value.minDistance, "parameters.minDistance", 1, MAX_WORLD_UNITS),
    };
  }
  if (operation.id === "instances.project.heightfield") {
    const parameters = exactKeys(value, ["heightScale"], `${operation.id} parameters`);
    return {
      heightScale: integer(parameters.heightScale, "parameters.heightScale", 0, MAX_WORLD_UNITS),
    };
  }
  throw new Error(`unsupported instance operation '${operation.id}'`);
}

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("instance operation root must be an absolute path");
  }
  return root;
}

function splitMix64(seedValue) {
  const digest = sha256Text(`asset-tooling.scatter.v1\0${seedValue}`);
  let state = BigInt(`0x${digest.slice(0, 16)}`);
  return () => {
    state = (state + SPLITMIX_INCREMENT) & MASK64;
    let mixed = state;
    mixed = ((mixed ^ (mixed >> 30n)) * SPLITMIX_MIX_1) & MASK64;
    mixed = ((mixed ^ (mixed >> 27n)) * SPLITMIX_MIX_2) & MASK64;
    return (mixed ^ (mixed >> 31n)) & MASK64;
  };
}

function scatterGeometry({ width, depth }) {
  const widthMicro = width * INSTANCE_SET_MICRO_SCALE;
  const depthMicro = depth * INSTANCE_SET_MICRO_SCALE;
  return {
    widthMicro,
    depthMicro,
    ...centeredInstanceBounds(widthMicro, depthMicro),
  };
}

function candidateStream(parameters) {
  const geometry = scatterGeometry(parameters);
  const random = splitMix64(parameters.seed);
  return {
    geometry,
    next() {
      return {
        x:
          geometry.minX +
          Number(random() % BigInt(geometry.widthMicro)),
        z:
          geometry.minZ +
          Number(random() % BigInt(geometry.depthMicro)),
      };
    },
  };
}

function instanceId(index) {
  return `instance-${String(index).padStart(6, "0")}`;
}

function makeInstanceSet(geometry, points) {
  return createInstanceSet({
    schemaVersion: INSTANCE_SET_SCHEMA_VERSION,
    coordinateSystem: INSTANCE_SET_COORDINATE_SYSTEM,
    coordinateQuantization: INSTANCE_SET_COORDINATE_QUANTIZATION,
    bounds: {
      widthMicro: geometry.widthMicro,
      depthMicro: geometry.depthMicro,
    },
    instances: points.map((point, index) => ({
      id: instanceId(index),
      positionMicro: [point.x, 0, point.z],
    })),
  });
}

export function generateUniformInstanceSet(parameters) {
  const normalized = normalizeParameters(INSTANCE_UNIFORM_SCATTER_OPERATION, parameters);
  const stream = candidateStream(normalized);
  const points = [];
  const seen = new Set();
  let candidateCount = 0;
  const maxCandidates = Math.max(16, normalized.count * 8);
  while (points.length < normalized.count && candidateCount < maxCandidates) {
    const candidate = stream.next();
    candidateCount += 1;
    const key = `${candidate.x},${candidate.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(candidate);
  }
  if (points.length !== normalized.count) {
    throw new Error(
      `unable to generate ${normalized.count} unique uniform positions after ${maxCandidates} deterministic candidates`,
    );
  }
  return {
    instanceSet: makeInstanceSet(stream.geometry, points),
    candidateCount,
    rejectedCount: candidateCount - points.length,
  };
}

function bucketCoordinate(position, minimum, cellSize) {
  return Math.floor((position - minimum) / cellSize);
}

function bucketKey(x, z) {
  return `${x},${z}`;
}

function satisfiesMinimumDistance(candidate, buckets, geometry, minDistanceMicro) {
  const bucketX = bucketCoordinate(candidate.x, geometry.minX, minDistanceMicro);
  const bucketZ = bucketCoordinate(candidate.z, geometry.minZ, minDistanceMicro);
  const minimumSquared = BigInt(minDistanceMicro) * BigInt(minDistanceMicro);
  for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const neighbors = buckets.get(bucketKey(bucketX + offsetX, bucketZ + offsetZ)) ?? [];
      for (const neighbor of neighbors) {
        const dx = BigInt(candidate.x - neighbor.x);
        const dz = BigInt(candidate.z - neighbor.z);
        if (dx * dx + dz * dz < minimumSquared) return false;
      }
    }
  }
  return true;
}

export function generateMinimumDistanceInstanceSet(parameters) {
  const normalized = normalizeParameters(INSTANCE_MINIMUM_DISTANCE_SCATTER_OPERATION, parameters);
  const stream = candidateStream(normalized);
  const minDistanceMicro = normalized.minDistance * INSTANCE_SET_MICRO_SCALE;
  const points = [];
  const buckets = new Map();
  let candidateCount = 0;
  const maxCandidates = Math.max(16, normalized.count * CANDIDATES_PER_INSTANCE);
  while (points.length < normalized.count && candidateCount < maxCandidates) {
    const candidate = stream.next();
    candidateCount += 1;
    if (!satisfiesMinimumDistance(candidate, buckets, stream.geometry, minDistanceMicro)) continue;
    const bucketX = bucketCoordinate(candidate.x, stream.geometry.minX, minDistanceMicro);
    const bucketZ = bucketCoordinate(candidate.z, stream.geometry.minZ, minDistanceMicro);
    const key = bucketKey(bucketX, bucketZ);
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
    points.push(candidate);
  }
  if (points.length !== normalized.count) {
    throw new Error(
      `unable to place ${normalized.count} instances with minDistance ${normalized.minDistance} within ${normalized.width}x${normalized.depth} after ${maxCandidates} deterministic candidates`,
    );
  }
  return {
    instanceSet: makeInstanceSet(stream.geometry, points),
    candidateCount,
    rejectedCount: candidateCount - points.length,
    minDistanceMicro,
  };
}

function roundDivideBigInt(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error("instance projection ratio requires non-negative numerator and positive denominator");
  }
  return (numerator + denominator / 2n) / denominator;
}

function sampleAxis(position, minimum, spanMicro, sampleCount) {
  if (sampleCount <= 1 || spanMicro <= 1) return 0;
  const numerator = BigInt(position - minimum) * BigInt(sampleCount - 1);
  return Number(roundDivideBigInt(numerator, BigInt(spanMicro - 1)));
}

export function projectInstanceSetToHeightfield(instanceSetValue, heightValue, { heightScale }) {
  const instanceSet = createInstanceSet(instanceSetValue);
  const height = parseRgba8Image(heightValue);
  const scale = integer(heightScale, "heightScale", 0, MAX_WORLD_UNITS);
  const geometry = centeredInstanceBounds(
    instanceSet.bounds.widthMicro,
    instanceSet.bounds.depthMicro,
  );
  const instances = instanceSet.instances.map((instance) => {
    const [x, , z] = instance.positionMicro;
    const sampleX = sampleAxis(x, geometry.minX, instanceSet.bounds.widthMicro, height.width);
    const sampleY = sampleAxis(z, geometry.minZ, instanceSet.bounds.depthMicro, height.height);
    const offset = (sampleY * height.width + sampleX) * 4;
    const luma = lumaRgba8(
      height.pixels[offset],
      height.pixels[offset + 1],
      height.pixels[offset + 2],
    );
    const y = Number(
      roundDivideBigInt(
        BigInt(luma) * BigInt(scale) * BigInt(INSTANCE_SET_MICRO_SCALE),
        255n,
      ),
    );
    return {
      id: instance.id,
      positionMicro: [x, y, z],
    };
  });
  return createInstanceSet({
    ...instanceSet,
    instances,
  });
}

function algorithm(operation) {
  const algorithms = {
    "instances.project.heightfield": "nearest-q8-heightfield-instance-projection-v1",
    "instances.scatter.minimum-distance": "sha256-seeded-splitmix64-min-distance-micro-xz-v1",
    "instances.scatter.uniform": "sha256-seeded-splitmix64-unique-uniform-micro-xz-v1",
  };
  return algorithms[operation.id];
}

async function implementationIdentity(operation) {
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm: algorithm(operation),
    randomness: operation.id.startsWith("instances.scatter.") ? "seeded" : "none",
    instanceSetSchemaVersion: INSTANCE_SET_SCHEMA_VERSION,
    coordinateSystem: INSTANCE_SET_COORDINATE_SYSTEM,
    coordinateQuantization: INSTANCE_SET_COORDINATE_QUANTIZATION,
    ...(operation.id === "instances.scatter.minimum-distance"
      ? { candidateBudgetPerInstance: CANDIDATES_PER_INSTANCE }
      : {}),
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
  if (operation.id === "instances.project.heightfield") {
    parseInstanceSet(await resolveAssetObject(assetRoot, build.inputs.source));
    parseRgba8Image(await resolveAssetObject(assetRoot, build.inputs.height));
  }
  return build;
}

async function execute(root, operation, build) {
  const assetRoot = assertRoot(root);
  let generated;
  let metadata;
  let observations;
  if (operation.id === "instances.scatter.uniform") {
    generated = generateUniformInstanceSet(build.parameters);
    metadata = {
      distribution: "uniform",
      seed: build.parameters.seed,
    };
    observations = {
      candidateCount: generated.candidateCount,
      rejectedCount: generated.rejectedCount,
    };
  } else if (operation.id === "instances.scatter.minimum-distance") {
    generated = generateMinimumDistanceInstanceSet(build.parameters);
    metadata = {
      distribution: "minimum-distance",
      seed: build.parameters.seed,
      minDistanceMicro: generated.minDistanceMicro,
    };
    observations = {
      candidateCount: generated.candidateCount,
      rejectedCount: generated.rejectedCount,
      minDistanceMicro: generated.minDistanceMicro,
    };
  } else if (operation.id === "instances.project.heightfield") {
    const source = parseInstanceSet(await resolveAssetObject(assetRoot, build.inputs.source));
    const heightBytes = await resolveAssetObject(assetRoot, build.inputs.height);
    const height = parseRgba8Image(heightBytes);
    generated = {
      instanceSet: projectInstanceSetToHeightfield(source, heightBytes, build.parameters),
    };
    metadata = {
      distribution: "projected-heightfield",
      sourceInstanceSetSha256: build.inputs.source.sha256,
      sourceHeightSha256: build.inputs.height.sha256,
      heightSampling: "nearest",
      heightScale: build.parameters.heightScale,
    };
    observations = {
      heightWidth: height.width,
      heightHeight: height.height,
    };
  } else {
    throw new Error(`unsupported instance operation '${operation.id}'`);
  }

  const instanceSet = generated.instanceSet;
  const stored = await storeAssetObject(assetRoot, {
    bytes: encodeInstanceSet(instanceSet),
    kind: INSTANCE_SET_ASSET_KIND,
    mediaType: INSTANCE_SET_MEDIA_TYPE,
    metadata: {
      schemaVersion: INSTANCE_SET_SCHEMA_VERSION,
      count: instanceSet.instances.length,
      widthMicro: instanceSet.bounds.widthMicro,
      depthMicro: instanceSet.bounds.depthMicro,
      coordinateSystem: INSTANCE_SET_COORDINATE_SYSTEM,
      coordinateQuantization: INSTANCE_SET_COORDINATE_QUANTIZATION,
      generator: `${operation.id}@${operation.version}`,
      ...metadata,
    },
  });
  return normalizeAssetOperationResult(operation, {
    outputs: { output: stored.asset },
    observations: {
      count: instanceSet.instances.length,
      algorithm: build.implementation.algorithm,
      randomness: build.implementation.randomness,
      parameters: build.parameters,
      ...observations,
    },
  });
}

export async function createUniformScatterOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, INSTANCE_UNIFORM_SCATTER_OPERATION, parameters, inputs);
}

export async function executeUniformScatterOperation(root, invocation = {}) {
  const build = await createUniformScatterOperationBuildIdentity(root, invocation);
  return execute(root, INSTANCE_UNIFORM_SCATTER_OPERATION, build);
}

export async function createMinimumDistanceScatterOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, INSTANCE_MINIMUM_DISTANCE_SCATTER_OPERATION, parameters, inputs);
}

export async function executeMinimumDistanceScatterOperation(root, invocation = {}) {
  const build = await createMinimumDistanceScatterOperationBuildIdentity(root, invocation);
  return execute(root, INSTANCE_MINIMUM_DISTANCE_SCATTER_OPERATION, build);
}

export async function createHeightfieldProjectionOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, INSTANCE_HEIGHTFIELD_PROJECT_OPERATION, parameters, inputs);
}

export async function executeHeightfieldProjectionOperation(root, invocation = {}) {
  const build = await createHeightfieldProjectionOperationBuildIdentity(root, invocation);
  return execute(root, INSTANCE_HEIGHTFIELD_PROJECT_OPERATION, build);
}
