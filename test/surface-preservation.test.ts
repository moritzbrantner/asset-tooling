import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assetObjectPortablePath, resolveAssetObject } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetRef, type AssetRef } from "../src/operations.js";
import { parseRgba8Image } from "../src/image-rgba8.js";
import { executeSurfaceTextureRecipe, executePreservedSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS,
  type SurfaceChannel, type SurfaceTexturePreservation } from "../src/surface-texture-recipes.js";

type SurfaceBuild = Awaited<ReturnType<typeof executeSurfaceTextureRecipe>>;
const recipe = { ...SURFACE_TEXTURE_PRESETS["rock-grainy"], width: 17, height: 13,
  gridX: 4, gridY: 3, detailGridX: 12, detailGridY: 10 };
const palette = { ...recipe, low: [75, 28, 12], high: [215, 178, 119] };
async function workspace(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "surface-preserve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function locks(result: SurfaceBuild, channels: SurfaceChannel[]): SurfaceTexturePreservation {
  return Object.fromEntries(channels.map(channel => {
    const field = channel === "color" ? "base-color" : channel;
    const step = result.steps.find(s => s.output.metadata.field === field);
    assert.ok(step); return [channel, step];
  }));
}
function canonicalResult(result: Awaited<ReturnType<typeof executePreservedSurfaceTextureRecipe>>) {
  const { execution: _execution, ...output } = result;
  return output;
}
async function inventory(root: string, anchor: AssetRef) {
  const directory = path.dirname(path.dirname(path.join(root, assetObjectPortablePath(anchor))));
  const entries = [];
  for (const prefix of await readdir(directory)) for (const name of await readdir(path.join(directory,prefix))) {
    const file = path.join(directory,prefix,name), info = await stat(file);
    entries.push([`${prefix}/${name}`, info.size, info.mtimeMs]);
  }
  return entries.sort((a,b) => String(a[0]).localeCompare(String(b[0])));
}

test("palette-only edit reuses accepted scalar/normal components and equals a full cold rebuild", async t => {
  const root = await workspace(t), cold = await workspace(t);
  const accepted = await executeSurfaceTextureRecipe(root,recipe), before = await inventory(root,accepted.outputs.height!);
  const result = await executePreservedSurfaceTextureRecipe(root,palette,{ preserve: locks(accepted,["height","normal","roughness"]) });
  assert.deepEqual(canonicalResult(result), await executeSurfaceTextureRecipe(cold,palette));
  assert.deepEqual(result.execution.stages.map(s => [s.channel,s.status]), [["height","reused"],["color","executed"],["normal","reused"],["roughness","reused"]]);
  assert.equal(result.execution.executedOperations,1); assert.equal(result.execution.reusedOperations,5);
  assert.equal(result.execution.imagePixelsGenerated,17*13);
  const after = await inventory(root,accepted.outputs.height!);
  for (const entry of before) assert.deepEqual(after.find(x => x[0] === entry[0]),entry);
  assert.equal(after.length-before.length,1);
  const pixels = parseRgba8Image(await resolveAssetObject(root,result.outputs.color!)).pixels;
  for (let offset=3;offset<pixels.length;offset+=4) assert.equal(pixels[offset],255);
});

test("preserved height does not secretly replay its noise operations", async t => {
  const root = await workspace(t);
  const accepted = await executeSurfaceTextureRecipe(root,recipe);
  const components = accepted.steps[0]!.observations.components;
  assert.ok(Array.isArray(components));
  for (const component of components) {
    assert.ok(component && typeof component === "object" && !Array.isArray(component));
    const file = path.join(root,assetObjectPortablePath(createAssetRef(component.output)));
    await rm(file); await mkdir(file); // A recomputed noise output cannot be stored here.
  }
  const partial = await executePreservedSurfaceTextureRecipe(root,palette,{ preserve: locks(accepted,["height","normal","roughness"]) });
  assert.equal(partial.execution.executedOperations,1);
  await assert.rejects(executeSurfaceTextureRecipe(root,palette), /regular file|directory|EISDIR/);
});

test("explicit locks reject changed dependencies and corruption before any channel is emitted", async t => {
  const root = await workspace(t), accepted = await executeSurfaceTextureRecipe(root,recipe);
  const preserved = locks(accepted,["height","normal","roughness"]), before = await inventory(root,accepted.outputs.height!);
  for (const changed of [{ seed: "43" }, { detailWeight: 40 }, { normalStrength: 17 }, { roughnessMin: 3 }]) {
    await assert.rejects(executePreservedSurfaceTextureRecipe(root,{...palette,...changed},{preserve:preserved}),/does not match current dependencies/);
    assert.deepEqual(await inventory(root,accepted.outputs.height!),before);
  }
  for (const metadata of [{ normalYAxis: "positive" }, { width: 1 }, { sourceSha256: "0".repeat(64) }]) {
    const normal = preserved.normal!;
    await assert.rejects(executePreservedSurfaceTextureRecipe(root,palette,{preserve:{...preserved,
      normal:{...normal,output:createAssetRef({...normal.output,metadata:{...normal.output.metadata,...metadata}})} }}),/metadata/);
    assert.deepEqual(await inventory(root,accepted.outputs.height!),before);
  }
  const normalFile = path.join(root,assetObjectPortablePath(accepted.outputs.normal!));
  await writeFile(normalFile,"corrupt");
  const corruptInventory = await inventory(root,accepted.outputs.height!);
  await assert.rejects(executePreservedSurfaceTextureRecipe(root,palette,{preserve:preserved}),/mismatch/);
  assert.deepEqual(await inventory(root,accepted.outputs.height!),corruptInventory);
});

test("normal edits, restarted snapshots, reorder, selection and undo reproduce clean canonical results", async t => {
  const root = await workspace(t), cold = await workspace(t);
  const accepted = await executeSurfaceTextureRecipe(root,recipe);
  const snapshot = path.join(root,"accepted.json"); await writeFile(snapshot,canonicalJson(accepted));
  const restored: SurfaceBuild = JSON.parse(await readFile(snapshot,"utf8"));
  const edits = [palette, { ...palette, normalStrength: 17 }, recipe];
  let previous = restored;
  for (const edit of edits) {
    const preserve = locks(previous,["height","roughness"]);
    const result = await executePreservedSurfaceTextureRecipe(root,edit,{ channels: ["roughness","normal","height","color"], preserve });
    assert.deepEqual(canonicalResult(result),await executeSurfaceTextureRecipe(cold,edit));
    previous = canonicalResult(result);
  }
  assert.deepEqual(previous,restored);
  const changedNormal = await executePreservedSurfaceTextureRecipe(root,{...recipe,normalStrength:17},{ preserve:locks(accepted,["height","color","roughness"]) });
  assert.equal(changedNormal.execution.executedOperations,1);
  assert.deepEqual(changedNormal.outputs.color,accepted.outputs.color);
  assert.notEqual(changedNormal.outputs.normal!.sha256,accepted.outputs.normal!.sha256);
  const selected = await executePreservedSurfaceTextureRecipe(root,palette,{channels:["color"],preserve:locks(accepted,["height"])});
  assert.deepEqual(canonicalResult(selected),await executeSurfaceTextureRecipe(cold,palette,{channels:["color"]}));
  await assert.rejects(executePreservedSurfaceTextureRecipe(root,palette,{channels:["color"],preserve:locks(accepted,["height","normal"])}),/unselected/);
  await assert.rejects(executePreservedSurfaceTextureRecipe(root,palette,{preserve:locks(accepted,["normal"])}),/require a preserved height/);
});

test("persisted locks cannot alter source lineage or append unowned output metadata", async t => {
  const root = await workspace(t), accepted = await executeSurfaceTextureRecipe(root,recipe);
  const before = await inventory(root,accepted.outputs.height!);
  const height = locks(accepted,["height"]).height!;
  for (const metadata of [{sourceSha256s:["0".repeat(64)]}, {inventedLineage:"false-source"}, {tileable:false}]) {
    const changed = {...height,output:createAssetRef({...height.output,metadata:{...height.output.metadata,...metadata}})};
    await assert.rejects(executePreservedSurfaceTextureRecipe(root,palette,{preserve:{height:changed}}),/metadata/);
    assert.deepEqual(await inventory(root,accepted.outputs.height!),before);
  }
  const normal = locks(accepted,["normal"]).normal!;
  await assert.rejects(executePreservedSurfaceTextureRecipe(root,palette,{preserve:{height,
    normal:{...normal,output:createAssetRef({...normal.output,metadata:{...normal.output.metadata,inventedLineage:"false-source"}})} }}),/metadata/);
  await assert.rejects(executePreservedSurfaceTextureRecipe(root,palette,{preserve:{height:{...height,
    observations:{...height.observations,parameters:{...height.build.parameters,seed:"43"}}}}}),/observations/);
  assert.deepEqual(await inventory(root,accepted.outputs.height!),before);
});
