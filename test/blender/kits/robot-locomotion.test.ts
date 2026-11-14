// Shooter robot locomotion (docs/robot-locomotion.md, #634): the recipe builds a verified gltf-resources-v1 bundle of the
// wheel and the track (default and damaged, three levels each) on one atlas, each level closed and inside its catalog
// cuboid, rigidly skinned with its wheel nodes on Shooter's axles, its roll clip turning every wheel one turn and
// carrying every link along the belt's path, LODs that at least halve and a descriptor that conforms to
// socket-grid-kit-descriptor-v3. Skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { documentBounds } from "../../../src/kit-bundle.js";
import { partCuboid } from "../../../src/socket-grid.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import {
  LOCOMOTION_DESCRIPTOR_ATTACHMENT, LOCOMOTION_JOINTS, LOCOMOTION_MATERIAL, LOCOMOTION_PARTS, LOCOMOTION_RELEASE, LOCOMOTION_TRIANGLE_BUDGET,
  ROLL_SECONDS, TRACK_PITCH_RADIUS, buildRobotLocomotion, bundleVariant, createLocomotionSpec, locomotionOf,
} from "../../../scripts/build-robot-locomotion.ts";

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

const schemaUrl = new URL("../../../schemas/socket-grid-kit-descriptor-v3.schema.json", import.meta.url);

/** The subset of JSON Schema the descriptor schema uses: const, enum, type (or a list of types), pattern, items, $ref. */
function conforms(schema: any, value: any, root: any, at = "$"): string[] {
  if (schema.$ref) return conforms(root.$defs[schema.$ref.split("/").pop()], value, root, at);
  if ("const" in schema) return value === schema.const ? [] : [`${at} is not ${schema.const}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at} is not one of ${schema.enum}`];
  if (Array.isArray(schema.type)) return schema.type.some((type: string) => conforms({ ...schema, type }, value, root, at).length === 0) ? [] : [`${at} is none of ${schema.type}`];
  if (schema.type === "null") return value === null ? [] : [`${at} is not null`];
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

test("the locomotion spec runs the packaged recipe for exactly one part, variant and level", () => {
  const track = LOCOMOTION_PARTS.find((part) => part.key === "robot.track")!;
  const spec = createLocomotionSpec({ part: track, level: 1, variant: "damaged", scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), robotSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "robot.track", cells: [1, 4, 2], level: 1, variant: "damaged" } });
  assert.equal(LOCOMOTION_RELEASE, "shooter-robot-locomotion", "one rolling release, never numbered");
  assert.equal(bundleVariant("damaged", 2), "damaged-lod2");
});

test("the recipe builds a verified locomotion kit on one atlas, every level inside its cuboid and rolling on Shooter's axles", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "robot-locomotion-"));
  try {
    const built = await buildRobotLocomotion({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      LOCOMOTION_PARTS.flatMap((part) => ["default", "damaged"].flatMap((variant) => [0, 1, 2].map((level) => `${part.key}#${bundleVariant(variant, level)}`))).sort());

    // One opaque material on one atlas (colour, normal, ORM, emissive), stored once as KTX2, inside the cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 4);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [LOCOMOTION_MATERIAL]);
    assert.equal(cost.maxima.drawCalls, 1);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[LOCOMOTION_RELEASE]!), []);

    for (const [entry, document] of Object.entries(built.documents)) {
      const part = LOCOMOTION_PARTS.find((candidate) => entry.startsWith(`${candidate.key}#`))!;
      const loc = locomotionOf(part);
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.ok(primitive.getAttribute("TANGENT") && primitive.getAttribute("COLOR_0"), `${entry} has tangents and COLOR_0`);
      }
      // Closed (it detaches without tears), on its mount face, inside its cuboid.
      assert.equal(openEdges(document), 0, `${entry} is closed`);
      const bounds = documentBounds(document);
      assert.ok(Math.abs(bounds.min[1]!) < 1e-4, `${entry} rests on its mount face`);
      const cuboid = partCuboid(part.cells);
      for (let k = 0; k < 3; k += 1) {
        assert.ok(bounds.min[k]! >= cuboid.min[k]! - 1e-4 && bounds.max[k]! <= cuboid.max[k]! + 1e-4, `${entry} stays in its cuboid on axis ${k}: ${bounds.min[k]}..${bounds.max[k]}`);
      }
      // One rigid skin, every node unrotated at rest; Shooter's wheel nodes on its axles, every visual wheel and link node present.
      const skins = document.getRoot().listSkins();
      assert.equal(skins.length, 1, `${entry} is skinned`);
      const nodes = new Map(skins[0]!.listJoints().map((node) => [node.getName(), node]));
      for (const node of nodes.values()) assert.deepEqual(node.getRotation(), [0, 0, 0, 1], `${entry}: ${node.getName()} rests unrotated`);
      for (const primitive of document.getRoot().listMeshes()[0]!.listPrimitives()) {
        const weights = primitive.getAttribute("WEIGHTS_0")!;
        for (let i = 0; i < weights.getCount(); i += 1) assert.ok(Math.abs(weights.getElement(i, [])[0]! - 1) < 1e-3, `${entry}: rigid weights`);
      }
      for (const name of [...loc.wheels, ...(loc.tread?.links ?? [])]) assert.ok(nodes.has(name), `${entry}: node ${name}`);
      for (const joint of LOCOMOTION_JOINTS[part.key]!) {
        assert.deepEqual(nodes.get(joint.node)!.getWorldTranslation().map((c) => Math.round(c * 1e4) / 1e4 || 0), joint.origin, `${entry}: ${joint.node} sits on Shooter's axle`);
      }
      // The roll clip: one second, every wheel one turn about +Y (ending where it starts), every link on the belt's path.
      const clips = document.getRoot().listAnimations();
      assert.deepEqual(clips.map((clip) => clip.getName()), ["roll"], `${entry}: its roll clip`);
      const turned = new Set<string>();
      for (const channel of clips[0]!.listChannels()) {
        const name = channel.getTargetNode()!.getName(), pathName = channel.getTargetPath();
        const input = channel.getSampler()!.getInput()!.getArray()!, output = channel.getSampler()!.getOutput()!;
        assert.ok(Math.abs(input[input.length - 1]! - input[0]! - ROLL_SECONDS) < 1e-3, `${entry} ${name}: ${ROLL_SECONDS} s`);
        if (loc.wheels.includes(name)) {
          assert.equal(pathName, "rotation", `${entry}: ${name} only turns`);
          for (let i = 0; i < output.getCount(); i += 1) {
            const [x, , z] = output.getElement(i, []);
            assert.ok(Math.abs(x!) < 1e-5 && Math.abs(z!) < 1e-5, `${entry}: ${name} turns about +Y`);
          }
          const first = output.getElement(0, []), last = output.getElement(output.getCount() - 1, []);
          assert.ok(Math.abs(Math.abs(first[3]!) - Math.abs(last[3]!)) < 1e-4, `${entry}: ${name} ends a whole turn on`);
          turned.add(name);
        } else if (pathName === "translation" && loc.tread) {
          // A link's pivot stays on the stadium round the two axles at the pitch radius.
          const [a, b] = loc.tread.centres;
          for (let i = 0; i < output.getCount(); i += 1) {
            const p = output.getElement(i, []);
            const t = Math.min(Math.max((p[2]! - a![2]!) / (b![2]! - a![2]!), 0), 1);
            const distance = Math.hypot(p[0]! - a![0]!, p[2]! - (a![2]! + t * (b![2]! - a![2]!)));
            assert.ok(Math.abs(distance - TRACK_PITCH_RADIUS) < 2e-3 && Math.abs(p[1]! - a![1]!) < 1e-4, `${entry}: ${name} at sample ${i} is on the belt (${distance})`);
          }
        }
      }
      assert.deepEqual([...turned].sort(), [...loc.wheels].sort(), `${entry}: every wheel turns`);
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, LOCOMOTION_PARTS[0]!.key, "default", LOCOMOTION_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, descriptor, schema), []);
    assert.deepEqual(descriptor.parts.map((part: any) => [part.key, part.cells, part.socketCount, part.locomotion.type]), LOCOMOTION_PARTS.map((part) => [part.key, part.cells, 0, part.type]));
    const tan = Math.tan(30 * Math.PI / 180);
    for (const part of descriptor.parts) {
      assert.equal(part.hitProxies.length, 1, `${part.key} has a hit proxy`);
      for (const [label, lods] of [["default", part.lods], ["damaged", part.variants.damaged.lods]]) {
        const [lod0, lod1, lod2] = lods.levels;
        assert.ok(lod0.triangles <= LOCOMOTION_TRIANGLE_BUDGET, `${part.key} ${label}: ${lod0.triangles} triangles`);
        assert.ok(lod1.triangles * 2 <= lod0.triangles, `${part.key} ${label} lod1: ${lod1.triangles} is at most half of ${lod0.triangles}`);
        assert.ok(lod2.triangles * 2 <= lod1.triangles, `${part.key} ${label} lod2: ${lod2.triangles} is at most half of ${lod1.triangles}`);
        assert.ok(lod0.referenceMaxDistance >= 60 && lod1.referenceMaxDistance >= 180 && lod2.minScreenSize === 0);
        assert.ok(Math.abs(lods.boundingSphere.radius / (lod1.referenceMaxDistance * tan) - lod1.minScreenSize) <= 5e-5, `${part.key} ${label}: lod1 minScreenSize`);
      }
    }
    for (const composition of descriptor.compositions) for (const item of composition.items) {
      assert.ok(["shooter-combat-robot", "shooter-weapons"].includes(item.kit) || manifest.assets.some((entry) => entry.key === item.key && entry.variant === item.variant), `${composition.name}: ${item.id} is a bundle entry or another kit's part`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
