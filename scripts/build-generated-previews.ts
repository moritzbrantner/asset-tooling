// Build presentation-only samples using the repository's existing asset recipes.
// Preview bytes are disposable Pages artifacts, never catalog sources or provenance receipts.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rm } from "node:fs/promises";
import { canonicalJson } from "../src/canonical.js";
import { sha256Bytes } from "../src/hash.js";
import { createAssetRef } from "../src/operations.js";
import { resolveAssetObject } from "../src/asset-store.js";
import { executeImageEncodePngOperation } from "../src/image-codec-operations.js";
import { executeSpriteAtlasOperation } from "../src/sprite-atlas-operations.js";
import { generateAsset } from "../src/core.js";
import { createGeneratedGalleryAssets } from "../src/generated-gallery-assets.js";
import { ROCK_PRESETS, createRockAssetSpec, readRockRecipeSource } from "../src/rock-recipes.js";
import { TREE_PRESETS, SAPLING_TREE_SOURCE, createTreeAssetSpec, readTreeRecipeSource } from "../src/tree-recipes.js";
import { GRASS_PRESETS, createGrassAssetSpec, readGrassRecipeSource } from "../src/grass-recipes.js";
import { WHEAT_PRESETS, createWheatAssetSpec, readWheatRecipeSource } from "../src/wheat-recipes.js";
import { CORN_PRESETS, createCornAssetSpec, readCornRecipeSource } from "../src/corn-recipes.js";
import { FENCE_PRESETS, createFenceAssetSpec, readFenceRecipeSource } from "../src/fence-kit-recipes.js";
import { generateMedievalCharacterKit } from "../src/medieval-character-kit.js";
import { SURFACE_TEXTURE_PRESETS, executeSurfaceTextureRecipe } from "../src/surface-texture-recipes.js";
import { SURFACE_APPEARANCE_PRESETS, executeSurfaceAppearanceFamily } from "../src/surface-appearance-recipes.js";
import { LEAF_ARTWORK_PRESETS, executeLeafArtworkRecipe } from "../src/leaf-artwork-recipes.js";
import { EFFECT_ARTWORK_PRESETS, executeEffectArtwork } from "../src/effect-artwork-recipes.js";
import { AUTHORED_EFFECT_SEQUENCE_PRESETS, executeAuthoredEffectSequenceRecipe } from "../src/authored-effect-sequences.js";
import { FEEDBACK_KIT_PRESETS, executeFeedbackKitRecipe } from "../src/feedback-kits.js";
import { TRANSITION_TILE_PRESET, executeTransitionTileKit, readTransitionTileConnection } from "../src/transition-tile-recipes.js";
import { writeIfChanged } from "../examples/reconcile-file.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(root, "dist", "pages", "previews");
const workspaceRoot = path.join(root, ".artifacts", "pages-previews");
const index = {};
const media = (name) => "previews/" + name;

function record(id, entry) {
  if (Object.hasOwn(index, id)) throw new Error("duplicate Pages preview " + id);
  index[id] = entry;
}

async function save(name, bytes) {
  if (!/^[a-z0-9][a-z0-9._-]*\.(?:png|glb|wav)$/.test(name)) {
    throw new Error("invalid Pages preview file name " + name);
  }
  if (!bytes?.length) throw new Error("empty Pages preview " + name);
  await writeIfChanged(path.join(output, name), bytes);
  return media(name);
}

async function png(name, source) {
  const encoded = await executeImageEncodePngOperation(root, {
    inputs: { source },
    parameters: { compressionLevel: 9 },
  });
  return save(name + ".png", await resolveAssetObject(root, createAssetRef(encoded.outputs.output)));
}

async function image(id, source) {
  record(id, { previewUrl: await png(id, source) });
}

async function mesh(id, spec, inputs) {
  const directory = path.join(workspaceRoot, id);
  await mkdir(directory, { recursive: true });
  for (const file of inputs) {
    await writeIfChanged(path.join(directory, file.path), file.bytes);
  }
  const specPath = path.join(directory, "asset.json");
  await writeIfChanged(specPath, Buffer.from(canonicalJson(spec) + "\n"));
  await generateAsset(specPath);
  record(id, { previewUrl: await save(id + ".glb", await readFile(path.join(directory, spec.output.path))) });
}

async function runBlenderObj(id, bytes) {
  const directory = path.join(workspaceRoot, id);
  await mkdir(directory, { recursive: true });
  const source = path.join(directory, "source.obj");
  const destination = path.join(directory, "preview.glb");
  await writeIfChanged(source, bytes);
  const executable = process.env.ASSET_TOOLING_BLENDER ?? "blender";
  const child = Bun.spawn([
    executable, "--background", "--factory-startup",
    "--python", path.join(root, "scripts", "blender-preview-obj.py"),
    "--", source, destination,
  ], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Blender OBJ preview conversion failed for " + id);
  record(id, { previewUrl: await save(id + ".glb", await readFile(destination)) });
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Real GLBs generated from the same validated specs and pinned Blender sources as consumers.
for (const asset of generateMedievalCharacterKit()) {
  await runBlenderObj("medieval." + asset.archetype, asset.bytes);
}
const rocks = await readRockRecipeSource();
for (const [name, parameters] of Object.entries(ROCK_PRESETS)) {
  await mesh("rock." + name, createRockAssetSpec({
    assetId: "preview.rock." + name, parameters, scriptSha256: rocks.sha256, blenderVersion: rocks.blenderVersion,
  }), [{ path: "rock.py", bytes: rocks.bytes }]);
}
const wheat = await readWheatRecipeSource();
for (const [name, parameters] of Object.entries(WHEAT_PRESETS)) {
  await mesh("wheat." + name, createWheatAssetSpec({
    assetId: "preview.wheat." + name, parameters, scriptSha256: wheat.sha256, blenderVersion: wheat.blenderVersion,
  }), [{ path: "wheat.py", bytes: wheat.bytes }]);
}
const corn = await readCornRecipeSource();
for (const [name, parameters] of Object.entries(CORN_PRESETS)) {
  await mesh("corn." + name, createCornAssetSpec({
    assetId: "preview.corn." + name, parameters, scriptSha256: corn.sha256,
    authoringSha256: corn.authoring.sha256, blenderVersion: corn.blenderVersion,
  }), [{ path: "corn.py", bytes: corn.bytes }, { path: "wheat.py", bytes: corn.authoring.bytes }]);
}
const grass = await readGrassRecipeSource();
for (const [name, parameters] of Object.entries(GRASS_PRESETS)) {
  await mesh("grass." + name, createGrassAssetSpec({
    assetId: "preview.grass." + name, parameters, scriptSha256: grass.sha256,
    authoringSha256: grass.authoring.sha256, blenderVersion: grass.blenderVersion,
  }), [{ path: "grass.py", bytes: grass.bytes }, { path: "wheat.py", bytes: grass.authoring.bytes }]);
}
const fences = await readFenceRecipeSource();
for (const [name, parameters] of Object.entries(FENCE_PRESETS)) {
  await mesh("fence." + name, createFenceAssetSpec({
    assetId: "preview.fence." + name, parameters, scriptSha256: fences.sha256, blenderVersion: fences.blenderVersion,
  }), [{ path: "fence.py", bytes: fences.bytes }]);
}
const trees = await readTreeRecipeSource();
const saplingPath = process.env.ASSET_TOOLING_SAPLING_ARCHIVE;
if (!saplingPath) throw new Error("ASSET_TOOLING_SAPLING_ARCHIVE must point to the pinned Sapling input");
const sapling = await readFile(saplingPath);
if (sapling.length !== SAPLING_TREE_SOURCE.byteLength || sha256Bytes(sapling) !== SAPLING_TREE_SOURCE.sha256) {
  throw new Error("Sapling archive does not match the declared pin");
}
for (const [name, parameters] of Object.entries(TREE_PRESETS)) {
  await mesh("tree." + name, createTreeAssetSpec({
    assetId: "preview.tree." + name, parameters, scriptSha256: trees.sha256, blenderVersion: trees.blenderVersion,
  }), [{ path: "tree.py", bytes: trees.bytes }, { path: "sapling.zip", bytes: sapling }]);
}

// Images use the existing procedural operations and the declared FFmpeg PNG encoder.
for (const [name, recipe] of Object.entries(SURFACE_TEXTURE_PRESETS)) {
  const result = await executeSurfaceTextureRecipe(root, recipe, { channels: ["color"] });
  await image("surface." + name, result.outputs.color);
}
const moisture = await executeSurfaceAppearanceFamily(root, SURFACE_APPEARANCE_PRESETS.soilMoisture);
for (const state of moisture.states) {
  await image("surface.soil-moisture." + state.id, state.outputs.color);
}
for (const [name, parameters] of Object.entries(LEAF_ARTWORK_PRESETS)) {
  const result = await executeLeafArtworkRecipe(root, parameters);
  await image("leaf." + name, result.outputs.image);
}
for (const [shape, variants] of Object.entries(EFFECT_ARTWORK_PRESETS)) {
  for (const [variant, parameters] of Object.entries(variants)) {
    const result = await executeEffectArtwork(root, { parameters });
    await image("effect-artwork." + shape + "." + variant, createAssetRef(result.outputs.image));
  }
}
for (const [shape, variants] of Object.entries(AUTHORED_EFFECT_SEQUENCE_PRESETS)) {
  for (const [variant, parameters] of Object.entries(variants)) {
    const id = "effect-sequence." + shape + "." + variant;
    const result = await executeAuthoredEffectSequenceRecipe(root, parameters);
    const members = [];
    for (const frame of result.frames) {
      members.push({
        title: "Frame " + (frame.frame.index + 1) + " · " + frame.frame.timeMs + " ms",
        mediaType: "image/png",
        url: await png(id + ".frame-" + String(frame.frame.index).padStart(3, "0"), frame.image),
      });
    }
    record(id, { previewMembers: members });
  }
}
for (const preset of Object.values(FEEDBACK_KIT_PRESETS)) {
  const id = "feedback." + preset.kit;
  const result = await executeFeedbackKitRecipe(root, preset);
  const members = [];
  for (const intensity of ["strong", "subtle"]) {
    const variant = result.manifest.variants[intensity];
    members.push({
      title: intensity + " · visual",
      mediaType: "image/png",
      url: await png(id + "." + intensity, variant.visual.reducedMotion.image),
    });
    members.push({
      title: intensity + " · sound",
      mediaType: "audio/wav",
      url: await save(id + "." + intensity + ".wav", await resolveAssetObject(root, variant.audio.cue)),
    });
  }
  record(id, { previewMembers: members });
}
const tiles = await executeTransitionTileKit(root, TRANSITION_TILE_PRESET);
const tileSize = TRANSITION_TILE_PRESET.size + 6;
const atlas = await executeSpriteAtlasOperation(root, {
  inputs: { sprites: tiles.tiles.map((tile) => tile.image) },
  parameters: {
    width: 4 * tileSize, maxHeight: 4 * tileSize, padding: 2, extrusion: 1, trim: true,
    sprites: tiles.tiles.map((tile) => ({ id: readTransitionTileConnection(tile.image).id, pivot: { x: 0, y: 0 } })),
  },
});
await image("transition.grass-soil-corners", createAssetRef(atlas.outputs.image));

// Prevent new gallery recipes from silently regressing to generic placeholder icons.
const declared = new Set(createGeneratedGalleryAssets().map((asset) => asset.id));
for (const id of declared) if (!Object.hasOwn(index, id)) throw new Error("Pages preview missing for " + id);
for (const id of Object.keys(index)) if (!declared.has(id)) throw new Error("orphaned Pages preview " + id);
await writeIfChanged(path.join(output, "index.json"), Buffer.from(canonicalJson({
  schemaVersion: 1, assets: index,
}) + "\n"));
console.log(JSON.stringify({ status: "built", previewAssets: declared.size, output: "dist/pages/previews" }));
