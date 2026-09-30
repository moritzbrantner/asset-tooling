import path from "node:path";
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
  type CanonicalJsonObject,
} from "./operations.js";
import { createThreeDProductionManifest } from "./three-d-production-profile.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
const MAX_PROXIES = 128;
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const POSITIVE_DECIMAL_SCHEMA_PATTERN =
  "^(?=.*[1-9])(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,6})?$";

export const COLLISION_PROXY_SET_MEDIA_TYPE =
  "application/vnd.asset-tooling.collision-proxy-set+json";

const proxyBaseProperties = {
  id: { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" },
  target: { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" },
  center: {
    type: "array",
    minItems: 3,
    maxItems: 3,
    items: { type: "string", pattern: "^-?(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,6})?$" },
  },
};

const REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "collision.proxy-set.build",
    version: VERSION,
    label: "Build collision proxy set",
    description:
      "Build a deterministic renderer-neutral primitive collision-proxy asset in target-local right-handed Y-up coordinates.",
    category: "mesh.collision",
    inputs: [],
    outputs: [
      {
        id: "output",
        label: "Collision proxy set",
        assetKinds: ["collision"],
        mediaTypes: [COLLISION_PROXY_SET_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "proxies"],
      properties: {
        unit: { type: "string", enum: ["meter", "centimeter", "millimeter"] },
        proxies: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PROXIES,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["id", "target", "shape", "center", "size"],
                properties: {
                  ...proxyBaseProperties,
                  shape: { const: "box" },
                  size: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "string", pattern: POSITIVE_DECIMAL_SCHEMA_PATTERN },
                  },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["id", "target", "shape", "center", "radius"],
                properties: {
                  ...proxyBaseProperties,
                  shape: { const: "sphere" },
                  radius: { type: "string", pattern: POSITIVE_DECIMAL_SCHEMA_PATTERN },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["id", "target", "shape", "center", "radius", "segmentLength"],
                properties: {
                  ...proxyBaseProperties,
                  shape: { const: "capsule" },
                  radius: { type: "string", pattern: POSITIVE_DECIMAL_SCHEMA_PATTERN },
                  segmentLength: { type: "string", pattern: POSITIVE_DECIMAL_SCHEMA_PATTERN },
                },
              },
            ],
          },
        },
      },
    },
  },
]);

export const COLLISION_PROXY_SET_BUILD_OPERATION = REGISTRY.get(
  "collision.proxy-set.build",
  VERSION,
);
export const COLLISION_OPERATIONS = REGISTRY.list();

type PlainObject = Record<string, unknown>;
type ExactVector3 = [string, string, string];
type NormalizedProxy =
  | {
      id: string;
      target: string;
      shape: "box";
      center: ExactVector3;
      size: ExactVector3;
    }
  | {
      id: string;
      target: string;
      shape: "sphere";
      center: ExactVector3;
      radius: string;
    }
  | {
      id: string;
      target: string;
      shape: "capsule";
      center: ExactVector3;
      radius: string;
      segmentLength: string;
    };

export type CollisionProxySetBuildParameters = {
  unit: "meter" | "centimeter" | "millimeter";
  proxies: NormalizedProxy[];
};

function plainObject(value: unknown, location: string): PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  return value as PlainObject;
}

function exactKeys(value: PlainObject, keys: readonly string[], location: string): PlainObject {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${location} is missing '${key}'`);
  }
  return value;
}

function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${location} must use lower-kebab-case`);
  }
  return value;
}

function exactDecimal(value: unknown, location: string, positive = false): string {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`${location} must be an exact decimal string with at most 6 fractional digits`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const zero = whole === "0" && trimmedFraction.length === 0;
  if (positive && (negative || zero)) {
    throw new Error(`${location} must be greater than zero`);
  }
  if (zero) return "0";
  const normalized = trimmedFraction.length === 0 ? whole : `${whole}.${trimmedFraction}`;
  return negative ? `-${normalized}` : normalized;
}

function vector3(value: unknown, location: string, positive = false): ExactVector3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${location} must contain exactly three exact decimal strings`);
  }
  return [
    exactDecimal(value[0], `${location}[0]`, positive),
    exactDecimal(value[1], `${location}[1]`, positive),
    exactDecimal(value[2], `${location}[2]`, positive),
  ];
}

function normalizeProxy(value: unknown, index: number): NormalizedProxy {
  const location = `collision proxy parameters.proxies[${index}]`;
  const base = plainObject(value, location);
  const shape = base.shape;
  if (shape === "box") {
    const proxy = exactKeys(base, ["id", "target", "shape", "center", "size"], location);
    return {
      id: identifier(proxy.id, `${location}.id`),
      target: identifier(proxy.target, `${location}.target`),
      shape,
      center: vector3(proxy.center, `${location}.center`),
      size: vector3(proxy.size, `${location}.size`, true),
    };
  }
  if (shape === "sphere") {
    const proxy = exactKeys(base, ["id", "target", "shape", "center", "radius"], location);
    return {
      id: identifier(proxy.id, `${location}.id`),
      target: identifier(proxy.target, `${location}.target`),
      shape,
      center: vector3(proxy.center, `${location}.center`),
      radius: exactDecimal(proxy.radius, `${location}.radius`, true),
    };
  }
  if (shape === "capsule") {
    const proxy = exactKeys(
      base,
      ["id", "target", "shape", "center", "radius", "segmentLength"],
      location,
    );
    return {
      id: identifier(proxy.id, `${location}.id`),
      target: identifier(proxy.target, `${location}.target`),
      shape,
      center: vector3(proxy.center, `${location}.center`),
      radius: exactDecimal(proxy.radius, `${location}.radius`, true),
      segmentLength: exactDecimal(proxy.segmentLength, `${location}.segmentLength`, true),
    };
  }
  throw new Error(`${location}.shape must be one of box, sphere, capsule`);
}

export function normalizeCollisionProxySetBuildParameters(
  value: unknown,
): CollisionProxySetBuildParameters {
  const parameters = exactKeys(
    plainObject(value, "collision proxy parameters"),
    ["unit", "proxies"],
    "collision proxy parameters",
  );
  if (!Array.isArray(parameters.proxies)) {
    throw new Error("collision proxy parameters.proxies must be an array");
  }
  if (parameters.proxies.length < 1 || parameters.proxies.length > MAX_PROXIES) {
    throw new Error(`collision proxy parameters.proxies must contain 1..${MAX_PROXIES} entries`);
  }

  const proxies = parameters.proxies
    .map(normalizeProxy)
    .sort((left, right) => compareCodeUnitStrings(left.id, right.id));
  if (new Set(proxies.map((proxy) => proxy.id)).size !== proxies.length) {
    throw new Error("collision proxy parameters.proxies must not contain duplicate ids");
  }

  const profile = createThreeDProductionManifest({
    unit: parameters.unit,
    collisionProxies: proxies.map(({ id, target, shape }) => ({ id, target, shape })),
  });

  return {
    unit: profile.unit,
    proxies,
  };
}

function assertRoot(root: string): string {
  if (!path.isAbsolute(root)) {
    throw new Error("collision operation root must be an absolute path");
  }
  return root;
}

async function implementationIdentity(): Promise<CanonicalJsonObject> {
  return {
    id: "builtin.collision.proxy-set.build",
    version: VERSION,
    algorithm: "canonical-primitive-collision-proxy-set-v1",
    coordinateSystem: "right-handed-y-up",
    capsuleAxis: "local-y",
    randomness: "none",
    tool: await captureToolIdentity(),
  };
}

export async function createCollisionProxySetBuildIdentity(
  root: string,
  { parameters = {}, inputs = {} }: { parameters?: unknown; inputs?: unknown } = {},
) {
  assertRoot(root);
  const normalized = normalizeCollisionProxySetBuildParameters(parameters);
  return createAssetOperationBuildIdentity({
    operation: COLLISION_PROXY_SET_BUILD_OPERATION,
    implementation: await implementationIdentity(),
    parameters: normalized,
    inputs,
  });
}

export async function executeCollisionProxySetBuildOperation(
  root: string,
  invocation: { parameters?: unknown; inputs?: unknown } = {},
) {
  const assetRoot = assertRoot(root);
  const build = await createCollisionProxySetBuildIdentity(assetRoot, invocation);
  const normalized = normalizeCollisionProxySetBuildParameters(build.parameters);
  const profile = createThreeDProductionManifest({
    unit: normalized.unit,
    collisionProxies: normalized.proxies.map(({ id, target, shape }) => ({ id, target, shape })),
  });
  const document = {
    schemaVersion: 1,
    profile: profile.profile,
    coordinateSystem: profile.coordinateSystem,
    unit: profile.unit,
    unitScaleToMeters: profile.unitScaleToMeters,
    transformSpace: profile.transformSpace,
    capsuleAxis: "local-y",
    proxies: normalized.proxies,
  };
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
  const shapeCounts = Object.fromEntries(
    ["box", "sphere", "capsule"].map((shape) => [
      shape,
      normalized.proxies.filter((proxy) => proxy.shape === shape).length,
    ]),
  );
  const stored = await storeAssetObject(assetRoot, {
    bytes,
    kind: "collision",
    mediaType: COLLISION_PROXY_SET_MEDIA_TYPE,
    metadata: {
      profile: document.profile,
      coordinateSystem: document.coordinateSystem,
      unit: document.unit,
      proxyCount: normalized.proxies.length,
      targetCount: new Set(normalized.proxies.map((proxy) => proxy.target)).size,
      shapeCounts,
    },
  });
  return normalizeAssetOperationResult(COLLISION_PROXY_SET_BUILD_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      algorithm: build.implementation.algorithm,
      proxyCount: normalized.proxies.length,
      targetCount: new Set(normalized.proxies.map((proxy) => proxy.target)).size,
      shapeCounts,
      capsuleAxis: "local-y",
    },
  });
}
