import { AUTHORED_EFFECT_SEQUENCE_PRESETS } from "./authored-effect-sequences.js";
import { CORN_PRESETS } from "./corn-recipes.js";
import { EFFECT_ARTWORK_PRESETS } from "./effect-artwork-recipes.js";
import { FENCE_PRESETS } from "./fence-kit-recipes.js";
import { FEEDBACK_KIT_MEDIA_TYPE, FEEDBACK_KIT_PRESETS } from "./feedback-kits.js";
import { GRASS_PRESETS } from "./grass-recipes.js";
import { RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import { LEAF_ARTWORK_PRESETS } from "./leaf-artwork-recipes.js";
import { MEDIEVAL_CHARACTER_RECIPES } from "./medieval-character-kit.js";
import { ROCK_PRESETS } from "./rock-recipes.js";
import { SURFACE_APPEARANCE_PRESETS } from "./surface-appearance-recipes.js";
import { SURFACE_TEXTURE_PRESETS } from "./surface-texture-recipes.js";
import { TRANSITION_TILE_PRESET } from "./transition-tile-recipes.js";
import { TREE_PRESETS } from "./tree-recipes.js";
import { WHEAT_PRESETS } from "./wheat-recipes.js";

const PROVIDER = Object.freeze({
  id: "asset-tooling",
  label: "asset-tooling",
  homepage: "https://github.com/moritzbrantner/asset-tooling",
  distribution: "generated",
});

function titleCase(value) {
  return String(value)
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part === "ui" ? "UI" : part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function recipeAsset({ id, title, kind, mediaType = "", recipe, purpose, tags = [], metadata = {} }) {
  return {
    id,
    title,
    kind,
    mediaType,
    provider: { ...PROVIDER },
    state: "recipe",
    license: {
      spdx: null,
      attribution: null,
      evidenceUrl: null,
    },
    source: {
      url: null,
      upstreamId: null,
      revision: null,
      path: null,
      sha256: null,
      byteLength: null,
    },
    storage: null,
    tags: [...new Set(["generated", "recipe", ...tags])].sort(),
    metadata: {
      purpose,
      recipe,
      availability: "generated on demand",
      ...metadata,
    },
  };
}

function presetAssets(presets, { prefix, titlePrefix = null, kind, mediaType = "", recipe, purpose, tags = [] }) {
  return Object.keys(presets).map((id) => recipeAsset({
    id: `${prefix}.${id}`,
    title: titlePrefix ? `${titlePrefix} — ${titleCase(id)}` : titleCase(id),
    kind,
    mediaType,
    recipe,
    purpose,
    tags,
  }));
}

export function createGeneratedGalleryAssets() {
  const assets = [
    ...Object.entries(MEDIEVAL_CHARACTER_RECIPES).map(([id, preset]) => recipeAsset({
      id: `medieval.${id}`,
      title: preset.label,
      kind: "mesh",
      mediaType: "model/obj",
      recipe: "asset-tooling/recipes/medieval-character-kit",
      purpose: "Deterministic built-in medieval character geometry.",
      tags: ["character", "medieval", "three-d"],
    })),
    ...presetAssets(ROCK_PRESETS, {
      prefix: "rock",
      titlePrefix: "Rock",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      recipe: "asset-tooling/recipes/rocks",
      purpose: "Controllable procedural rock geometry preset.",
      tags: ["natural", "rock", "three-d"],
    }),
    ...presetAssets(TREE_PRESETS, {
      prefix: "tree",
      titlePrefix: "Tree",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      recipe: "asset-tooling/recipes/trees",
      purpose: "Controllable native-ground tree or shrub geometry preset.",
      tags: ["natural", "vegetation", "three-d"],
    }),
    ...presetAssets(GRASS_PRESETS, {
      prefix: "grass",
      titlePrefix: "Grass",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      recipe: "asset-tooling/recipes/grass",
      purpose: "Bounded procedural grass-clump geometry preset.",
      tags: ["grass", "natural", "vegetation", "three-d"],
    }),
    ...presetAssets(WHEAT_PRESETS, {
      prefix: "wheat",
      titlePrefix: "Wheat",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      recipe: "asset-tooling/recipes/wheat",
      purpose: "Reusable Wheat appearance-stage geometry.",
      tags: ["crop", "farm", "vegetation", "three-d"],
    }),
    ...presetAssets(CORN_PRESETS, {
      prefix: "corn",
      titlePrefix: "Corn",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      recipe: "asset-tooling/recipes/corn",
      purpose: "Reusable Corn appearance-stage geometry.",
      tags: ["crop", "farm", "vegetation", "three-d"],
    }),
    ...presetAssets(FENCE_PRESETS, {
      prefix: "fence",
      titlePrefix: "Fence",
      kind: "mesh",
      mediaType: "model/gltf-binary",
      recipe: "asset-tooling/recipes/fence",
      purpose: "Modular fence piece with declared connection ports.",
      tags: ["environment", "modular", "three-d"],
    }),
    ...presetAssets(SURFACE_TEXTURE_PRESETS, {
      prefix: "surface",
      kind: "texture",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      recipe: "asset-tooling/recipes/surface-textures",
      purpose: "Deterministic editable surface-texture preset.",
      tags: ["material", "procedural", "texture", "two-d"],
    }),
    ...SURFACE_APPEARANCE_PRESETS.soilMoisture.states.map((state) => recipeAsset({
      id: `surface.soil-moisture.${state.id}`,
      title: `Soil Moisture — ${titleCase(state.id)}`,
      kind: "texture",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      recipe: "asset-tooling/recipes/surface-appearances",
      purpose: "Named soil-moisture appearance sharing one verified relief.",
      tags: ["material", "soil", "state", "texture", "two-d"],
    })),
    ...presetAssets(LEAF_ARTWORK_PRESETS, {
      prefix: "leaf",
      titlePrefix: "Leaf",
      kind: "image",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      recipe: "asset-tooling/recipes/leaf-artwork",
      purpose: "Standalone recolorable leaf artwork and mask preset.",
      tags: ["foliage", "natural", "two-d"],
    }),
    ...Object.entries(EFFECT_ARTWORK_PRESETS).flatMap(([shape, variants]) =>
      Object.keys(variants).map((variant) => recipeAsset({
        id: `effect-artwork.${shape}.${variant}`,
        title: `${titleCase(shape)} — ${titleCase(variant)}`,
        kind: "image",
        mediaType: RGBA8_IMAGE_MEDIA_TYPE,
        recipe: "asset-tooling/recipes/effect-artwork",
        purpose: "Standalone deterministic effect artwork preset.",
        tags: ["effect", "two-d", shape],
      })),
    ),
    ...Object.entries(AUTHORED_EFFECT_SEQUENCE_PRESETS).flatMap(([shape, variants]) =>
      Object.keys(variants).map((variant) => recipeAsset({
        id: `effect-sequence.${shape}.${variant}`,
        title: `${titleCase(shape)} Sequence — ${titleCase(variant)}`,
        kind: "effect-sequence",
        recipe: "asset-tooling/recipes/authored-effect-sequences",
        purpose: "Authored effect-frame sequence with explicit timing and pivots.",
        tags: ["animation", "effect", "two-d", shape],
      })),
    ),
    ...Object.values(FEEDBACK_KIT_PRESETS).map((preset) => recipeAsset({
      id: `feedback.${preset.kit}`,
      title: titleCase(preset.kit),
      kind: "feedback-kit",
      mediaType: FEEDBACK_KIT_MEDIA_TYPE,
      recipe: "asset-tooling/recipes/feedback-kits",
      purpose: "Coordinated visual and synthesized-audio feedback kit.",
      tags: ["animation", "audio", "effect", "ui"],
      metadata: { variants: Object.keys(preset.variants).sort() },
    })),
    recipeAsset({
      id: "transition.grass-soil-corners",
      title: "Grass / Soil Transition Tile Kit",
      kind: "asset-pack",
      recipe: "asset-tooling/recipes/transition-tiles",
      purpose: "Complete generated grass/soil corner-transition tile family.",
      tags: ["game", "terrain", "tile", "texture", "two-d"],
      metadata: {
        tileCount: 16,
        size: TRANSITION_TILE_PRESET.size,
      },
    }),
  ];

  const ids = new Set();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(`duplicate generated gallery asset '${asset.id}'`);
    ids.add(asset.id);
  }
  return assets.sort((left, right) => left.id.localeCompare(right.id));
}

export function generatedGalleryProvider() {
  return { ...PROVIDER };
}


export function extendCatalogGalleryModel(model) {
  const generated = createGeneratedGalleryAssets();
  const ids = new Set(model.assets.map((asset) => asset.id));
  for (const asset of generated) {
    if (ids.has(asset.id)) throw new Error(`generated gallery asset '${asset.id}' conflicts with a catalog source`);
    ids.add(asset.id);
  }

  const provider = generatedGalleryProvider();
  const providers = model.providers.filter((entry) => entry.id !== provider.id);
  providers.push({
    id: provider.id,
    label: provider.label,
    distribution: provider.distribution,
  });

  return {
    ...model,
    assets: [...model.assets, ...generated].sort((left, right) => left.id.localeCompare(right.id)),
    providers: providers.sort((left, right) => left.id.localeCompare(right.id)),
  };
}
