import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../src/canonical.js";
import { sha256Text } from "../src/hash.js";
import { createFinishingAssetSpec, normalizeFinishingParameters, readFinishingRecipeSource } from "../src/finishing-recipe.js";
import { parseFinishingRecipeFile } from "../scripts/finish-asset.ts";

const base = { schemaVersion: 1, source: { format: "gltf" }, policy: { maxTriangles: 1000 } };
const pin = "a".repeat(64);

test("finishing parameters normalise defaults and reject invalid input before Blender", () => {
  assert.deepEqual(normalizeFinishingParameters(base), {
    schemaVersion: 1, source: { format: "gltf" }, edits: { scale: [1, 1, 1], materials: {} }, repairs: [], policy: { maxTriangles: 1000 },
  });
  const blend = normalizeFinishingParameters({ ...base, source: { format: "blend", collection: "outpost.door" }, repairs: ["uv-unwrap", "bake-ao"],
    edits: { scale: [1, 1.2, 1], materials: { wood: { roughness: .8, baseColor: [.2, .1, .05, 1] } } } });
  assert.deepEqual(blend.edits.materials, { wood: { baseColor: [.2, .1, .05, 1], roughness: .8 } });
  for (const invalid of [
    null, [], { ...base, schemaVersion: 2 }, { ...base, extra: true }, { ...base, policy: undefined },
    { ...base, source: { format: "fbx" } }, { ...base, source: { format: "gltf", collection: "x" } }, { ...base, source: { format: "blend" } },
    { ...base, edits: { scale: [1, 1] } }, { ...base, edits: { scale: [1, 0, 1] } }, { ...base, edits: { scale: [1, Infinity, 1] } },
    { ...base, edits: { materials: { wood: {} } } }, { ...base, edits: { materials: { wood: { baseColor: [1, 1, 1] } } } },
    { ...base, edits: { materials: { wood: { roughness: 2 } } } }, { ...base, edits: { materials: { wood: { tint: 1 } } } },
    { ...base, repairs: ["subdivide"] }, { ...base, repairs: ["weighted-normals", "weighted-normals"] }, { ...base, repairs: ["bake-ao", "uv-unwrap"] },
    { ...base, policy: { maxTriangles: 0 } }, { ...base, policy: { maxTriangles: 1.5 } }, { ...base, policy: { maxTriangles: 10, extra: 1 } },
  ]) assert.throws(() => normalizeFinishingParameters(invalid), undefined, JSON.stringify(invalid));
});

test("a finishing spec pins the recipe, source and resources, and every parameter change invalidates it", async () => {
  const recipe = await readFinishingRecipeSource();
  const spec = (parameters: unknown, resources = [{ path: "source/Barrel.bin", sha256: pin }]) => createFinishingAssetSpec({
    assetId: "fixture", parameters, scriptSha256: recipe.sha256, blenderVersion: recipe.blenderVersion,
    source: { path: "source/Barrel.gltf", sha256: pin }, resources,
  });
  const first = spec(base);
  assert.deepEqual(first.inputs, {
    script: { path: "finish.py", sha256: recipe.sha256 }, source: { path: "source/Barrel.gltf", sha256: pin }, "resource-0": { path: "source/Barrel.bin", sha256: pin },
  });
  assert.equal(first.reproducibility.expected, "exact");
  assert.equal(spec({ ...base, repairs: ["uv-unwrap", "bake-ao"] }).reproducibility.expected, "approximate");
  const hash = (value: unknown) => sha256Text(canonicalJson(value));
  assert.equal(hash(spec(base)), hash(first));
  for (const change of [{ edits: { scale: [1, 1.2, 1] } }, { edits: { materials: { wood: { metallic: 0 } } } }, { repairs: ["merge-by-distance"] }, { policy: { maxTriangles: 999 } }]) {
    assert.notEqual(hash(spec({ ...base, ...change })), hash(first), JSON.stringify(change));
  }
  assert.throws(() => spec(base, [{ path: "source/Barrel.gltf", sha256: pin }]), /declared twice/);
  assert.throws(() => spec(base, [{ path: "../escape.bin", sha256: pin }]), /portable/);
});

test("the committed finishing recipes parse and declare valid parameters", async () => {
  for (const file of ["starter-barrel", "outpost-door"]) {
    const recipe = parseFinishingRecipeFile(JSON.parse(await readFile(new URL(`../examples/finishing/${file}.finish.json`, import.meta.url), "utf8")));
    assert.equal(recipe.name, file);
    normalizeFinishingParameters(recipe.parameters);
  }
  assert.throws(() => parseFinishingRecipeFile({ schema: "finish-recipe-v1", assetId: "x", source: { authored: "a.blend" }, resources: {}, parameters: base }), /resources/);
  assert.throws(() => parseFinishingRecipeFile({ schema: "finish-recipe-v2" }), /schema/);
});
