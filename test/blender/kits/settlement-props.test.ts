// Greyhaven settlement props (#369, docs/settlement-props.md): the scripted Blender recipe builds a verified
// gltf-resources-v1 bundle with props from mmorpg#421's three families, each within its triangle budget,
// sharing the Outpost kit's textures, and a square composition that keeps its walkway clear. The build skips
// unless ASSET_TOOLING_BLENDER names Blender 5.2.2 (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  SETTLEMENT_DESCRIPTOR_ATTACHMENT, SETTLEMENT_DESCRIPTOR_SCHEMA, SETTLEMENT_FAMILY, SETTLEMENT_PROPS, SETTLEMENT_RELEASE, SETTLEMENT_TRIANGLE_BUDGET,
  buildSettlementProps, createSettlementAssetSpec, settlementKey,
} from "../../../scripts/build-settlement-props.ts";

type Box = { min: number[]; max: number[] };
const overlaps = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - epsilon && b.min[k]! < a.max[k]! - epsilon);
const schemaUrl = new URL("../../../schemas/settlement-props-descriptor-v1.schema.json", import.meta.url);

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
      else if (typeof schema.additionalProperties === "object") errors.push(...conforms(schema.additionalProperties, child, root, `${at}.${key}`));
    }
    return errors;
  }
  return [];
}

/** The axis-aligned box of a prop-frame box turned by ``yaw`` degrees about +Y and moved by ``t``. */
function placedBox(box: Box, t: number[], yaw: number): Box {
  const a = (yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const xs: number[] = [], zs: number[] = [];
  for (const x of [box.min[0]!, box.max[0]!]) for (const z of [box.min[2]!, box.max[2]!]) {
    xs.push(x * c + z * s + t[0]!); zs.push(-x * s + z * c + t[2]!);
  }
  return { min: [Math.min(...xs), box.min[1]! + t[1]!, Math.min(...zs)], max: [Math.max(...xs), box.max[1]! + t[1]!, Math.max(...zs)] };
}

test("the settlement spec runs the packaged recipe with the outpost kit recipe as its input", () => {
  const spec = createSettlementAssetSpec({ prop: "cart", scriptSha256: "a".repeat(64), outpostSha256: "b".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, prop: "cart" } });
  assert.equal(spec.assetId, "settlement.props.cart");
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["outpost", "script"]);
  assert.deepEqual(new Set(Object.values(SETTLEMENT_FAMILY)), new Set(["market", "street", "dressing"]));
  assert.equal(SETTLEMENT_RELEASE, "settlement-props", "one rolling release, never numbered");
});

test("the settlement-props-descriptor-v1 schema names the descriptor and its keys", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.schema.const, SETTLEMENT_DESCRIPTOR_SCHEMA);
  const key = new RegExp(schema.$defs.asset.properties.key.pattern);
  for (const prop of SETTLEMENT_PROPS) assert.ok(key.test(settlementKey(prop)), prop);
  assert.ok(conforms(schema, { schema: SETTLEMENT_DESCRIPTOR_SCHEMA }, schema).length > 0, "an incomplete descriptor is rejected");
});

test("the settlement recipe builds verified props within budget that share the kit textures and keep the square's walkway clear", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "settlement-props-"));
  try {
    const built = await buildSettlementProps({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entries = manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort();
    assert.deepEqual(entries, SETTLEMENT_PROPS.map((prop) => `${settlementKey(prop)}#default`).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "settlement.props.stall", "default", SETTLEMENT_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, d, schema), []);
    const asset = Object.fromEntries(d.assets.map((a: any) => [a.role, a]));

    // Wood, stone and shingle from the Outpost kit (colour, normal and ORM each), stored once.
    const pngs = (await readdir(path.join(built.bundleDir, "resources"))).filter((name) => name.endsWith(".png"));
    assert.equal(pngs.length, 9);

    for (const prop of SETTLEMENT_PROPS) {
      const a = asset[prop];
      assert.ok(a.triangles <= SETTLEMENT_TRIANGLE_BUDGET[prop], `${prop}: ${a.triangles} triangles`);
      assert.equal(a.family, SETTLEMENT_FAMILY[prop]);
      assert.ok(Math.abs(a.bounds.min[1]) < 1e-3, `${prop} stands on the ground`);
    }
    // The fence fills its 2 m module exactly, so segments chain; crates stack.
    assert.deepEqual([asset.fence.bounds.min[0], asset.fence.bounds.max[0]], [-1, 1]);
    assert.ok(Math.abs(asset.crate.stackTop - asset.crate.bounds.max[1]) < 1e-6);
    assert.ok(asset["lantern-post"].light.position[1] > 2 && asset.signpost.sign.board.min[1] > 1.6, "lantern and sign hang above head height");

    // The square: every item is a bundle entry, every family is placed, items stay in the footprint and out of the walkway.
    const square = d.compositions.square;
    const families = new Set<string>();
    for (const item of square.items) {
      assert.ok(entries.includes(`${item.key}#${item.variant}`), item.key);
      const a = asset[item.key.split(".").pop()];
      families.add(a.family);
      for (const p of a.collisionProxies) {
        const box = placedBox({ min: p.center.map((c: number, k: number) => c - p.size[k] / 2), max: p.center.map((c: number, k: number) => c + p.size[k] / 2) }, item.translation, item.yawDegrees);
        assert.ok(!overlaps(box, square.walkway), `${item.key} at ${item.translation} blocks the walkway`);
        assert.ok(box.min[0] >= -square.footprint.width / 2 - 1e-6 && box.max[0] <= square.footprint.width / 2 + 1e-6
          && box.min[2] >= -square.footprint.depth / 2 - 1e-6 && box.max[2] <= square.footprint.depth / 2 + 1e-6, `${item.key} at ${item.translation} leaves the footprint`);
      }
    }
    assert.deepEqual([...families].sort(), ["dressing", "market", "street"]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
