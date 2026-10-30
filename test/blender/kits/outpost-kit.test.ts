// Greyhaven Outpost building kit (#366, docs/outpost-kit.md): the scripted Blender recipe builds a verified
// gltf-resources-v1 bundle whose wall modules sit on the 2 m grid, whose doorway stays open for the door
// leaf, whose roof modules have a slate variant, whose compositions fill mmorpg's house and smithy
// footprints and whose textures are stored once. The build skips unless ASSET_TOOLING_BLENDER names
// Blender 5.2.2 (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  OUTPOST_DESCRIPTOR_ATTACHMENT, OUTPOST_DESCRIPTOR_SCHEMA, OUTPOST_PARTS, OUTPOST_RELEASE, OUTPOST_ROOF_PARTS, OUTPOST_TRIANGLE_BUDGET,
  buildOutpostKit, createOutpostAssetSpec, outpostKey,
} from "../../../scripts/build-outpost-kit.ts";

type Box = { min: number[]; max: number[] };
const overlaps = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - epsilon && b.min[k]! < a.max[k]! - epsilon);
const proxyBox = (p: { center: number[]; size: number[] }): Box => ({ min: p.center.map((c, k) => c - p.size[k]! / 2), max: p.center.map((c, k) => c + p.size[k]! / 2) });
const schemaUrl = new URL("../../../schemas/outpost-kit-descriptor-v1.schema.json", import.meta.url);

/** The subset of JSON Schema the descriptor schema uses: const, enum, type, required, additionalProperties, items, $ref. */
function conforms(schema: any, value: any, root: any, at = "$"): string[] {
  if (schema.$ref) return conforms(root.$defs[schema.$ref.split("/").pop()], value, root, at);
  if ("const" in schema) return value === schema.const ? [] : [`${at} is not ${schema.const}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at} is not one of ${schema.enum}`];
  if (schema.type === "boolean") return typeof value === "boolean" ? [] : [`${at} is not a boolean`];
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
      else if (typeof schema.additionalProperties === "object") errors.push(...conforms(schema.additionalProperties, child, root, `${at}.${key}`));
    }
    return errors;
  }
  return [];
}

/** Every vertex of a document in its module frame. */
function vertices(document: Document): number[][] {
  const out: number[][] = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!, p: number[] = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        out.push([0, 1, 2].map((k) => m[k]! * p[0]! + m[4 + k]! * p[1]! + m[8 + k]! * p[2]! + m[12 + k]!));
      }
    }
  }
  return out;
}

/** A module-frame point turned by ``yaw`` degrees about +Y and moved by ``t``. */
const place = (p: number[], t: number[], yaw: number) => {
  const a = (yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [p[0]! * c + p[2]! * s + t[0]!, p[1]! + t[1]!, -p[0]! * s + p[2]! * c + t[2]!];
};

test("the outpost spec runs the packaged recipe with exactly one module and an optional roof material", () => {
  const spec = createOutpostAssetSpec({ part: "roof", roof: "slate", scriptSha256: "a".repeat(64), commonSha256: "d".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "roof", roof: "slate" } });
  assert.equal(spec.assetId, "outpost.kit.roof");
  assert.deepEqual(createOutpostAssetSpec({ part: "wall", scriptSha256: "a".repeat(64), commonSha256: "d".repeat(64), blenderVersion: "5.2.2" }).parameters.arguments, { schemaVersion: 1, part: "wall" });
  assert.equal(OUTPOST_PARTS.length, 11);
  assert.equal(OUTPOST_RELEASE, "outpost-kit", "one rolling release, never numbered");
});

test("the outpost-kit-descriptor-v1 schema names the descriptor and its keys", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.schema.const, OUTPOST_DESCRIPTOR_SCHEMA);
  const key = new RegExp(schema.$defs.asset.properties.key.pattern);
  for (const part of OUTPOST_PARTS) assert.ok(key.test(outpostKey(part)), part);
  assert.ok(conforms(schema, { schema: "outpost-kit-descriptor-v1" }, schema).length > 0, "an incomplete descriptor is rejected");
});

test("the outpost recipe builds a verified kit whose modules snap to the grid, keep the doorway open and fill the house and smithy footprints", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "outpost-kit-"));
  try {
    const built = await buildOutpostKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entries = manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort();
    const expected = [...OUTPOST_PARTS.map((part) => `${outpostKey(part)}#default`), ...OUTPOST_ROOF_PARTS.map((part) => `${outpostKey(part)}#slate`)].sort();
    assert.deepEqual(entries, expected);
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "outpost.kit.wall", "default", OUTPOST_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, d, schema), []);
    const asset = Object.fromEntries(d.assets.map((a: any) => [a.role, a]));

    // Plaster, stone, wood, shingle and slate: colour, normal and ORM each, stored once.
    const pngs = (await readdir(path.join(built.bundleDir, "resources"))).filter((name) => name.endsWith(".png"));
    assert.equal(pngs.length, 15);

    // Budgets for the Greyhaven camera.
    for (const part of OUTPOST_PARTS) assert.ok(asset[part].triangles <= OUTPOST_TRIANGLE_BUDGET[part], `${part}: ${asset[part].triangles} triangles`);

    // Wall modules fill their grid width, stand 3.2 m high and lie behind the outer face (plinth and trim
    // stand a little proud of it).
    for (const [part, width] of [["wall", 2], ["wall-half", 1], ["wall-window", 2], ["wall-door", 2]] as const) {
      const a = asset[part];
      assert.ok(Math.abs(a.bounds.min[0] + width / 2) < 1e-6 && Math.abs(a.bounds.max[0] - width / 2) < 1e-6, `${part} spans its module`);
      assert.ok(Math.abs(a.bounds.max[1] - 3.2) < 1e-6 || part === "wall-door", `${part} is 3.2 m high`);
      assert.ok(a.bounds.min[2] >= -0.32 - 1e-6, `${part} stays inside the wall thickness`);
    }

    // Nothing reaches into the doorway, and the closed leaf fits it.
    const doorway = asset["wall-door"].doorway;
    assert.deepEqual([doorway.width, doorway.height], [1.2, 2.2]);
    const clear: Box = { min: [doorway.min[0] + 1e-3, 1e-3, doorway.min[2] + 1e-3], max: [doorway.max[0] - 1e-3, doorway.max[1] - 1e-3, doorway.max[2] - 1e-3] };
    for (const v of vertices(built.documents["wall-door"])) assert.ok(!overlaps({ min: v, max: v }, clear, -1e-9), `wall-door vertex ${v} is inside the doorway`);
    for (const p of asset["wall-door"].collisionProxies) assert.ok(!overlaps(proxyBox(p), clear), `${p.name} stays out of the doorway`);
    const mount = asset["wall-door"].mount.translation, leaf = asset.door.leafBounds;
    assert.ok(mount[0] + leaf.min[0] >= doorway.min[0] && mount[0] + leaf.max[0] <= doorway.max[0], "the closed leaf fits the doorway's width");
    assert.ok(mount[1] + leaf.max[1] <= doorway.max[1] && mount[1] >= 0, "the closed leaf fits the doorway's height");
    assert.ok(mount[2] + leaf.min[2] >= doorway.min[2] && mount[2] + leaf.max[2] <= doorway.max[2], "the closed leaf stays inside the wall");
    assert.equal(asset.door.hinge.node, "hinge");

    // Roof variants share the geometry; the ridge clears the wall top.
    for (const part of OUTPOST_ROOF_PARTS) {
      assert.deepEqual(asset[part].variants.map((v: any) => v.material), ["shingle", "slate"]);
      assert.equal(new Set(asset[part].variants.map((v: any) => v.triangles)).size, 1);
    }
    assert.ok(asset.roof.roof.ridgeTop > 5 && asset.roof.roof.ridgeTop < 5.3);
    assert.ok(asset.chimney.bounds.max[1] > asset.roof.roof.ridgeTop + 0.5, "the chimney clears the ridge");

    // Compositions: every item is a kit entry; the walls of each side lie on the footprint's edge and fill it.
    for (const [name, { footprint, items }] of Object.entries<any>(d.compositions)) {
      const hx = footprint.width / 2, hz = footprint.depth / 2;
      for (const item of items) assert.ok(entries.includes(`${item.key}#${item.variant}`), `${name}: ${item.key}#${item.variant}`);
      const walls = items.filter((item: any) => ["wall", "wall-half", "wall-window", "wall-door"].some((p) => item.key === outpostKey(p as any)));
      for (const [axis, half, other] of [[2, hz, hx], [2, -hz, hx], [0, hx, hz], [0, -hx, hz]] as const) {
        const side = walls.filter((item: any) => Math.abs(item.translation[axis] - half) < 1e-6);
        const width = side.reduce((sum: number, item: any) => sum + asset[item.key.split(".").pop()].module.width, 0);
        assert.ok(Math.abs(width - other * 2) < 1e-6, `${name}: the side at ${axis === 2 ? "z" : "x"} = ${half} is filled (${width} m)`);
        for (const item of side) {
          const outward = place([0, 0, 1], [0, 0, 0], item.yawDegrees);
          assert.ok(Math.abs(outward[axis]! - Math.sign(half)) < 1e-6, `${name}: ${item.key} at ${item.translation} faces outwards`);
        }
      }
      // The door hangs in its doorway, and the doorway is on the front (+Z).
      const door = items.find((item: any) => item.key === "outpost.kit.door");
      const wallDoor = items.find((item: any) => item.key === "outpost.kit.wall-door");
      const hinge = place(mount, wallDoor.translation, wallDoor.yawDegrees);
      assert.ok(hinge.every((c, k) => Math.abs(c - door.translation[k]) < 1e-6) && door.yawDegrees === wallDoor.yawDegrees, `${name}: the door is mounted`);
      assert.ok(Math.abs(wallDoor.translation[2] - hz) < 1e-6, `${name}: the doorway faces +Z`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
