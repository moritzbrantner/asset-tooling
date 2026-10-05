import test from "node:test";
import assert from "node:assert/strict";
import { AUTHORED_EFFECT_SEQUENCE_PRESETS } from "../src/authored-effect-sequences.js";
import { CORN_PRESETS } from "../src/corn-recipes.js";
import { EFFECT_ARTWORK_PRESETS } from "../src/effect-artwork-recipes.js";
import { FENCE_PRESETS } from "../src/fence-kit-recipes.js";
import { FEEDBACK_KIT_PRESETS } from "../src/feedback-kits.js";
import { GRASS_PRESETS } from "../src/grass-recipes.js";
import {
  createGeneratedGalleryAssets,
  extendCatalogGalleryModel,
  generatedGalleryProvider,
} from "../src/generated-gallery-assets.js";
import { LEAF_ARTWORK_PRESETS } from "../src/leaf-artwork-recipes.js";
import { MEDIEVAL_CHARACTER_RECIPES } from "../src/medieval-character-kit.js";
import { ROCK_PRESETS } from "../src/rock-recipes.js";
import { renderCatalogAssetHtml, renderCatalogGalleryHtml } from "../src/catalog-pages-site.js";
import { SURFACE_APPEARANCE_PRESETS } from "../src/surface-appearance-recipes.js";
import { SURFACE_TEXTURE_PRESETS } from "../src/surface-texture-recipes.js";
import { TREE_PRESETS } from "../src/tree-recipes.js";
import { WHEAT_PRESETS } from "../src/wheat-recipes.js";

function idsFor(prefix, record) {
  return Object.keys(record).map((id) => `${prefix}.${id}`);
}

test("generated gallery inventory follows every built-in reusable asset preset", () => {
  const assets = createGeneratedGalleryAssets();
  const ids = new Set(assets.map((asset) => asset.id));
  const expected = [
    ...idsFor("medieval", MEDIEVAL_CHARACTER_RECIPES),
    ...idsFor("rock", ROCK_PRESETS),
    ...idsFor("tree", TREE_PRESETS),
    ...idsFor("grass", GRASS_PRESETS),
    ...idsFor("wheat", WHEAT_PRESETS),
    ...idsFor("corn", CORN_PRESETS),
    ...idsFor("fence", FENCE_PRESETS),
    ...idsFor("surface", SURFACE_TEXTURE_PRESETS),
    ...SURFACE_APPEARANCE_PRESETS.soilMoisture.states.map((state) => `surface.soil-moisture.${state.id}`),
    ...idsFor("leaf", LEAF_ARTWORK_PRESETS),
    ...Object.entries(EFFECT_ARTWORK_PRESETS).flatMap(([shape, variants]) =>
      Object.keys(variants).map((variant) => `effect-artwork.${shape}.${variant}`),
    ),
    ...Object.entries(AUTHORED_EFFECT_SEQUENCE_PRESETS).flatMap(([shape, variants]) =>
      Object.keys(variants).map((variant) => `effect-sequence.${shape}.${variant}`),
    ),
    ...Object.values(FEEDBACK_KIT_PRESETS).map((preset) => `feedback.${preset.kit}`),
    "transition.grass-soil-corners",
  ];

  assert.equal(assets.length, expected.length);
  assert.equal(ids.size, assets.length);
  for (const id of expected) assert(ids.has(id), `missing generated gallery asset ${id}`);
  assert(assets.every((asset) => asset.state === "recipe"));
  assert(assets.every((asset) => asset.provider.id === "asset-tooling"));
  assert(assets.every((asset) => asset.source.url === null));
  assert.equal(ids.has("production-props.wood-barrel"), false, "queued local models are not published as existing assets");

  const transitions = assets.find((asset) => asset.id === "transition.grass-soil-corners");
  assert.equal(transitions.metadata.tileCount, 16);
});

test("catalog gallery extension keeps catalog authority separate from generated recipes", () => {
  const catalog = {
    schemaVersion: 1,
    assets: [{
      id: "source.asset",
      title: "Source Asset",
      kind: "texture",
      mediaType: "image/png",
      provider: { id: "source", label: "Source", homepage: "https://example.com", distribution: "shared" },
      state: "pinned",
      license: { spdx: "CC0-1.0", attribution: null, evidenceUrl: "https://example.com/license" },
      source: { url: "https://example.com/a.png", upstreamId: "a", revision: "1", path: "a.png", sha256: "a".repeat(64), byteLength: 1 },
      storage: null,
      tags: [],
      metadata: { purpose: "fixture" },
    }],
    providers: [{ id: "source", label: "Source", distribution: "shared" }],
  };
  const model = extendCatalogGalleryModel(catalog);
  assert(model.assets.some((asset) => asset.id === "source.asset" && asset.state === "pinned"));
  assert(model.assets.some((asset) => asset.id === "rock.rounded" && asset.state === "recipe"));
  assert(model.providers.some((provider) => provider.id === "asset-tooling" && provider.distribution === "generated"));
});

test("gallery and detail pages explain generated recipe entries without fake provenance", () => {
  const asset = createGeneratedGalleryAssets().find((entry) => entry.id === "rock.rounded");
  const model = {
    schemaVersion: 1,
    assets: [asset],
    providers: [generatedGalleryProvider()],
  };

  const gallery = renderCatalogGalleryHtml(model);
  assert.match(gallery, /built-in asset recipes/);
  assert.match(gallery, /<option value="recipe">recipe<\/option>/);
  assert.match(gallery, /Rounded/);
  assert.match(gallery, /asset-tooling/);

  const detail = renderCatalogAssetHtml(asset);
  assert.match(detail, /Recipe/);
  assert.match(detail, /asset-tooling\/recipes\/rocks/);
  assert.match(detail, /generated on demand/);
  assert.doesNotMatch(detail, /SHA-256/);
  assert.doesNotMatch(detail, /License evidence/);
});
