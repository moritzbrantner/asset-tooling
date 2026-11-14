// Shooter combat robot parts (docs/combat-robot-kit.md, #595): the recipe builds a verified gltf-resources-v1 bundle of
// the nine static socket-grid parts on one metal atlas, each inside its catalog cuboid, with LODs that at least halve,
// a hit proxy and a descriptor that conforms to socket-grid-kit-descriptor-v1.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { documentBounds } from "../../../src/kit-bundle.js";
import {
  ROBOT_DESCRIPTOR_ATTACHMENT, ROBOT_MATERIAL, ROBOT_PARTS, ROBOT_RELEASE, ROBOT_TRIANGLE_BUDGET, buildCombatRobot, bundleVariant, createRobotSpec,
} from "../../../scripts/build-combat-robot.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { partCuboid } from "../../../src/socket-grid.ts";

const schemaUrl = new URL("../../../schemas/socket-grid-kit-descriptor-v1.schema.json", import.meta.url);

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
      else if (typeof schema.additionalProperties === "object") errors.push(...conforms(schema.additionalProperties, child, root, `${at}.${key}`));
    }
    return errors;
  }
  return [];
}

test("the robot spec runs the packaged recipe for exactly one part, variant and level", () => {
  const spec = createRobotSpec({ part: ROBOT_PARTS.at(-1)!, level: 1, variant: "damaged", scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "robot.armor.plate", cells: [2, 2, 1], level: 1, variant: "damaged" } });
  assert.equal(spec.assetId, "robot.armor.plate");
  assert.equal(ROBOT_RELEASE, "shooter-combat-robot", "one rolling release, never numbered");
  assert.equal(bundleVariant("damaged", 2), "damaged-lod2");
});

test("the recipe builds a verified kit on one atlas, every part inside its cuboid", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "combat-robot-"));
  try {
    const built = await buildCombatRobot({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const expected = ROBOT_PARTS.flatMap((part) => part.variants.flatMap((variant) => [0, 1, 2].map((level) => `${part.key}#${bundleVariant(variant, level)}`)));
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(), expected.sort());

    // One opaque material on one atlas (colour, normal, ORM, emissive), stored once as KTX2, inside the cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 4);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [ROBOT_MATERIAL]);
    assert.equal(cost.maxima.drawCalls, 1);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[ROBOT_RELEASE]!), []);

    for (const [entry, document] of Object.entries(built.documents)) {
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.ok(primitive.getAttribute("TANGENT") && primitive.getAttribute("COLOR_0"), `${entry} has tangents and COLOR_0`);
      }
      // Nothing leaves the part's cuboid, so parts on neighbouring sockets never clip.
      const part = ROBOT_PARTS.find((candidate) => entry.startsWith(`${candidate.key}#`))!;
      const cuboid = partCuboid(part.cells), bounds = documentBounds(document);
      for (let k = 0; k < 3; k += 1) {
        assert.ok(bounds.min[k]! >= cuboid.min[k]! - 1e-4 && bounds.max[k]! <= cuboid.max[k]! + 1e-4, `${entry} stays in its cuboid on axis ${k}: ${bounds.min[k]}..${bounds.max[k]}`);
      }
      // It rests on its mount face.
      assert.ok(Math.abs(bounds.min[1]!) < 1e-4, `${entry} rests on its mount face`);
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, ROBOT_PARTS[0]!.key, "default", ROBOT_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, descriptor, schema), []);
    assert.deepEqual(descriptor.parts.map((part: any) => [part.key, part.socketCount]), [
      ["robot.chassis.20x40x80", 28], ["robot.chassis.40x40x80", 40], ["robot.chassis.40x60x80", 52], ["robot.beam.20x20x40", 10], ["robot.beam.20x20x80", 18],
      ["robot.core", 0], ["robot.sensor", 0], ["robot.battery", 0], ["robot.armor.plate", 0],
    ]);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const part of descriptor.parts) {
      assert.equal(part.hitProxies.length, 1, `${part.key} has a hit proxy`);
      for (const lods of [part.lods, ...Object.values(part.variants).map((variant: any) => variant.lods)]) {
        const [lod0, lod1, lod2] = lods.levels;
        assert.ok(lod0.triangles <= ROBOT_TRIANGLE_BUDGET, `${part.key}: ${lod0.triangles} triangles`);
        assert.ok(lod1.triangles * 2 <= lod0.triangles, `${part.key} ${lod1.variant}: ${lod1.triangles} is at most half of ${lod0.triangles}`);
        assert.ok(lod2.triangles * 2 <= lod1.triangles, `${part.key} ${lod2.variant}: ${lod2.triangles} is at most half of ${lod1.triangles}`);
        assert.ok(lod0.referenceMaxDistance >= 60 && lod1.referenceMaxDistance >= 180 && lod2.minScreenSize === 0);
        assert.ok(Math.abs(lods.boundingSphere.radius / (lod1.minScreenSize * tan) / lod1.referenceMaxDistance - 1) < 0.02);
      }
    }
    assert.deepEqual(Object.keys(descriptor.parts.find((part: any) => part.key === "robot.armor.plate").variants), ["damaged"]);
    assert.deepEqual(descriptor.compositions.map((composition: any) => composition.name), ["humanoid", "turret"]);
    for (const composition of descriptor.compositions) for (const item of composition.items) {
      assert.ok(item.placeholder || manifest.assets.some((entry) => entry.key === item.key && entry.variant === item.variant), `${composition.name}: ${item.id} is a bundle entry or a placeholder`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
