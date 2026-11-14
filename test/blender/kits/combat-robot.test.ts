// Shooter combat robot parts (docs/combat-robot-kit.md, #595): the recipe builds a verified gltf-resources-v1 bundle of
// the socket-grid parts on one metal atlas, each inside its catalog cuboid and closed (it renders detached without
// tears), with LODs that at least halve, a hit proxy and a descriptor that conforms to socket-grid-kit-descriptor-v1.
// The hinge, rotor and leg are rigidly skinned to joint nodes at the descriptor's pivots; the leg carries its walk clips.
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
  LEG_CLIPS, ROBOT_DESCRIPTOR_ATTACHMENT, ROBOT_JOINTS, ROBOT_MATERIAL, ROBOT_PARTS, ROBOT_RELEASE, ROBOT_TRIANGLE_BUDGET, buildCombatRobot, bundleVariant, createRobotSpec,
} from "../../../scripts/build-combat-robot.ts";
import type { Document } from "@gltf-transform/core";

/** Edges used by exactly one triangle, with vertices welded by position (and joint): an open edge shows as a tear. */
function openEdges(document: Document) {
  let open = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute("POSITION")!, joints = primitive.getAttribute("JOINTS_0");
    const indices = primitive.getIndices()!.getArray()!;
    const key = (i: number) => `${position.getElement(i, []).map((c) => c.toFixed(5))}|${joints ? joints.getElement(i, [])[0] : 0}`;
    const uses = new Map<string, number>();
    for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e += 1) {
      const edge = [key(indices[t + e]!), key(indices[t + (e + 1) % 3]!)].sort().join(" ");
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
    for (const count of uses.values()) if (count === 1) open += 1;
  }
  return open;
}

/** A unit quaternion's angle about +X, if it only turns about +X. */
const angleAboutX = ([x, y, z, w]: number[]) => (Math.abs(y!) < 1e-5 && Math.abs(z!) < 1e-5 ? 2 * Math.atan2(x!, w!) : NaN);
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
  const spec = createRobotSpec({ part: ROBOT_PARTS.find((part) => part.key === "robot.armor.plate")!, level: 1, variant: "damaged", scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), blenderVersion: "5.2.2" });
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
      // Closed: attached, detached or turned at a joint, no open edge shows (every face is one bone's, rigidly).
      assert.equal(openEdges(document), 0, `${entry} is closed`);

      const rig = ROBOT_JOINTS[part.key];
      const skins = document.getRoot().listSkins();
      assert.equal(skins.length, rig ? 1 : 0, `${entry}: skinned exactly when it articulates`);
      if (!rig) { assert.equal(document.getRoot().listAnimations().length, 0); continue; }
      const nodes = new Map(skins[0]!.listJoints().map((node) => [node.getName(), node]));
      for (const joint of rig.joints) {
        const node = nodes.get(joint.node)!;
        assert.ok(node, `${entry}: joint node ${joint.node}`);
        assert.deepEqual(node.getWorldTranslation().map((c) => Math.round(c * 1e4) / 1e4 || 0), joint.origin, `${entry}: ${joint.node} sits on its pivot`);
        assert.deepEqual(node.getRotation(), [0, 0, 0, 1], `${entry}: ${joint.node} rests unrotated, in the part's axes`);
      }
      for (const primitive of document.getRoot().listMeshes()[0]!.listPrimitives()) {
        const weights = primitive.getAttribute("WEIGHTS_0")!;
        for (let i = 0; i < weights.getCount(); i += 1) assert.ok(Math.abs(weights.getElement(i, [])[0]! - 1) < 1e-3, `${entry}: rigid weights`);
      }
      const clips = document.getRoot().listAnimations();
      assert.deepEqual(clips.map((clip) => clip.getName()).sort(), part.key === "robot.leg" ? Object.keys(LEG_CLIPS).sort() : []);
      for (const clip of clips) {
        const seconds = LEG_CLIPS[clip.getName() as keyof typeof LEG_CLIPS].seconds;
        for (const channel of clip.listChannels()) {
          assert.equal(channel.getTargetPath(), "rotation", `${entry} ${clip.getName()}: rotations only`);
          const joint = rig.joints.find((candidate) => candidate.node === channel.getTargetNode()!.getName())!;
          const input = channel.getSampler()!.getInput()!.getArray()!, output = channel.getSampler()!.getOutput()!;
          assert.ok(Math.abs(input[input.length - 1]! - input[0]! - seconds) < 1e-3, `${entry} ${clip.getName()}: one ${seconds} s cycle`);
          const angles = Array.from({ length: output.getCount() }, (_, i) => angleAboutX(output.getElement(i, [])));
          assert.ok(angles.every((angle) => angle >= joint.range![0] - 1e-3 && angle <= joint.range![1] + 1e-3), `${entry} ${clip.getName()} ${joint.name}: within its range`);
          assert.ok(Math.abs(angles[0]! - angles.at(-1)!) < 1e-4, `${entry} ${clip.getName()} ${joint.name}: loops`);
        }
      }
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, ROBOT_PARTS[0]!.key, "default", ROBOT_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, descriptor, schema), []);
    assert.deepEqual(descriptor.parts.map((part: any) => [part.key, part.socketCount]), [
      ["robot.chassis.20x40x80", 28], ["robot.chassis.40x40x80", 40], ["robot.chassis.40x60x80", 52], ["robot.beam.20x20x40", 10], ["robot.beam.20x20x80", 18],
      ["robot.core", 0], ["robot.sensor", 0], ["robot.battery", 0], ["robot.armor.plate", 0], ["robot.joint.hinge", 1], ["robot.joint.rotor", 1], ["robot.leg", 0],
    ]);
    for (const part of descriptor.parts) {
      assert.deepEqual(part.joints, ROBOT_JOINTS[part.key]?.joints ?? [], `${part.key}: joints`);
      assert.deepEqual(part.anchors, ROBOT_JOINTS[part.key]?.anchors ?? [], `${part.key}: anchors`);
    }
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
    assert.deepEqual(descriptor.compositions.map((composition: any) => composition.name), ["humanoid", "robo-dog", "mini-tank", "turret"]);
    for (const composition of descriptor.compositions) for (const item of composition.items) {
      assert.ok(item.placeholder || manifest.assets.some((entry) => entry.key === item.key && entry.variant === item.variant), `${composition.name}: ${item.id} is a bundle entry or a placeholder`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
