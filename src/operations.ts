import { canonicalJson, compareCodeUnitStrings, type CanonicalJsonValue } from "./canonical.js";
import { sha256Text } from "./hash.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[A-Za-z0-9]+(?:[._+-][A-Za-z0-9]+)*$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const PORT_MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/;

type PlainObject = Record<string, unknown>;
export type CanonicalJsonObject = { [key: string]: CanonicalJsonValue };
export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export interface AssetRef {
  schemaVersion: 1;
  kind: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  metadata: CanonicalJsonObject;
}

export type AssetOperationCardinality = "single" | "many" | { min: number; max: number };

export interface AssetOperationPort {
  id: string;
  label?: string;
  assetKinds: string[];
  mediaTypes: string[];
  cardinality: AssetOperationCardinality;
  required: boolean;
}

export interface AssetOperationDescriptor {
  schemaVersion: 1;
  id: string;
  version: string;
  label?: string;
  description?: string;
  category: string;
  inputs: AssetOperationPort[];
  outputs: AssetOperationPort[];
  parameterSchema: CanonicalJsonObject;
}

export type ReadonlyAssetOperationDescriptor = DeepReadonly<AssetOperationDescriptor>;
export type AssetPortValue = AssetRef | AssetRef[];
export type AssetPortMap = Record<string, AssetPortValue>;

export interface AssetOperationResult {
  outputs: AssetPortMap;
  observations: CanonicalJsonObject;
}

export interface AssetOperationBuildIdentityInput {
  operation: unknown;
  implementation: unknown;
  parameters?: unknown;
  inputs?: unknown;
}

export interface AssetOperationBuildIdentity {
  schemaVersion: 1;
  operation: {
    id: string;
    version: string;
  };
  implementation: CanonicalJsonObject;
  parameters: CanonicalJsonObject;
  inputs: AssetPortMap;
}

export interface AssetOperationRegistry {
  register(value: unknown): ReadonlyAssetOperationDescriptor;
  get(id: string, version: string): ReadonlyAssetOperationDescriptor | undefined;
  has(id: string, version: string): boolean;
  list(): readonly ReadonlyAssetOperationDescriptor[];
}

function isObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown, location: string): PlainObject {
  if (!isObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value: PlainObject, allowed: ReadonlySet<string>, location: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function assertToken(value: unknown, location: string): string {
  const token = assertNonEmptyString(value, location);
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`${location} must be a lowercase dotted token`);
  }
  return token;
}

function assertVersion(value: unknown, location: string): string {
  const version = assertNonEmptyString(value, location);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${location} must be a portable version token`);
  }
  return version;
}

function assertMediaType(value: unknown, location: string): string {
  const mediaType = assertNonEmptyString(value, location);
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new Error(`${location} must be a lowercase concrete media type such as 'image/png'`);
  }
  return mediaType;
}

function assertPortMediaType(value: unknown, location: string): string {
  const mediaType = assertNonEmptyString(value, location);
  if (!PORT_MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new Error(`${location} must be a lowercase media type or family such as 'image/png' or 'image/*'`);
  }
  return mediaType;
}

function assertJsonValue(value: unknown, location: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) throw new Error(`${location}.${key} is undefined`);
      assertJsonValue(child, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} contains unsupported non-JSON value`);
}

function canonicalClone(value: unknown, location: string): CanonicalJsonValue {
  assertJsonValue(value, location);
  return JSON.parse(canonicalJson(value)) as CanonicalJsonValue;
}

function canonicalObject(value: unknown, location: string): CanonicalJsonObject {
  const normalized = canonicalClone(value, location);
  if (!isObject(normalized)) throw new Error(`${location} must be an object`);
  return normalized as CanonicalJsonObject;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value) as DeepReadonly<T>;
  }
  if (isObject(value)) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}

function normalizeStringList(
  value: unknown,
  location: string,
  validator: (value: unknown, location: string) => string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const result = value.map((entry, index) => validator(entry, `${location}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${location} must not contain duplicates`);
  return result;
}

function normalizeCardinality(value: unknown, location: string): AssetOperationCardinality {
  if (value === undefined || value === "single") return "single";
  if (value === "many") return "many";
  const bounded = assertObject(value, location);
  assertExactKeys(bounded, new Set(["min", "max"]), location);
  const min = bounded.min ?? 0;
  const max = bounded.max;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 0) {
    throw new Error(`${location}.min must be a non-negative integer`);
  }
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    throw new Error(`${location}.max must be a positive integer`);
  }
  if (min > max) throw new Error(`${location}.min must not exceed max`);
  return { min, max };
}

function normalizePort(value: unknown, location: string): AssetOperationPort {
  const port = assertObject(value, location);
  assertExactKeys(
    port,
    new Set(["id", "label", "assetKinds", "mediaTypes", "cardinality", "required"]),
    location,
  );
  const required = port.required ?? true;
  if (typeof required !== "boolean") throw new Error(`${location}.required must be a boolean`);
  const result: AssetOperationPort = {
    id: assertToken(port.id, `${location}.id`),
    cardinality: normalizeCardinality(port.cardinality, `${location}.cardinality`),
    required,
    assetKinds: normalizeStringList(port.assetKinds, `${location}.assetKinds`, assertToken),
    mediaTypes: normalizeStringList(port.mediaTypes, `${location}.mediaTypes`, assertPortMediaType),
  };
  if (port.label !== undefined) result.label = assertNonEmptyString(port.label, `${location}.label`);
  return result;
}

function normalizePorts(value: unknown, location: string): AssetOperationPort[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const ports = value.map((port, index) => normalizePort(port, `${location}[${index}]`));
  const ids = ports.map((port) => port.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${location} contains duplicate port ids`);
  return ports;
}

function mediaTypeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (!expected.endsWith("/*")) return false;
  return actual.startsWith(expected.slice(0, -1));
}

function assertAssetCompatible(port: AssetOperationPort, asset: AssetRef, location: string): void {
  if (port.assetKinds.length > 0 && !port.assetKinds.includes(asset.kind)) {
    throw new Error(`${location} asset kind '${asset.kind}' is not accepted by port '${port.id}'`);
  }
  if (
    port.mediaTypes.length > 0 &&
    !port.mediaTypes.some((mediaType) => mediaTypeMatches(mediaType, asset.mediaType))
  ) {
    throw new Error(`${location} media type '${asset.mediaType}' is not accepted by port '${port.id}'`);
  }
}

function normalizePortValue(port: AssetOperationPort, value: unknown, location: string): AssetPortValue {
  if (port.cardinality === "single") {
    if (Array.isArray(value)) throw new Error(`${location} must contain exactly one asset`);
    const asset = createAssetRef(value);
    assertAssetCompatible(port, asset, location);
    return asset;
  }

  if (!Array.isArray(value)) throw new Error(`${location} must be an array of assets`);
  const assets = value.map((asset, index) => {
    const normalized = createAssetRef(asset);
    assertAssetCompatible(port, normalized, `${location}[${index}]`);
    return normalized;
  });

  if (isObject(port.cardinality)) {
    if (assets.length < port.cardinality.min || assets.length > port.cardinality.max) {
      throw new Error(
        `${location} must contain ${port.cardinality.min}..${port.cardinality.max} assets`,
      );
    }
  }
  return assets;
}

function normalizePortMap(
  operation: AssetOperationDescriptor,
  value: unknown,
  direction: "inputs" | "outputs",
): AssetPortMap {
  const map = assertObject(value, `operation ${direction}`);
  const ports = direction === "inputs" ? operation.inputs : operation.outputs;
  const portById = new Map(ports.map((port) => [port.id, port]));

  for (const id of Object.keys(map)) {
    if (!portById.has(id)) throw new Error(`operation ${direction} contains unknown port '${id}'`);
  }

  const result: AssetPortMap = {};
  for (const port of ports) {
    if (!Object.hasOwn(map, port.id)) {
      if (port.required) throw new Error(`operation ${direction} is missing required port '${port.id}'`);
      continue;
    }
    result[port.id] = normalizePortValue(port, map[port.id], `operation ${direction}.${port.id}`);
  }
  return result;
}

export function createAssetRef(value: unknown): AssetRef {
  const asset = assertObject(value, "asset ref");
  assertExactKeys(
    asset,
    new Set(["schemaVersion", "kind", "mediaType", "sha256", "byteLength", "metadata"]),
    "asset ref",
  );

  const schemaVersion = asset.schemaVersion ?? 1;
  if (schemaVersion !== 1) throw new Error("asset ref schemaVersion must be 1");
  const sha256 = asset.sha256;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new Error("asset ref sha256 must be a lowercase 64-character SHA-256 digest");
  }
  const byteLength = asset.byteLength;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("asset ref byteLength must be a non-negative safe integer");
  }

  return {
    schemaVersion: 1,
    kind: assertToken(asset.kind, "asset ref kind"),
    mediaType: assertMediaType(asset.mediaType, "asset ref mediaType"),
    sha256,
    byteLength,
    metadata: canonicalObject(asset.metadata ?? {}, "asset ref metadata"),
  };
}

export function createAssetOperationDescriptor(value: unknown): AssetOperationDescriptor {
  const descriptor = assertObject(value, "asset operation descriptor");
  assertExactKeys(
    descriptor,
    new Set([
      "schemaVersion",
      "id",
      "version",
      "label",
      "description",
      "category",
      "inputs",
      "outputs",
      "parameterSchema",
    ]),
    "asset operation descriptor",
  );

  const schemaVersion = descriptor.schemaVersion ?? 1;
  if (schemaVersion !== 1) throw new Error("asset operation descriptor schemaVersion must be 1");

  const result: AssetOperationDescriptor = {
    schemaVersion: 1,
    id: assertToken(descriptor.id, "asset operation descriptor id"),
    version: assertVersion(descriptor.version, "asset operation descriptor version"),
    category: assertToken(descriptor.category, "asset operation descriptor category"),
    inputs: normalizePorts(descriptor.inputs ?? [], "asset operation descriptor inputs"),
    outputs: normalizePorts(descriptor.outputs ?? [], "asset operation descriptor outputs"),
    parameterSchema: canonicalObject(
      descriptor.parameterSchema ?? {},
      "asset operation parameterSchema",
    ),
  };

  if (descriptor.label !== undefined) {
    result.label = assertNonEmptyString(descriptor.label, "asset operation descriptor label");
  }
  if (descriptor.description !== undefined) {
    result.description = assertNonEmptyString(
      descriptor.description,
      "asset operation descriptor description",
    );
  }
  return result;
}

export function assetOperationKey(value: unknown, version?: unknown): string {
  if (typeof value === "string") {
    return `${assertToken(value, "asset operation id")}@${assertVersion(version, "asset operation version")}`;
  }
  const operation = createAssetOperationDescriptor(value);
  return `${operation.id}@${operation.version}`;
}

export function createAssetOperationRegistry(initialDescriptors: unknown = []): AssetOperationRegistry {
  if (!Array.isArray(initialDescriptors)) {
    throw new Error("initial asset operation descriptors must be an array");
  }
  const operations = new Map<string, ReadonlyAssetOperationDescriptor>();

  function register(value: unknown): ReadonlyAssetOperationDescriptor {
    const descriptor = deepFreeze(createAssetOperationDescriptor(value));
    const key = `${descriptor.id}@${descriptor.version}`;
    if (operations.has(key)) throw new Error(`asset operation '${key}' is already registered`);
    operations.set(key, descriptor);
    return descriptor;
  }

  for (const descriptor of initialDescriptors) register(descriptor);

  return {
    register,
    get(id: string, version: string): ReadonlyAssetOperationDescriptor | undefined {
      return operations.get(assetOperationKey(id, version));
    },
    has(id: string, version: string): boolean {
      return operations.has(assetOperationKey(id, version));
    },
    list(): readonly ReadonlyAssetOperationDescriptor[] {
      return [...operations.values()].sort((left, right) => {
        const idComparison = compareCodeUnitStrings(left.id, right.id);
        return idComparison !== 0
          ? idComparison
          : compareCodeUnitStrings(left.version, right.version);
      });
    },
  };
}

export function normalizeAssetOperationInputs(operationValue: unknown, inputs: unknown): AssetPortMap {
  const operation = createAssetOperationDescriptor(operationValue);
  return normalizePortMap(operation, inputs, "inputs");
}

export function normalizeAssetOperationResult(
  operationValue: unknown,
  value: unknown,
): AssetOperationResult {
  const operation = createAssetOperationDescriptor(operationValue);
  const result = assertObject(value, "asset operation result");
  assertExactKeys(result, new Set(["outputs", "observations"]), "asset operation result");
  return {
    outputs: normalizePortMap(operation, result.outputs ?? {}, "outputs"),
    observations: canonicalObject(
      result.observations ?? {},
      "asset operation result observations",
    ),
  };
}

export function createAssetOperationBuildIdentity({
  operation: operationValue,
  implementation,
  parameters = {},
  inputs = {},
}: AssetOperationBuildIdentityInput): AssetOperationBuildIdentity {
  const operation = createAssetOperationDescriptor(operationValue);
  const implementationValue = assertObject(implementation, "asset operation implementation");
  assertNonEmptyString(implementationValue.id, "asset operation implementation id");
  assertVersion(implementationValue.version, "asset operation implementation version");

  return {
    schemaVersion: 1,
    operation: {
      id: operation.id,
      version: operation.version,
    },
    implementation: canonicalObject(implementationValue, "asset operation implementation"),
    parameters: canonicalObject(parameters, "asset operation parameters"),
    inputs: normalizePortMap(operation, inputs, "inputs"),
  };
}

export function createAssetOperationCacheKey(value: AssetOperationBuildIdentityInput): string {
  return sha256Text(canonicalJson(createAssetOperationBuildIdentity(value)));
}
