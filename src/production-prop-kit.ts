import {
  normalizeCollisionProxySetBuildParameters,
  type CollisionProxySetBuildParameters,
} from "./collision-operations.js";

export const PRODUCTION_PROP_VISUAL_SOURCE_CANDIDATES = Object.freeze([
  "quaternius.fantasy-props-megakit-standard",
  "quaternius.medieval-village-megakit-standard",
]);

export const PRODUCTION_PROP_MATERIAL_POLICY = Object.freeze({
  model: "pbr-metallic-roughness",
  sourceUvPolicy: "preserve-explicit-source-uvs",
  textureMappingPolicy: "explicit-semantic-mapping",
  missingChannelPolicy: "do-not-fabricate-pbr-semantics",
  lineagePolicy: "preserve-source-texture-hashes",
});

const RAW_COLLISION_PRESETS = {
  barrel: {
    unit: "meter",
    proxies: [
      {
        id: "barrel-body",
        target: "barrel",
        shape: "capsule",
        center: ["0", "0.45", "0"],
        radius: "0.3",
        segmentLength: "0.3",
      },
    ],
  },
  barricade: {
    unit: "meter",
    proxies: [
      { id: "barricade-foot-left", target: "barricade", shape: "box", center: ["-0.75", "0.08", "0"], size: ["0.65", "0.16", "0.7"] },
      { id: "barricade-foot-right", target: "barricade", shape: "box", center: ["0.75", "0.08", "0"], size: ["0.65", "0.16", "0.7"] },
      { id: "barricade-post-left", target: "barricade", shape: "box", center: ["-0.75", "0.75", "0"], size: ["0.16", "1.5", "0.16"] },
      { id: "barricade-post-right", target: "barricade", shape: "box", center: ["0.75", "0.75", "0"], size: ["0.16", "1.5", "0.16"] },
      { id: "barricade-rail-lower", target: "barricade", shape: "box", center: ["0", "0.62", "0"], size: ["2.1", "0.22", "0.16"] },
      { id: "barricade-rail-upper", target: "barricade", shape: "box", center: ["0", "1.08", "0"], size: ["2.3", "0.24", "0.16"] },
    ],
  },
  box: {
    unit: "meter",
    proxies: [
      { id: "box-body", target: "box", shape: "box", center: ["0", "0.5", "0"], size: ["1", "1", "1"] },
    ],
  },
  crate: {
    unit: "meter",
    proxies: [
      { id: "crate-body", target: "crate", shape: "box", center: ["0", "0.5", "0"], size: ["1", "1", "1"] },
    ],
  },
  door: {
    unit: "meter",
    proxies: [
      { id: "door-frame-left", target: "door-frame", shape: "box", center: ["-0.55", "1.1", "0"], size: ["0.1", "2.2", "0.2"] },
      { id: "door-frame-right", target: "door-frame", shape: "box", center: ["0.55", "1.1", "0"], size: ["0.1", "2.2", "0.2"] },
      { id: "door-frame-lintel", target: "door-frame", shape: "box", center: ["0", "2.15", "0"], size: ["1", "0.1", "0.2"] },
      { id: "door-leaf", target: "door-leaf", shape: "box", center: ["0", "1.05", "0"], size: ["1", "2.1", "0.08"] },
    ],
  },
  wall: {
    unit: "meter",
    proxies: [
      { id: "wall-body", target: "wall", shape: "box", center: ["0", "1.25", "0"], size: ["3", "2.5", "0.25"] },
    ],
  },
  window: {
    unit: "meter",
    proxies: [
      { id: "window-frame-left", target: "window-frame", shape: "box", center: ["-1.35", "1.25", "0"], size: ["0.3", "2.5", "0.25"] },
      { id: "window-frame-right", target: "window-frame", shape: "box", center: ["1.35", "1.25", "0"], size: ["0.3", "2.5", "0.25"] },
      { id: "window-frame-lintel", target: "window-frame", shape: "box", center: ["0", "2.35", "0"], size: ["2.4", "0.3", "0.25"] },
      { id: "window-frame-sill", target: "window-frame", shape: "box", center: ["0", "0.15", "0"], size: ["2.4", "0.3", "0.25"] },
    ],
  },
} as const;

export type ProductionPropId = keyof typeof RAW_COLLISION_PRESETS;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

export const PRODUCTION_PROP_COLLISION_PRESETS = deepFreeze(
  Object.fromEntries(
    Object.entries(RAW_COLLISION_PRESETS).map(([id, preset]) => [
      id,
      normalizeCollisionProxySetBuildParameters(preset),
    ]),
  ) as Record<ProductionPropId, CollisionProxySetBuildParameters>,
);

export function getProductionPropCollisionPreset(id: ProductionPropId): CollisionProxySetBuildParameters {
  return PRODUCTION_PROP_COLLISION_PRESETS[id];
}
