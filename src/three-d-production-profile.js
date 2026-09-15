const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const UNIT_SCALE_TO_METERS = Object.freeze({
  meter: "1",
  centimeter: "0.01",
  millimeter: "0.001",
});
const COLLISION_PROXY_SHAPES = Object.freeze(["box", "sphere", "capsule", "convex-hull"]);

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export const THREE_D_PRODUCTION_PROFILE_V1 = deepFreeze({
  schemaVersion: 1,
  id: "asset-tooling-3d-production-v1",
  coordinateSystem: "right-handed-y-up",
  units: {
    supported: Object.keys(UNIT_SCALE_TO_METERS),
    scaleToMeters: { ...UNIT_SCALE_TO_METERS },
    rule: "explicit-exact-decimal",
  },
  transforms: {
    space: "local",
    translationUnit: "asset-unit",
    rotationRepresentation: "quaternion-xyzw",
    scaleUnit: "dimensionless",
  },
  naming: {
    convention: "lower-kebab-case",
    materialSemantics: "stable-role-id",
    animationSemantics: "stable-clip-id",
  },
  collisionProxies: {
    declaration: "explicit-manifest-entry",
    namingInference: false,
    shapes: [...COLLISION_PROXY_SHAPES],
  },
});

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

export function normalizeThreeDProductionIdentifier(value, location = "3D production identifier") {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${location} must use lower-kebab-case`);
  }
  return value;
}

function uniqueIdentifiers(values, location) {
  if (!Array.isArray(values)) throw new Error(`${location} must be an array`);
  const normalized = values.map((value, index) =>
    normalizeThreeDProductionIdentifier(value, `${location}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${location} must not contain duplicate identifiers`);
  }
  return normalized;
}

function collisionProxy(value, index) {
  const location = `3D production manifest.collisionProxies[${index}]`;
  const proxy = exactKeys(value, ["id", "target", "shape"], location);
  const shape = proxy.shape;
  if (!COLLISION_PROXY_SHAPES.includes(shape)) {
    throw new Error(`${location}.shape must be one of ${COLLISION_PROXY_SHAPES.join(", ")}`);
  }
  return {
    id: normalizeThreeDProductionIdentifier(proxy.id, `${location}.id`),
    target: normalizeThreeDProductionIdentifier(proxy.target, `${location}.target`),
    shape,
  };
}

function collisionProxies(values) {
  if (!Array.isArray(values)) throw new Error("3D production manifest.collisionProxies must be an array");
  const normalized = values.map(collisionProxy);
  const ids = normalized.map((proxy) => proxy.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("3D production manifest.collisionProxies must not contain duplicate ids");
  }
  return normalized;
}

export function normalizeThreeDProductionManifest(value) {
  const manifest = exactKeys(
    value,
    [
      "schemaVersion",
      "profile",
      "coordinateSystem",
      "unit",
      "unitScaleToMeters",
      "transformSpace",
      "rotationRepresentation",
      "materials",
      "animations",
      "collisionProxies",
    ],
    "3D production manifest",
  );
  if (manifest.schemaVersion !== 1) throw new Error("3D production manifest.schemaVersion must be 1");
  if (manifest.profile !== THREE_D_PRODUCTION_PROFILE_V1.id) {
    throw new Error(`3D production manifest.profile must be '${THREE_D_PRODUCTION_PROFILE_V1.id}'`);
  }
  if (manifest.coordinateSystem !== THREE_D_PRODUCTION_PROFILE_V1.coordinateSystem) {
    throw new Error(
      `3D production manifest.coordinateSystem must be '${THREE_D_PRODUCTION_PROFILE_V1.coordinateSystem}'`,
    );
  }
  if (!Object.hasOwn(UNIT_SCALE_TO_METERS, manifest.unit)) {
    throw new Error(
      `3D production manifest.unit must be one of ${Object.keys(UNIT_SCALE_TO_METERS).join(", ")}`,
    );
  }
  const expectedScale = UNIT_SCALE_TO_METERS[manifest.unit];
  if (manifest.unitScaleToMeters !== expectedScale) {
    throw new Error(
      `3D production manifest.unitScaleToMeters must be '${expectedScale}' for unit '${manifest.unit}'`,
    );
  }
  if (manifest.transformSpace !== THREE_D_PRODUCTION_PROFILE_V1.transforms.space) {
    throw new Error("3D production manifest.transformSpace must be 'local'");
  }
  if (
    manifest.rotationRepresentation !==
    THREE_D_PRODUCTION_PROFILE_V1.transforms.rotationRepresentation
  ) {
    throw new Error("3D production manifest.rotationRepresentation must be 'quaternion-xyzw'");
  }
  return {
    schemaVersion: 1,
    profile: THREE_D_PRODUCTION_PROFILE_V1.id,
    coordinateSystem: THREE_D_PRODUCTION_PROFILE_V1.coordinateSystem,
    unit: manifest.unit,
    unitScaleToMeters: expectedScale,
    transformSpace: THREE_D_PRODUCTION_PROFILE_V1.transforms.space,
    rotationRepresentation: THREE_D_PRODUCTION_PROFILE_V1.transforms.rotationRepresentation,
    materials: uniqueIdentifiers(manifest.materials, "3D production manifest.materials"),
    animations: uniqueIdentifiers(manifest.animations, "3D production manifest.animations"),
    collisionProxies: collisionProxies(manifest.collisionProxies),
  };
}

export function createThreeDProductionManifest({
  unit,
  materials = [],
  animations = [],
  collisionProxies: proxies = [],
} = {}) {
  const scale = UNIT_SCALE_TO_METERS[unit];
  if (scale === undefined) {
    throw new Error(`3D production unit must be one of ${Object.keys(UNIT_SCALE_TO_METERS).join(", ")}`);
  }
  return normalizeThreeDProductionManifest({
    schemaVersion: 1,
    profile: THREE_D_PRODUCTION_PROFILE_V1.id,
    coordinateSystem: THREE_D_PRODUCTION_PROFILE_V1.coordinateSystem,
    unit,
    unitScaleToMeters: scale,
    transformSpace: THREE_D_PRODUCTION_PROFILE_V1.transforms.space,
    rotationRepresentation: THREE_D_PRODUCTION_PROFILE_V1.transforms.rotationRepresentation,
    materials,
    animations,
    collisionProxies: proxies,
  });
}
