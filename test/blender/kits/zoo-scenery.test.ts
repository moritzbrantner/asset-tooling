// Toy-style, flat-colour Zoo scenery (#357, docs/zoo-scenery.md): the scripted Blender recipe builds a verified
// static-glb-png-v1 package of untextured pieces that stand on the ground at their footprint centre, fit one
// 1 m tile, stay light for instancing and replay to the same tar. The build skips unless
// ASSET_TOOLING_BLENDER names Blender 5.2.2 (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { readAssetBundleAsset, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  ZOO_DESCRIPTOR_SCHEMA, ZOO_FOOTPRINT, ZOO_RELEASE, ZOO_SCENERY_PIECES, buildZooScenery, createZooSceneryAssetSpec, zooMeshKey,
} from "../../../scripts/build-zoo-scenery.ts";

const schemaUrl = new URL("../../../schemas/zoo-scenery-descriptor-v1.schema.json", import.meta.url);

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

test("the zoo-scenery spec runs the packaged recipe with exactly one piece", () => {
  const spec = createZooSceneryAssetSpec({ piece: { kind: "tree", variant: "pine" }, scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, kind: "tree", variant: "pine" } });
  assert.equal(spec.assetId, "zoo.tree.pine");
  assert.deepEqual([...new Set(ZOO_SCENERY_PIECES.map((p) => zooMeshKey(p.kind)))].sort(), ["bush.mesh", "grass.mesh", "rock.mesh", "tree.mesh"]);
  assert.equal(ZOO_RELEASE, "zoo-scenery", "one rolling release, never numbered");
});

test("the zoo-scenery-descriptor-v1 schema names the descriptor and its keys", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.schema.const, ZOO_DESCRIPTOR_SCHEMA);
  const key = new RegExp(schema.$defs.asset.properties.key.pattern);
  for (const piece of ZOO_SCENERY_PIECES) assert.ok(key.test(zooMeshKey(piece.kind)), piece.kind);
  assert.ok(conforms(schema, { schema: ZOO_DESCRIPTOR_SCHEMA }, schema).length > 0, "an incomplete descriptor is rejected");
});

test("the zoo recipe builds a verified, reproducible package of grounded, untextured, tile-sized toy scenery", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 600_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "zoo-scenery-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "zoo-scenery-replay-"));
  try {
    const built = await buildZooScenery({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef);
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(), ZOO_SCENERY_PIECES.map((p) => `${zooMeshKey(p.kind)}/${p.variant}`).sort());
    for (const piece of ZOO_SCENERY_PIECES) {
      const glb = await readAssetBundleAsset(built.bundleDir, manifest, zooMeshKey(piece.kind), piece.variant);
      assert.equal(Buffer.from(glb).toString("ascii", 0, 4), "glTF", `${piece.kind}/${piece.variant} is a self-contained GLB`);
    }
    // Untextured, factor-only, opaque: what 3d-lab's static-glb adapter takes as it is.
    for (const [id, document] of Object.entries(built.documents)) {
      const root = document.getRoot();
      assert.equal(root.listTextures().length, 0, `${id} has no textures`);
      assert.equal(root.listSkins().length + root.listAnimations().length, 0, `${id} has no skins or animations`);
      for (const material of root.listMaterials()) assert.equal(material.getAlphaMode(), "OPAQUE", `${id} ${material.getName()} is opaque`);
      for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) assert.equal(primitive.listTargets().length, 0, `${id} has no morph targets`);
    }

    const d = JSON.parse(await readFile(built.descriptorPath, "utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, d, schema), []);
    for (const asset of d.assets) {
      const id = `${asset.role}/${asset.variant}`;
      assert.equal(asset.bounds.min[1], 0, `${id} stands on y = 0`);
      for (const k of [0, 2]) assert.ok(Math.abs(asset.bounds.min[k] + asset.bounds.max[k]) < 0.15, `${id} is centred on the footprint`);
      // Only the acacia's flat crown may overhang its tile, by a little.
      const overhang = id === "tree/acacia" ? 1.2 : 1;
      assert.ok(asset.visual.width <= ZOO_FOOTPRINT.width * overhang && asset.visual.depth <= ZOO_FOOTPRINT.depth * overhang, `${id} fits one tile`);
      assert.ok(asset.visual.width >= (asset.role === "grass" ? 0.2 : 0.5), `${id} is chunky enough to read at the park camera`);
      assert.ok(asset.triangles < 1_000, `${id} stays light for instance batches`);
    }
    const height = (role: string) => Math.min(...d.assets.filter((a: any) => a.role === role).map((a: any) => a.visual.height));
    assert.ok(height("tree") > 1.2 && height("tree") > height("bush") && height("bush") > height("rock") && height("rock") > height("grass"), "trees over bushes over rocks over grass");
    const tuft = d.assets.find((a: any) => a.role === "grass");
    assert.ok(d.assets.every((a: any) => a === tuft || a.triangles > tuft.triangles), "the grass tuft, repeated the most, has the fewest triangles");
    const acacia = d.assets.find((a: any) => a.variant === "acacia");
    assert.ok(acacia.visual.width > acacia.visual.height * 0.75, "the acacia has a wide, flat crown");

    const replay = await buildZooScenery({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
