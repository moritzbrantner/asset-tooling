const GENERATOR_KINDS = new Set(["procedural", "model", "utility"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value, location) {
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
      assertJsonValue(child, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} contains unsupported value type '${typeof value}'`);
}

export function receiptGenerator(specGenerator, backend) {
  if (!GENERATOR_KINDS.has(backend.kind)) {
    throw new Error(`generator backend '${backend.id}' has unsupported kind '${backend.kind}'`);
  }
  if (backend.id !== specGenerator.id || backend.version !== specGenerator.version) {
    throw new Error("selected backend identity does not match the asset specification");
  }
  return {
    id: specGenerator.id,
    version: specGenerator.version,
    kind: backend.kind,
  };
}

export function normalizeGenerationResult(value, backendId) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { bytes: Buffer.from(value), observations: {} };
  }
  if (!isObject(value)) {
    throw new Error(`${backendId} must return bytes or a generation result object`);
  }
  const unknown = Object.keys(value).filter((key) => key !== "bytes" && key !== "observations");
  if (unknown.length > 0) {
    throw new Error(`${backendId} generation result contains unknown field '${unknown[0]}'`);
  }
  if (!Buffer.isBuffer(value.bytes) && !(value.bytes instanceof Uint8Array)) {
    throw new Error(`${backendId} generation result bytes must be a Buffer or Uint8Array`);
  }
  if (!isObject(value.observations)) {
    throw new Error(`${backendId} generation result observations must be an object`);
  }
  assertJsonValue(value.observations, `${backendId} observations`);
  return {
    bytes: Buffer.from(value.bytes),
    observations: value.observations,
  };
}
