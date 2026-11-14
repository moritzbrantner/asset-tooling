// Shooter arena kit (docs/shooter-arena.md, #593): the recipe builds a verified gltf-resources-v1 bundle of every module
// (and the broken variants) on one atlas, every level and variant inside its placement box, the tiling modules filling
// it exactly so neighbours meet without gaps, no vertex in the doorway's opening, the door's leaves as their own nodes,
// LODs that at least halve, triangle budgets, the cost limit, and a descriptor that conforms to arena-kit-descriptor-v1.
// Skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { documentBounds } from "../../../src/kit-bundle.js";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import {
  ARENA_DESCRIPTOR_ATTACHMENT, ARENA_MATERIAL, ARENA_MODULES, ARENA_RELEASE, ARENA_TRIANGLE_BUDGET, buildShooterArena, bundleVariant, createArenaSpec, moduleOf, variantsOf,
} from "../../../scripts/build-shooter-arena.ts";

const schemaUrl = new URL("../../../schemas/arena-kit-descriptor-v1.schema.json", import.meta.url);
/** Modules that tile with their neighbours: their geometry fills the placement box on every side. */
const FILLS_BOX = new Set(["surface", "wall", "platform", "ramp", "hull", "cover", "door", "jump-pad"]);

/** The subset of JSON Schema the descriptor schema uses: const, enum, type (or a list of types), pattern, items, $ref. */
function conforms(schema: any, value: any, root: any, at = "$"): string[] {
  if (schema.$ref) return conforms(root.$defs[schema.$ref.split("/").pop()], value, root, at);
  if ("const" in schema) return value === schema.const ? [] : [`${at} is not ${schema.const}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at} is not one of ${schema.enum}`];
  if (Array.isArray(schema.type)) return schema.type.some((type: string) => conforms({ ...schema, type }, value, root, at).length === 0) ? [] : [`${at} is none of ${schema.type}`];
  if (schema.type === "null") return value === null ? [] : [`${at} is not null`];
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

/** Every vertex position of the document in world space. */
function* positions(document: Document) {
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      for (let i = 0; i < position.getCount(); i += 1) {
        const p = position.getElement(i, []);
        yield [0, 1, 2].map((k) => m[k]! * p[0]! + m[4 + k]! * p[1]! + m[8 + k]! * p[2]! + m[12 + k]!);
      }
    }
  }
}

test("the arena spec runs the packaged recipe for exactly one module, variant and level", () => {
  const spec = createArenaSpec({ key: "arena.barrier", variant: "broken", level: 1, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), robotSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "arena.barrier", variant: "broken", level: 1 } });
  assert.equal(ARENA_RELEASE, "shooter-arena", "one rolling release, never numbered");
  assert.equal(bundleVariant("broken", 1), "broken-lod1");
  assert.equal(bundleVariant("default", 1), "lod1");
});

test("the recipe builds a verified arena kit on one atlas, every module inside its placement box", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "shooter-arena-"));
  try {
    const built = await buildShooterArena({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entries = new Set(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`));
    for (const module of ARENA_MODULES) for (const variant of variantsOf(module)) assert.ok(entries.has(`${module.key}#${variant}`), `${module.key} ${variant} is in the bundle`);

    // One opaque material on one atlas (colour, normal, ORM, emissive), stored once as KTX2, inside the cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 4);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [ARENA_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[ARENA_RELEASE]!), []);

    for (const [entry, document] of Object.entries(built.documents)) {
      const module = moduleOf(entry.split("#")[0]!);
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.ok(primitive.getAttribute("TANGENT") && primitive.getAttribute("COLOR_0"), `${entry} has tangents and COLOR_0`);
        assert.equal(primitive.getMaterial()?.getName(), ARENA_MATERIAL, `${entry} uses the kit's material`);
      }
      // Inside its placement box; a tiling module fills it on every side (its intact variant), so neighbours meet.
      const bounds = documentBounds(document);
      for (let k = 0; k < 3; k += 1) {
        assert.ok(bounds.min[k]! >= module.box.min[k]! - 1e-4 && bounds.max[k]! <= module.box.max[k]! + 1e-4, `${entry} stays in its box on axis ${k}: ${bounds.min[k]}..${bounds.max[k]}`);
        if (FILLS_BOX.has(module.category) && entry.endsWith("#default")) {
          assert.ok(Math.abs(bounds.min[k]! - module.box.min[k]!) < 1e-4 && Math.abs(bounds.max[k]! - module.box.max[k]!) < 1e-4, `${entry} fills its box on axis ${k}`);
        }
      }
    }
    // No vertex of the doorway reaches into its opening; the door's leaves are their own nodes.
    const opening = moduleOf("arena.doorway").extras!.doorway as { min: number[]; max: number[] };
    for (const variant of ["default", "lod1"]) {
      const document = built.documents[`arena.doorway#${variant}`];
      if (!document) continue;
      for (const p of positions(document)) {
        assert.ok(!(p[0]! > opening.min[0]! + 1e-4 && p[0]! < opening.max[0]! - 1e-4 && p[1]! < opening.max[1]! - 1e-4), `doorway vertex ${p} is in the opening`);
      }
    }
    for (const variant of ["default", "broken"]) {
      const names = built.documents[`arena.door#${variant}`]!.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => node.getName()).sort();
      assert.deepEqual(names, ["leaf-left", "leaf-right"], `door ${variant} leaves`);
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, ARENA_MODULES[0]!.key, "default", ARENA_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, descriptor, schema), []);
    assert.deepEqual(descriptor.assets.map((asset: any) => asset.key), ARENA_MODULES.map((module) => module.key));
    for (const asset of descriptor.assets) {
      const module = moduleOf(asset.key);
      assert.ok(asset.triangles <= ARENA_TRIANGLE_BUDGET[module.kind], `${asset.key}: ${asset.triangles} triangles`);
      assert.deepEqual(asset.collisionProxies, module.proxies);
      for (const [variant, entry] of Object.entries(asset.variants) as [string, any][]) {
        const [lod0, lod1] = entry.lods.levels;
        if (lod1) {
          assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key} ${variant} lod1 halves`);
          assert.ok(lod0.referenceMaxDistance >= 60 && lod1.minScreenSize === 0);
          assert.ok(manifest.assets.some((e) => e.key === asset.key && e.variant === lod1.variant), `${asset.key} ${lod1.variant} is in the bundle`);
        } else {
          assert.equal(lod0.minScreenSize, 0);
        }
      }
    }
    for (const composition of descriptor.compositions) for (const item of composition.items) {
      assert.ok(entries.has(`${item.key}#${item.variant ?? "default"}`), `${composition.name}: ${item.key} is a bundle entry`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
