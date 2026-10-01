import { canonicalJson } from "./canonical.js";

export const INSTANCE_SET_MEDIA_TYPE = "application/vnd.asset-tooling.instance-set+json";
export const INSTANCE_SET_ASSET_KIND = "instance-set";
export const INSTANCE_SET_SCHEMA_VERSION = 1;
export const INSTANCE_SET_COORDINATE_SYSTEM = "right-handed-y-up";
export const INSTANCE_SET_COORDINATE_QUANTIZATION = "1e-6-unit";
export const INSTANCE_SET_MICRO_SCALE = 1_000_000;
export const INSTANCE_SET_MAX_INSTANCES = 4096;
export const INSTANCE_SET_MAX_COORDINATE_MICRO = 1_000_000_000_000;

export type InstanceSetBounds = {widthMicro:number;depthMicro:number};
export type InstanceSetInstance = {id:string;positionMicro:[number,number,number]};
export type InstanceSet = {schemaVersion:1;coordinateSystem:typeof INSTANCE_SET_COORDINATE_SYSTEM;
  coordinateQuantization:typeof INSTANCE_SET_COORDINATE_QUANTIZATION;bounds:InstanceSetBounds;instances:InstanceSetInstance[]};

function plainObject(value:unknown, location:string):Record<string,unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  // The plain-object check establishes the external JSON record boundary.
  return value as Record<string,unknown>;
}

function exactKeys(value:unknown, keys:readonly string[], location:string) {
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

function integer(value:unknown, location:string, minimum:number, maximum:number):number {
  if (typeof value!=="number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${location} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function nonEmptyString(value:unknown, location:string):string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

export function centeredInstanceBounds(widthMicro:number, depthMicro:number) {
  const width = integer(
    widthMicro,
    "instance set bounds.widthMicro",
    1,
    INSTANCE_SET_MAX_COORDINATE_MICRO,
  );
  const depth = integer(
    depthMicro,
    "instance set bounds.depthMicro",
    1,
    INSTANCE_SET_MAX_COORDINATE_MICRO,
  );
  const minX = -Math.floor(width / 2);
  const minZ = -Math.floor(depth / 2);
  return {
    minX,
    maxX: minX + width - 1,
    minZ,
    maxZ: minZ + depth - 1,
  };
}

function normalizeBounds(value:unknown):InstanceSetBounds {
  const bounds = exactKeys(value, ["widthMicro", "depthMicro"], "instance set bounds");
  return {
    widthMicro: integer(
      bounds.widthMicro,
      "instance set bounds.widthMicro",
      1,
      INSTANCE_SET_MAX_COORDINATE_MICRO,
    ),
    depthMicro: integer(
      bounds.depthMicro,
      "instance set bounds.depthMicro",
      1,
      INSTANCE_SET_MAX_COORDINATE_MICRO,
    ),
  };
}

function normalizePosition(value:unknown, index:number, bounds:InstanceSetBounds):[number,number,number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`instance set instances[${index}].positionMicro must contain exactly three coordinates`);
  }
  const centered = centeredInstanceBounds(bounds.widthMicro, bounds.depthMicro);
  const x = integer(
    value[0],
    `instance set instances[${index}].positionMicro[0]`,
    centered.minX,
    centered.maxX,
  );
  const y = integer(
    value[1],
    `instance set instances[${index}].positionMicro[1]`,
    -INSTANCE_SET_MAX_COORDINATE_MICRO,
    INSTANCE_SET_MAX_COORDINATE_MICRO,
  );
  const z = integer(
    value[2],
    `instance set instances[${index}].positionMicro[2]`,
    centered.minZ,
    centered.maxZ,
  );
  return [x, y, z];
}

export function createInstanceSet(value:unknown):InstanceSet {
  const source = exactKeys(
    value,
    ["schemaVersion", "coordinateSystem", "coordinateQuantization", "bounds", "instances"],
    "instance set",
  );
  if (source.schemaVersion !== INSTANCE_SET_SCHEMA_VERSION) {
    throw new Error(`instance set schemaVersion must be ${INSTANCE_SET_SCHEMA_VERSION}`);
  }
  if (source.coordinateSystem !== INSTANCE_SET_COORDINATE_SYSTEM) {
    throw new Error(`instance set coordinateSystem must be '${INSTANCE_SET_COORDINATE_SYSTEM}'`);
  }
  if (source.coordinateQuantization !== INSTANCE_SET_COORDINATE_QUANTIZATION) {
    throw new Error(
      `instance set coordinateQuantization must be '${INSTANCE_SET_COORDINATE_QUANTIZATION}'`,
    );
  }
  const bounds = normalizeBounds(source.bounds);
  if (!Array.isArray(source.instances) || source.instances.length > INSTANCE_SET_MAX_INSTANCES) {
    throw new Error(
      `instance set instances must be an array with at most ${INSTANCE_SET_MAX_INSTANCES} entries`,
    );
  }
  const ids = new Set<string>();
  const instances = source.instances.map((entry, index) => {
    const instance = exactKeys(entry, ["id", "positionMicro"], `instance set instances[${index}]`);
    const id = nonEmptyString(instance.id, `instance set instances[${index}].id`);
    if (ids.has(id)) throw new Error(`instance set contains duplicate id '${id}'`);
    ids.add(id);
    return {
      id,
      positionMicro: normalizePosition(instance.positionMicro, index, bounds),
    };
  });
  return {
    schemaVersion: INSTANCE_SET_SCHEMA_VERSION,
    coordinateSystem: INSTANCE_SET_COORDINATE_SYSTEM,
    coordinateQuantization: INSTANCE_SET_COORDINATE_QUANTIZATION,
    bounds,
    instances,
  };
}

export function encodeInstanceSet(value:unknown) {
  return Buffer.from(`${canonicalJson(createInstanceSet(value))}\n`, "utf8");
}

export function parseInstanceSet(bytes:Uint8Array):InstanceSet {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error("instance set bytes must be a Buffer or Uint8Array");
  }
  let parsed:unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error:unknown) {
    throw new Error(`instance set bytes must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return createInstanceSet(parsed);
}
