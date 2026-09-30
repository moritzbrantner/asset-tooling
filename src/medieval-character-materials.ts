import { buildMedievalCharacterKitManifest, MEDIEVAL_CHARACTER_RECIPES } from "./medieval-character-kit.js";
import { createThreeDProductionManifest } from "./three-d-production-profile.js";

const MATERIAL_RECIPE_VERSION = "1";
const PACKAGE_VERSION = "1";
const UNORM8_MAX = 255;

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function unorm8(value, location) {
  if (!Number.isInteger(value) || value < 0 || value > UNORM8_MAX) {
    throw new Error(`${location} must be an integer in 0..255`);
  }
  return value;
}

function material(id, baseColorSrgb8, metallic, roughness, doubleSided = false) {
  if (typeof id !== "string" || id.length === 0) throw new Error("material id must be a non-empty string");
  if (!Array.isArray(baseColorSrgb8) || baseColorSrgb8.length !== 4) {
    throw new Error(`material '${id}' baseColorSrgb8 must contain exactly four channels`);
  }
  return deepFreeze({
    id,
    baseColorSrgb8: baseColorSrgb8.map((value, index) => unorm8(value, `material '${id}' baseColorSrgb8[${index}]`)),
    metallic: unorm8(metallic, `material '${id}' metallic`),
    roughness: unorm8(roughness, `material '${id}' roughness`),
    doubleSided: Boolean(doubleSided),
  });
}

const COMMON_MATERIALS = deepFreeze([
  material("skin", [202, 160, 124, 255], 0, 190),
  material("leather", [91, 58, 36, 255], 0, 215),
  material("wood", [111, 76, 45, 255], 0, 225),
  material("steel", [154, 163, 176, 255], 215, 92),
  material("string", [205, 190, 160, 255], 0, 245, true),
]);

function palette(id, label, primary, secondary) {
  return deepFreeze({
    id,
    label,
    materials: [
      material("cloth-primary", [...primary, 255], 0, 205),
      material("cloth-secondary", [...secondary, 255], 0, 195),
      ...COMMON_MATERIALS,
    ],
  });
}

export const MEDIEVAL_CHARACTER_PALETTES = deepFreeze([
  palette("burgundy", "Burgundy and ochre", [116, 34, 48], [191, 154, 79]),
  palette("azure", "Azure and silver", [43, 78, 132], [210, 211, 215]),
  palette("neutral", "Neutral field colors", [89, 86, 77], [151, 128, 92]),
]);

export const MEDIEVAL_CHARACTER_PART_MATERIALS = deepFreeze({
  soldier: {
    "left-leg": "leather",
    "right-leg": "leather",
    torso: "cloth-primary",
    head: "skin",
    "left-arm": "skin",
    "right-arm": "skin",
    shield: "cloth-secondary",
    spear: "wood",
  },
  archer: {
    "left-leg": "leather",
    "right-leg": "leather",
    torso: "cloth-primary",
    head: "skin",
    "left-arm": "skin",
    "right-arm": "skin",
    "bow-stave": "wood",
    "bow-string": "string",
    quiver: "leather",
  },
  knight: {
    "left-leg": "steel",
    "right-leg": "steel",
    "armored-torso": "steel",
    helmet: "steel",
    "left-arm": "steel",
    "right-arm": "steel",
    "left-pauldron": "steel",
    "right-pauldron": "steel",
    shield: "cloth-primary",
    sword: "steel",
  },
});

function validateBindings() {
  const materialIds = new Set(MEDIEVAL_CHARACTER_PALETTES[0].materials.map((entry) => entry.id));
  for (const paletteEntry of MEDIEVAL_CHARACTER_PALETTES) {
    const ids = paletteEntry.materials.map((entry) => entry.id);
    if (ids.length !== materialIds.size || ids.some((id) => !materialIds.has(id))) {
      throw new Error(`palette '${paletteEntry.id}' must expose exactly the shared material role set`);
    }
  }

  for (const [archetype, recipe] of Object.entries(MEDIEVAL_CHARACTER_RECIPES)) {
    const bindings = MEDIEVAL_CHARACTER_PART_MATERIALS[archetype];
    if (!bindings) throw new Error(`missing material bindings for '${archetype}'`);
    const partNames = recipe.parts.map((part) => part.name).sort();
    const boundPartNames = Object.keys(bindings).sort();
    if (JSON.stringify(partNames) !== JSON.stringify(boundPartNames)) {
      throw new Error(`material bindings for '${archetype}' must cover every recipe part exactly once`);
    }
    for (const [partName, materialId] of Object.entries(bindings)) {
      if (!materialIds.has(materialId)) {
        throw new Error(`part '${archetype}.${partName}' references unknown material role '${materialId}'`);
      }
    }
  }
}

validateBindings();

export function buildMedievalCharacterMaterialManifest() {
  return {
    schemaVersion: 1,
    id: "medieval-character-materials",
    recipeVersion: MATERIAL_RECIPE_VERSION,
    model: "pbr-metallic-roughness",
    factorEncoding: "unorm8",
    colorSpace: "srgb",
    palettes: MEDIEVAL_CHARACTER_PALETTES.map((paletteEntry) => ({
      id: paletteEntry.id,
      label: paletteEntry.label,
      materials: paletteEntry.materials.map((entry) => ({
        id: entry.id,
        baseColorSrgb8: [...entry.baseColorSrgb8],
        metallic: entry.metallic,
        roughness: entry.roughness,
        doubleSided: entry.doubleSided,
      })),
    })),
    bindings: Object.fromEntries(
      Object.entries(MEDIEVAL_CHARACTER_PART_MATERIALS).map(([archetype, bindings]) => [
        archetype,
        { ...bindings },
      ]),
    ),
  };
}

export function buildMedievalCharacterPackageManifest() {
  return {
    schemaVersion: 1,
    id: "medieval-character-package",
    packageVersion: PACKAGE_VERSION,
    productionProfile: createThreeDProductionManifest({
      unit: "millimeter",
      materials: MEDIEVAL_CHARACTER_PALETTES[0].materials.map((entry) => entry.id),
      animations: [],
      collisionProxies: [],
    }),
    geometry: buildMedievalCharacterKitManifest(),
    materials: buildMedievalCharacterMaterialManifest(),
    processingPlan: {
      status: "intent-only",
      authority: "moritzbrantner/3d-lab",
      sourceMediaType: "model/obj",
      targetMediaType: "model/gltf-binary",
      lod: {
        sourceBased: true,
        budgetRounding: "nearest-ties-away-from-zero",
        levels: [
          { id: "lod0", triangleRatioPermille: 1000 },
          { id: "lod1", triangleRatioPermille: 500 },
          { id: "lod2", triangleRatioPermille: 250 },
        ],
      },
    },
  };
}
