// Undead crypt environment kit (#269, docs/crypt-kit.md): the scripted Blender recipe builds a verified
// gltf-resources-v1 bundle whose modules sit on the 2 m grid, whose doorways stay open, whose door fits its
// doorway on the hinge, and whose stone textures are stored once. The build skips unless
// ASSET_TOOLING_BLENDER names Blender 5.2.2 (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { CRYPT_DESCRIPTOR_ATTACHMENT, CRYPT_DESCRIPTOR_SCHEMA, CRYPT_PARTS, CRYPT_RELEASE, buildCryptKit, createCryptAssetSpec, cryptKey } from "../../../scripts/build-crypt-kit.ts";

type Box = { min: number[]; max: number[] };
const overlaps = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - epsilon && b.min[k]! < a.max[k]! - epsilon);
const inside = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! >= b.min[k]! - epsilon && a.max[k]! <= b.max[k]! + epsilon);
const proxyBox = (p: { center: number[]; size: number[] }): Box => ({ min: p.center.map((c, k) => c - p.size[k]! / 2), max: p.center.map((c, k) => c + p.size[k]! / 2) });
const schemaUrl = new URL("../../../schemas/crypt-kit-descriptor-v1.schema.json", import.meta.url);

/** The subset of JSON Schema the descriptor schema uses: const, enum, type, required, additionalProperties, items, $ref. */
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

test("the crypt spec runs the packaged recipe with exactly one module", () => {
  const spec = createCryptAssetSpec({ part: "door", scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "door" } });
  assert.equal(spec.assetId, "crypt.kit.door");
  assert.deepEqual([...CRYPT_PARTS], ["wall", "doorway-narrow", "doorway-wide", "door", "floor", "pillar", "sarcophagus", "candles", "bones"]);
  assert.equal(CRYPT_RELEASE, "crypt-kit", "one rolling release, never numbered");
});

test("the crypt-kit-descriptor-v1 schema names the descriptor and its keys", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.schema.const, CRYPT_DESCRIPTOR_SCHEMA);
  const key = new RegExp(schema.$defs.asset.properties.key.pattern);
  for (const part of CRYPT_PARTS) assert.ok(key.test(cryptKey(part)), part);
  assert.deepEqual(conforms(schema, { schema: "crypt-kit-descriptor-v1" }, schema).length > 0, true, "an incomplete descriptor is rejected");
});

test("the crypt recipe builds a verified bundle on the 2 m grid with open doorways, a fitting door and shared stone textures", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "crypt-kit-"));
  try {
    const built = await buildCryptKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), CRYPT_PARTS.map(cryptKey).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "crypt.kit.wall", "default", CRYPT_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, d, schema), []);
    const asset = Object.fromEntries(d.assets.map((a: any) => [a.role, a]));

    // Three stone and three wood PNGs, each stored once for every module that uses it.
    const pngs = (await readdir(path.join(built.bundleDir, "resources"))).filter((name) => name.endsWith(".png"));
    assert.equal(pngs.length, 6);

    // Walls and doorways fill their module, 3 m high and 0.5 m thick; the floor's top is y = 0.
    for (const [part, width] of [["wall", 2], ["doorway-narrow", 2], ["doorway-wide", 4]] as const) {
      const a = asset[part];
      assert.deepEqual(a.module, { width, height: 3, depth: 0.5 });
      assert.ok(Math.abs(a.footprint.width - width) < 0.02 && a.bounds.max[1] <= 3 && a.bounds.max[1] > 2.98, `${part} fills its module`);
    }
    assert.ok(asset.floor.bounds.max[1] <= 0 && asset.floor.bounds.max[1] > -0.02 && Math.abs(asset.floor.footprint.width - 2) < 0.02);

    // No collision proxy and no doorway vertex reaches into the opening.
    for (const [part, width, height] of [["doorway-narrow", 1, 2.2], ["doorway-wide", 2, 2.6]] as const) {
      const doorway = asset[part].doorway;
      assert.equal(doorway.width, width);
      assert.equal(doorway.height, height);
      const opening: Box = { min: doorway.min, max: doorway.max };
      for (const p of asset[part].collisionProxies) assert.ok(!overlaps(proxyBox(p), opening), `${part} ${p.name} stays out of the doorway`);
      const document = built.documents[part];
      for (const node of document.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        const position = primitive.getAttribute("POSITION")!, v: number[] = [0, 0, 0];
        for (let i = 0; i < position.getCount(); i += 1) {
          position.getElement(i, v);
          assert.ok(!overlaps({ min: v, max: v }, { min: [opening.min[0]! + 1e-4, 1e-4, -0.3], max: [opening.max[0]! - 1e-4, opening.max[1]! - 1e-4, 0.3] }, -1e-9), `${part} vertex ${v} is inside the opening`);
        }
      }
    }

    // The door hangs on its hinge and, mounted closed, fits inside the narrow doorway.
    assert.equal(asset.door.hinge.node, "hinge");
    assert.deepEqual(asset.door.mount.parent, "crypt.kit.doorway-narrow");
    const t = asset.door.mount.translation;
    const leaf: Box = { min: asset.door.bounds.min.map((c: number, k: number) => c + t[k]), max: asset.door.bounds.max.map((c: number, k: number) => c + t[k]) };
    const narrow = asset["doorway-narrow"].doorway;
    // Only the hinge knuckles, on the hinge side, reach a few centimetres into the jamb.
    assert.ok(inside({ min: [leaf.min[0]! + 0.05, leaf.min[1]!, 0], max: [leaf.max[0]!, leaf.max[1]!, 0] }, { min: narrow.min, max: narrow.max }), "closed door fits the doorway");
    assert.ok(leaf.max[0]! < narrow.max[0] && leaf.min[1]! > 0 && leaf.max[1]! < narrow.max[1], "the leaf clears the latch jamb, the floor and the lintel");
    assert.deepEqual(asset.door.collisionProxies.map((p: any) => p.tag), ["dynamic-door"]);

    assert.equal(asset.candles.lights.length, 6);
    assert.deepEqual(asset.candles.collisionProxies, []);
    for (const part of ["pillar", "sarcophagus", "floor", "wall"]) assert.equal(asset[part].collisionProxies.length, 1, part);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
