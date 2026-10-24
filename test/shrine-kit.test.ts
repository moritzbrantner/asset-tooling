// Sunken shrine and cave kit (#345, docs/shrine-kit.md): the scripted Blender recipe builds a verified
// gltf-resources-v1 bundle whose shrine modules sit on the 4 m grid, whose arch and cave passages stay
// open, whose cave modules join without seams and whose textures are stored once. The build skips unless
// ASSET_TOOLING_BLENDER names Blender 5.2.2 (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../src/asset-bundle.js";
import { SHRINE_DESCRIPTOR_ATTACHMENT, SHRINE_DESCRIPTOR_SCHEMA, SHRINE_PARTS, SHRINE_RELEASE, buildShrineKit, createShrineAssetSpec, shrineKey } from "../scripts/build-shrine-kit.ts";

type Box = { min: number[]; max: number[] };
const overlaps = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - epsilon && b.min[k]! < a.max[k]! - epsilon);
const proxyBox = (p: { center: number[]; size: number[] }): Box => ({ min: p.center.map((c, k) => c - p.size[k]! / 2), max: p.center.map((c, k) => c + p.size[k]! / 2) });
const schemaUrl = new URL("../schemas/shrine-kit-descriptor-v1.schema.json", import.meta.url);

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

/** The (y, z) cross-section of a cave module's vertices at one open end, as sorted rounded keys. */
function endSection(document: Document, x: number) {
  return [...new Set(vertices(document).filter((v) => Math.abs(v[0]! - x) < 1e-4).map((v) => `${v[1]!.toFixed(3)},${v[2]!.toFixed(3)}`))].sort();
}

test("the shrine spec runs the packaged recipe with exactly one module", () => {
  const spec = createShrineAssetSpec({ part: "arch", scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "arch" } });
  assert.equal(spec.assetId, "shrine.kit.arch");
  assert.equal(SHRINE_PARTS.length, 14);
  assert.equal(SHRINE_RELEASE, "shrine-kit", "one rolling release, never numbered");
});

test("the shrine-kit-descriptor-v1 schema names the descriptor and its keys", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.properties.schema.const, SHRINE_DESCRIPTOR_SCHEMA);
  const key = new RegExp(schema.$defs.asset.properties.key.pattern);
  for (const part of SHRINE_PARTS) assert.ok(key.test(shrineKey(part)), part);
  assert.ok(conforms(schema, { schema: "shrine-kit-descriptor-v1" }, schema).length > 0, "an incomplete descriptor is rejected");
});

test("the shrine recipe builds a verified bundle with an open arch, open cave passages that join, a lit relic altar and shared textures", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "shrine-kit-"));
  try {
    const built = await buildShrineKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), SHRINE_PARTS.map(shrineKey).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "shrine.kit.wall", "default", SHRINE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, d, schema), []);
    const asset = Object.fromEntries(d.assets.map((a: any) => [a.role, a]));

    // Three limestone and three cave-rock PNGs, each stored once for every module that uses it.
    const pngs = (await readdir(path.join(built.bundleDir, "resources"))).filter((name) => name.endsWith(".png"));
    assert.equal(pngs.length, 6);

    // The wall and the arch fill their 4 m module; the floor tile's top is y = 0.
    for (const part of ["wall", "arch"]) assert.ok(Math.abs(asset[part].footprint.width - 4) < 0.15, `${part} fills its module`);
    assert.ok(asset.wall.bounds.max[1] <= 3.05 && asset.arch.bounds.max[1] <= 4.0001);
    assert.ok(asset.floor.bounds.max[1] <= 0 && asset.floor.bounds.max[1] > -0.02 && Math.abs(asset.floor.footprint.width - 4) < 0.02);

    // Nothing reaches into the arch's round-headed opening.
    const o = asset.arch.opening;
    assert.deepEqual([o.width, o.springline, o.crown], [2.4, 1.8, 3]);
    for (const v of vertices(built.documents.arch)) {
      const [x, y, z] = v as [number, number, number];
      if (Math.abs(z) > 0.29 || y <= 1e-4) continue;
      const r = o.width / 2 - 1e-3;
      const inside = y < o.springline ? Math.abs(x) < r : Math.hypot(x, y - o.springline) < r;
      assert.ok(!inside, `arch vertex ${v} is inside the opening`);
    }
    for (const p of asset.arch.collisionProxies) assert.ok(!overlaps(proxyBox(p), { min: [-1.2, 0, -0.3], max: [1.2, 1.8, 0.3] }), `arch ${p.name} stays out of the opening`);

    // Every cave module keeps its 4 x 3 m passage clear of geometry and proxies, and its open ends share
    // the tunnel's cross-section, so any sequence of them joins without seams.
    const reference = endSection(built.documents["cave-tunnel"], 2);
    assert.ok(reference.length > 100);
    assert.deepEqual(endSection(built.documents["cave-tunnel"], -2), reference);
    for (const part of ["cave-mouth", "cave-tunnel", "cave-end", "air-pocket"] as const) {
      const tunnel = asset[part].tunnel;
      const clear: Box = { min: tunnel.clear.min.map((c: number, k: number) => c + (k === 1 ? 1e-3 : 1e-3)), max: tunnel.clear.max.map((c: number) => c - 1e-3) };
      for (const v of vertices(built.documents[part])) assert.ok(!overlaps({ min: v, max: v }, clear, -1e-9), `${part} vertex ${v} is inside the passage`);
      for (const p of asset[part].collisionProxies) assert.ok(!overlaps(proxyBox(p), tunnel.clear), `${part} ${p.name} stays out of the passage`);
      for (const end of tunnel.ends) {
        const x = end === "+X" ? tunnel.clear.max[0] : tunnel.clear.min[0];
        assert.deepEqual(endSection(built.documents[part], x).map((key) => key), reference, `${part} ${end} end joins the tunnel`);
      }
    }
    assert.deepEqual(asset["cave-mouth"].tunnel.ends, ["+X"]);
    assert.deepEqual(asset["cave-end"].tunnel.ends, ["-X"]);
    assert.ok(asset["air-pocket"].footprint.depth > 8 && asset["air-pocket"].airPocket.max[2] - asset["air-pocket"].airPocket.min[2] >= 8, "the air pocket is a wider room");

    // The altar holds the relic under a teal light; the cave mouth suggests its light shaft.
    assert.equal(asset.altar.relic.node, "relic");
    assert.deepEqual(asset.altar.lights.map((l: any) => l.kind), ["point"]);
    assert.deepEqual(asset["cave-mouth"].lights.map((l: any) => l.kind), ["spot"]);
    assert.equal(asset["hanging-weed"].anchor.at, "top");
    for (const part of ["hanging-weed", "silt-drift", "shells"]) assert.deepEqual(asset[part].collisionProxies, [], part);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
