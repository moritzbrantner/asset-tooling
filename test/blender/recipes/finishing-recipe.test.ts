// The reusable finishing recipe (#120, docs/finishing-recipe.md) on two real editable sources: the #118 starter
// barrel (a catalog glTF with its textures) and the outpost door (a first-party authored .blend collection).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { NodeIO } from "@gltf-transform/core";
import { finishRecipeFile } from "../../../scripts/finish-asset.ts";
import { finishAsset } from "../../../src/finishing-recipe.js";
import { sha256Bytes } from "../../../src/hash.js";

const blender = process.env.ASSET_TOOLING_BLENDER;
const skip = !process.env.BLENDER_TESTS || !blender;
const REPO = new URL("../../../", import.meta.url);
type Json = Record<string, any>;

async function recipe(name: string, change: (value: Json) => void = () => {}) {
  const value = JSON.parse(await readFile(new URL(`examples/finishing/${name}.finish.json`, REPO), "utf8"));
  change(value);
  return value as Json;
}

async function withRecipe(dir: string, value: Json) {
  const file = path.join(dir, `${value.name}-${sha256Bytes(Buffer.from(JSON.stringify(value))).slice(0, 8)}.json`);
  await writeFile(file, JSON.stringify(value));
  return file;
}

async function glb(file: string) {
  return (await new NodeIO().readBinary(new Uint8Array(await readFile(file)))).getRoot();
}

function height(root: Awaited<ReturnType<typeof glb>>) {
  let low = Infinity, high = -Infinity;
  for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute("POSITION")!;
    low = Math.min(low, position.getMin([])[1]!);
    high = Math.max(high, position.getMax([])[1]!);
  }
  return high - low;
}

test("the starter barrel finishes from its catalog source, reuses an unchanged build and rebuilds on a dimension edit", { skip, timeout: 240_000 }, async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "finish-barrel-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const sourceFile = new URL("assets/canonical/quaternius.fantasy-props-megakit-standard.barrel-gltf/Barrel.gltf", REPO);
  const sourceBefore = sha256Bytes(await readFile(sourceFile));
  const file = await withRecipe(out, await recipe("starter-barrel"));

  const first = await finishRecipeFile(file, out);
  assert.equal(first.cache, "miss");
  assert.equal(first.status, "changed");
  const report = JSON.parse(await readFile(path.join(out, "finished/starter-barrel.finish.json"), "utf8"));
  // Lineage: the catalog-pinned source and every resource, the parameters and the Blender recipe identity.
  const storage = JSON.parse(await readFile(new URL("catalog/storage.json", REPO), "utf8"));
  assert.equal(report.source.catalog, "quaternius.fantasy-props-megakit-standard.barrel-gltf");
  assert.equal(report.source.sha256, sourceBefore);
  assert.equal(report.resources.length, 7);
  assert.ok(storage.entries.some((entry: Json) => entry.sourceId === report.source.catalog));
  assert.deepEqual(report.finishing.lostAttributes, []);
  assert.deepEqual(report.finishing.repairs.map((r: Json) => r.repair), ["apply-transforms", "merge-by-distance"]);
  // The importer's split vertices are welded; UVs, vertex colours and materials survive.
  const [before] = report.finishing.before.meshes, [after] = report.finishing.after.meshes;
  assert.ok(after.topology.boundaryEdges < before.topology.boundaryEdges);
  assert.deepEqual(after.attributes, before.attributes);
  assert.deepEqual(after.materials, ["MI_Trim_Furniture", "MI_Trim_Metal"]);
  assert.equal(report.productionImport.accepted, true);
  const finished = await glb(path.join(out, "finished/starter-barrel.glb"));
  assert.deepEqual(finished.listMaterials().map((m) => m.getName()).sort(), ["MI_Trim_Furniture", "MI_Trim_Metal"]);
  for (const material of finished.listMaterials()) {
    assert.ok(material.getBaseColorTexture() && material.getNormalTexture() && material.getMetallicRoughnessTexture(), material.getName());
  }
  assert.equal(finished.listNodes().find((node) => !node.getParentNode())?.getName(), "greyhaven.barrel");
  const baseHeight = height(finished);

  // Unchanged-output reuse: the Blender step is a cache hit and nothing is rewritten.
  const promoted = await stat(path.join(out, "finished/starter-barrel.glb"));
  const second = await finishRecipeFile(file, out);
  assert.equal(second.cache, "hit");
  assert.equal(second.status, "unchanged");
  assert.equal(second.glb.sha256, first.glb.sha256);
  assert.equal((await stat(path.join(out, "finished/starter-barrel.glb"))).mtimeMs, promoted.mtimeMs);

  // Parameter invalidation: a deliberate dimension edit rebuilds just this result.
  const taller = await withRecipe(out, await recipe("starter-barrel", (value) => { value.parameters.edits.scale = [1, 1.25, 1]; }));
  const edited = await finishRecipeFile(taller, out);
  assert.equal(edited.cache, "miss");
  assert.notEqual(edited.glb.sha256, first.glb.sha256);
  assert.ok(Math.abs(height(await glb(path.join(out, "finished/starter-barrel.glb"))) - baseHeight * 1.25) < 1e-3);

  // The source/master bytes never change.
  assert.equal(sha256Bytes(await readFile(sourceFile)), sourceBefore);
});

test("the outpost door finishes from its authored .blend with a material edit; failures promote nothing", { skip, timeout: 240_000 }, async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "finish-door-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const blend = new URL("assets/authored/outpost-kit.blend", REPO);
  const blendBefore = sha256Bytes(await readFile(blend));
  const wood = [.25, .12, .05, 1];
  const file = await withRecipe(out, await recipe("outpost-door", (value) => { value.parameters.edits.materials = { "outpost-wood": { baseColor: wood, roughness: .7 } }; }));
  await finishRecipeFile(file, out);
  const glbFile = path.join(out, "finished/outpost-door.glb"), reportFile = path.join(out, "finished/outpost-door.finish.json");
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(report.source.authored, "assets/authored/outpost-kit.blend");
  assert.equal(report.source.sha256, blendBefore);
  assert.deepEqual(report.finishing.lostAttributes, []);
  assert.deepEqual(report.finishing.after.meshes[0].attributes.uvLayers, ["UVMap"]);
  const door = await glb(glbFile);
  assert.deepEqual(door.listMaterials().map((m) => m.getName()).sort(), ["outpost-iron", "outpost-soot", "outpost-wood"]);
  const material = door.listMaterials().find((m) => m.getName() === "outpost-wood")!;
  material.getBaseColorFactor().forEach((channel, i) => assert.ok(Math.abs(channel - wood[i]!) < 1e-4));
  assert.ok(Math.abs(material.getRoughnessFactor() - .7) < 1e-4);
  const promoted = { glb: await readFile(glbFile), report: await readFile(reportFile) };

  // Each failure throws and leaves the promoted result byte for byte as it was.
  const failures: [string, (value: Json) => void, RegExp][] = [
    ["unknown material edit", (v) => { v.parameters.edits.materials = { "outpost-gold": { metallic: 1 } }; }, /does not have/],
    ["triangle budget", (v) => { v.parameters.policy.maxTriangles = 10; }, /exceed policy.maxTriangles/],
    ["uv-unwrap over authored UVs", (v) => { v.parameters.repairs = ["uv-unwrap"]; }, /already has UV layers/],
    ["missing collection", (v) => { v.parameters.source.collection = "outpost.gate"; }, /has no collection/],
  ];
  for (const [label, change, message] of failures) {
    await assert.rejects(finishRecipeFile(await withRecipe(out, await recipe("outpost-door", change)), out), message, label);
    assert.deepEqual(await readFile(glbFile), promoted.glb, label);
    assert.deepEqual(await readFile(reportFile), promoted.report, label);
  }
  assert.equal(sha256Bytes(await readFile(blend)), blendBefore);
});

test("an undeclared glTF resource is rejected before Blender reads it", { skip, timeout: 120_000 }, async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "finish-closure-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const file = await withRecipe(out, await recipe("starter-barrel", (value) => { delete value.resources["T_Trim_Metal_ORM.png"]; }));
  await assert.rejects(finishRecipeFile(file, out), /'T_Trim_Metal_ORM.png' is not a declared input/);
  await assert.rejects(stat(path.join(out, "finished/starter-barrel.glb")), /ENOENT/);
});

test("uv-unwrap and bake-ao finish an unwrapped mesh and bind the baked occlusion", { skip, timeout: 240_000 }, async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), "finish-bake-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  // A fixture .blend: a crate-like box with a lid and no UVs, in collection "fixture".
  const fixture = path.join(out, "fixture.blend");
  const program = `import bpy, sys
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
collection = bpy.data.collections.new("fixture"); bpy.context.scene.collection.children.link(collection)
material = bpy.data.materials.new("fixture-wood"); material.use_nodes = True
for location, size in (((0, 0, .4), .8), ((0, 0, .85), .5)):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.object
    for c in obj.users_collection: c.objects.unlink(obj)
    collection.objects.link(obj)
    while obj.data.uv_layers: obj.data.uv_layers.remove(obj.data.uv_layers[0])
bpy.ops.object.select_all(action="SELECT")
objs = list(collection.objects); bpy.context.view_layer.objects.active = objs[0]; bpy.ops.object.join()
objs[0].data.materials.append(material)
bpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])`;
  const run = spawnSync(blender!, ["--background", "--factory-startup", "--python-exit-code", "1", "--python-expr", program, "--", fixture], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const bytes = new Uint8Array(await readFile(fixture));
  const parameters = { schemaVersion: 1, source: { format: "blend", collection: "fixture" }, repairs: ["uv-unwrap", "bake-ao"], policy: { maxTriangles: 100 } };
  const result = await finishAsset(out, { name: "fixture", assetId: "fixture.baked", workspace: path.join(out, "work"), publish: path.join(out, "finished"), parameters, source: { path: "source/fixture.blend", bytes } });
  const repairs = (result.report.finishing as Json).repairs as Json[];
  assert.deepEqual(repairs.map((r) => r.repair), ["uv-unwrap", "bake-ao"]);
  const root = await glb(path.join(out, "finished/fixture.glb"));
  const [material] = root.listMaterials();
  assert.equal(material!.getName(), "fixture-wood");
  assert.ok(material!.getOcclusionTexture(), "the baked AO is bound as the occlusion texture");
  assert.deepEqual(((result.report.finishing as Json).after.meshes[0].attributes.uvLayers), ["UVMap"]);
  // The editable source stays unwrapped: finishing never saves it.
  assert.deepEqual(new Uint8Array(await readFile(path.join(out, "work/source/fixture.blend"))), bytes);
});
