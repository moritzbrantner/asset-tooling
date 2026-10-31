// Battle Royale fortress kit (#445, pass 2 #459, docs/fortress-kit.md): every piece dresses a shared collider box of
// battle_royale_core::arena; what a character stands on or is blocked by matches the box within 5 cm while decoration
// may reach outside it, the composition dresses every body but the ground exactly once, and the bundle ships three
// levels of detail per piece over shared CC0 textures. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2
// (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  FORTRESS_DESCRIPTOR_ATTACHMENT, FORTRESS_PARTS, FORTRESS_RELEASE, UNITS_PER_METRE, buildFortressKit, createFortressAssetSpec,
  fortressBodies, fortressComposition, fortressFit, fortressFitViolations, fortressKey, fortressPieces,
} from "../../../scripts/build-fortress-kit.ts";

const schemaUrl = new URL("../../../schemas/fortress-kit-descriptor-v1.schema.json", import.meta.url);

/** The subset of JSON Schema the descriptor schema uses (as in outpost-kit.test.ts). */
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

/** A piece-frame point turned by `yaw` degrees about +Y (90 turns +Z to +X). */
const turn = (p: number[], yaw: number) => {
  const a = (yaw * Math.PI) / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return [p[0]! * c + p[2]! * s, p[1]!, -p[0]! * s + p[2]! * c];
};

test("the fortress spec runs the packaged recipe for one piece at one level of detail", () => {
  const piece = fortressPieces().find((p) => p.part === "corner-tower")!;
  const spec = createFortressAssetSpec({ piece, lod: 1, inputs: {}, scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters.arguments, { schemaVersion: 1, part: "corner-tower", lod: 1, size: [7.2, 16, 7.2] });
  assert.equal(spec.assetId, "fortress.kit.corner-tower");
  assert.equal(FORTRESS_RELEASE, "fortress-kit", "one rolling release, never numbered");
});

test("the composition dresses every arena body but the ground exactly once, each piece exactly on its box", () => {
  const bodies = fortressBodies();
  assert.equal(bodies.length, 97, "battle-royale d633da2: ground, 52 side solids, 15 roof slabs, the central tower, 20 ramps, 8 lifts");
  const { items, undressed } = fortressComposition();
  assert.deepEqual(undressed.map((b) => b.part), ["Ground"]);
  const dressed = items.flatMap((item) => item.bodies.map((b) => b.body)).sort((a, b) => a - b);
  assert.deepEqual(dressed, bodies.filter((b) => b.part !== "Ground").map((b) => b.body));
  const size = Object.fromEntries(fortressPieces().map((p) => [p.part, p.size]));
  for (const item of items) {
    assert.ok(FORTRESS_PARTS.includes(item.part) && item.key === fortressKey(item.part));
    if (item.part === "keep-roof") continue;
    const [body] = item.bodies;
    const [w, h, d] = size[item.part]!.map((v) => v * UNITS_PER_METRE);
    // The piece's local box, turned and moved by the item, is exactly the body's box.
    const corners = [[-w / 2, 0, -d / 2], [w / 2, h, d / 2]].map((p) => turn(p, item.yawDegrees).map((v, k) => v + item.origin[k]!));
    for (let k = 0; k < 3; k += 1) {
      const lo = Math.min(corners[0]![k]!, corners[1]![k]!), hi = Math.max(corners[0]![k]!, corners[1]![k]!);
      assert.ok(Math.abs(lo - (body!.position[k]! - body!.halfExtents[k]!)) < 1e-6 && Math.abs(hi - (body!.position[k]! + body!.halfExtents[k]!)) < 1e-6,
        `${item.part} body ${body!.body} axis ${k}`);
    }
    if (body!.rises) {
      const rise = turn([0, 0, 1], item.yawDegrees);
      const expected = { PosX: [1, 0, 0], NegX: [-1, 0, 0], PosZ: [0, 0, 1], NegZ: [0, 0, -1] }[body!.rises];
      assert.deepEqual(rise.map((v) => v + 0), expected, `${item.part} body ${body!.body} rises ${body!.rises}`);
    }
  }
  const roof = items.find((item) => item.part === "keep-roof")!;
  assert.equal(roof.bodies.length, bodies.filter((b) => b.part === "Floor").length);
});

test("every piece has a fit rule whose decoration reach contains its fitted box", () => {
  for (const piece of fortressPieces()) {
    const { reach } = fortressFit(piece);
    const [w, h, d] = piece.size;
    assert.ok(reach.min[0] <= -w / 2 && reach.min[1] <= 0 && reach.min[2] <= -d / 2 && reach.max[0] >= w / 2 && reach.max[1] >= h && reach.max[2] >= d / 2, piece.part);
  }
});

test("the fortress recipe builds a verified kit whose walks and blocking faces fit their colliders at every level", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 3_500_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "fortress-kit-"));
  try {
    const built = await buildFortressKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entries = manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort();
    assert.deepEqual(entries, FORTRESS_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((v) => `${fortressKey(part)}#${v}`)).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "fortress.kit.curtain-wall", "default", FORTRESS_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, d, schema), []);

    // Four CC0 sets (colour, normal, metallic-roughness) and the grime decal atlas, each stored once and shared.
    const images = (await readdir(path.join(built.bundleDir, "resources"))).filter((name) => /\.(jpe?g|png)$/.test(name));
    assert.ok(images.length <= 13, `${images.length} images`);

    for (const b of built.built) {
      assert.deepEqual(fortressFitViolations(b.piece, b.document).slice(0, 8), [], `${b.piece.part} ${b.variant}`);
    }
    for (const asset of d.assets) {
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles >= lod1.triangles && lod1.triangles >= lod2.triangles, `${asset.key} levels get cheaper`);
      assert.equal(lod2.minScreenSize, 0);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
