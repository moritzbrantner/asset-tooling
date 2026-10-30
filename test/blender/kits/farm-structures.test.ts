// Toy-like My Farm Farmhouse and Silo (#353, docs/farm-structures.md): the scripted Blender recipe builds a
// verified static-glb-png-v1 package whose structures stand on the ground at their footprint centre, stay
// within the owner's ~40 % visual allowance and replay to the same tar. The build skips unless
// ASSET_TOOLING_BLENDER names Blender 5.2.2 (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { readAssetBundleAsset, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  FARM_DESCRIPTOR_SCHEMA, FARM_GAMEPLAY_FOOTPRINT, FARM_MAX_VISUAL_SCALE, FARM_RELEASE, FARM_STRUCTURES, FARM_STRUCTURE_VARIANT,
  buildFarmStructures, createFarmStructureAssetSpec, farmMeshKey,
} from "../../../scripts/build-farm-structures.ts";

const schemaUrl = new URL("../../../schemas/farm-structures-descriptor-v1.schema.json", import.meta.url);

/** The subset of JSON Schema the descriptor schema uses: const, enum, type, pattern, required, additionalProperties, items, $ref. */
function conforms(schema: any, value: any, root: any, at = "$"): string[] {
  if (schema.$ref) return conforms(root.$defs[schema.$ref.split("/").pop()], value, root, at);
  if ("const" in schema) return value === schema.const ? [] : [`${at} is not ${schema.const}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at} is not one of ${schema.enum}`];
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && (schema.type === "number" || Number.isInteger(value)) ? [] : [`${at} is not a ${schema.type}`];
  if (schema.type === "string") return typeof value === "string" && (!schema.pattern || new RegExp(schema.pattern).test(value)) ? [] : [`${at} is not a matching string`];
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${at} is not an array`];
    if ((schema.minItems ?? 0) > value.length || (schema.maxItems ?? Infinity) < value.length) return [`${at} has the wrong length`];
    return value.flatMap((item, i) => conforms(schema.items, item, root, `${at}[${i}]`));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${at} is not an object`];
    const errors = (schema.required ?? []).filter((key: string) => !(key in value)).map((key: string) => `${at}.${key} is missing`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...conforms(schema.properties[key], child, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`);
    }
    return errors;
  }
  return [];
}

test("the farm-structure spec runs the packaged recipe with exactly one structure", () => {
  const spec = createFarmStructureAssetSpec({ part: "silo", scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "silo" } });
  assert.equal(spec.assetId, "farm.silo");
  assert.deepEqual([...FARM_STRUCTURES], ["farmhouse", "silo"]);
  assert.equal(FARM_RELEASE, "farm-structures", "one rolling release, never numbered");
});

test("the farm-structures-descriptor-v1 schema names the descriptor and its keys", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.schema.const, FARM_DESCRIPTOR_SCHEMA);
  const key = new RegExp(schema.$defs.asset.properties.key.pattern);
  for (const part of FARM_STRUCTURES) assert.ok(key.test(farmMeshKey(part)), part);
  assert.ok(conforms(schema, { schema: FARM_DESCRIPTOR_SCHEMA }, schema).length > 0, "an incomplete descriptor is rejected");
});

test("the farm recipe builds a verified, reproducible package of grounded, generously sized toy structures", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 600_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "farm-structures-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "farm-structures-replay-"));
  try {
    const built = await buildFarmStructures({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef);
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), FARM_STRUCTURES.map(farmMeshKey).sort());
    for (const part of FARM_STRUCTURES) {
      const glb = await readAssetBundleAsset(built.bundleDir, manifest, farmMeshKey(part), FARM_STRUCTURE_VARIANT);
      assert.equal(Buffer.from(glb).toString("ascii", 0, 4), "glTF", `${part} is a self-contained GLB`);
    }

    const d = JSON.parse(await readFile(built.descriptorPath, "utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, d, schema), []);
    for (const asset of d.assets) {
      const footprint = FARM_GAMEPLAY_FOOTPRINT[asset.role as keyof typeof FARM_GAMEPLAY_FOOTPRINT];
      assert.deepEqual(asset.gameplayFootprint, footprint);
      // Standing on the ground at the footprint's centre ...
      assert.equal(asset.bounds.min[1], 0, `${asset.role} stands on y = 0`);
      for (const k of [0, 2]) assert.ok(Math.abs(asset.bounds.min[k] + asset.bounds.max[k]) < 0.15, `${asset.role} is centred on the footprint`);
      // ... chunky (at least the footprint's 80 %) but within the owner's ~40 % allowance.
      for (const [size, tiles] of [[asset.visual.width, footprint.width], [asset.visual.depth, footprint.depth]] as const) {
        assert.ok(size <= tiles * FARM_MAX_VISUAL_SCALE + 1e-6, `${asset.role} ${size} m exceeds ${FARM_MAX_VISUAL_SCALE} x ${tiles}`);
        assert.ok(size >= tiles * 0.8, `${asset.role} ${size} m is too small for ${tiles} tiles`);
      }
      assert.ok(asset.triangles < 12_000, `${asset.role} stays a light toy mesh`);
    }
    const silo = d.assets.find((a: any) => a.role === "silo"), house = d.assets.find((a: any) => a.role === "farmhouse");
    assert.ok(silo.visual.height > house.visual.height, "the silo is the taller landmark");
    // Saturated red walls and a dark roof on the farmhouse.
    const materials = Object.fromEntries(built.documents.farmhouse.getRoot().listMaterials().map((m) => [m.getName(), m.getBaseColorFactor()]));
    assert.ok(materials["farm-red"]![0]! > 0.6 && materials["farm-red"]![1]! < 0.05, "red walls");
    assert.ok(Math.max(...materials["farm-roof"]!.slice(0, 3)) < 0.1, "dark roof");

    const replay = await buildFarmStructures({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
