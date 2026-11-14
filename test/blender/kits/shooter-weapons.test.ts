// Shooter weapons and mods (docs/shooter-weapons.md, #594): the recipe builds a verified gltf-resources-v1 bundle of the
// eight weapons and four mods on one atlas, each weapon inside its catalog cuboid and closed (it detaches cleanly with its
// parent), rigidly skinned to its moving and emissive-channel nodes, with its states as glTF animations, LODs that at
// least halve and a descriptor that conforms to socket-grid-kit-descriptor-v2. Skips unless ASSET_TOOLING_BLENDER names
// Blender 5.2.2.
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
  WEAPONS_DESCRIPTOR_ATTACHMENT, WEAPONS_MATERIAL, WEAPONS_RELEASE, WEAPONS_TRIANGLE_BUDGET, WEAPON_MODS, WEAPON_PARTS, WEAPON_RIGS, WEAPON_STATES,
  buildShooterWeapons, bundleVariant, createWeaponSpec, weaponChannels,
} from "../../../scripts/build-shooter-weapons.ts";

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

const schemaUrl = new URL("../../../schemas/socket-grid-kit-descriptor-v2.schema.json", import.meta.url);

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

test("the weapon spec runs the packaged recipe for exactly one weapon or mod and level", () => {
  const rifle = createWeaponSpec({ part: { key: "weapon.rail-gun", cells: [1, 2, 2] }, level: 1, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), robotSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(rifle.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "weapon.rail-gun", cells: [1, 2, 2], level: 1 } });
  const mod = createWeaponSpec({ part: { key: "mod.overcharger", cells: null }, level: 0, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), robotSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.equal((mod.parameters as any).arguments.cells, null);
  assert.equal(WEAPONS_RELEASE, "shooter-weapons", "one rolling release, never numbered");
  assert.equal(bundleVariant(2), "lod2");
});

test("the recipe builds a verified weapon kit on one atlas, every weapon inside its cuboid", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "shooter-weapons-"));
  try {
    const built = await buildShooterWeapons({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const keys = [...WEAPON_PARTS.map((part) => part.key), ...WEAPON_MODS.map((mod) => mod.key)];
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(), keys.flatMap((key) => [0, 1, 2].map((level) => `${key}#${bundleVariant(level)}`)).sort());

    // One opaque material on one atlas (colour, normal, ORM, emissive), stored once as KTX2, inside the cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 4);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [WEAPONS_MATERIAL]);
    assert.equal(cost.maxima.drawCalls, 1);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[WEAPONS_RELEASE]!), []);

    for (const [entry, document] of Object.entries(built.documents)) {
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.ok(primitive.getAttribute("TANGENT") && primitive.getAttribute("COLOR_0"), `${entry} has tangents and COLOR_0`);
      }
      assert.equal(openEdges(document), 0, `${entry} is closed`);
      const bounds = documentBounds(document);
      assert.ok(Math.abs(bounds.min[1]!) < 1e-4, `${entry} rests on its mount face`);
      const mod = WEAPON_MODS.find((candidate) => entry.startsWith(`${candidate.key}#`));
      if (mod) {
        for (let k = 0; k < 3; k += 1) assert.ok(bounds.min[k]! >= mod.envelope.min[k]! - 1e-4 && bounds.max[k]! <= mod.envelope.max[k]! + 1e-4, `${entry} stays in its envelope on axis ${k}`);
        assert.equal(document.getRoot().listSkins().length, 0, `${entry} is static`);
        continue;
      }
      // Nothing leaves the weapon's cuboid at rest, so parts on neighbouring sockets never clip.
      const part = WEAPON_PARTS.find((candidate) => entry.startsWith(`${candidate.key}#`))!;
      const cuboid = partCuboid(part.cells);
      for (let k = 0; k < 3; k += 1) {
        assert.ok(bounds.min[k]! >= cuboid.min[k]! - 1e-4 && bounds.max[k]! <= cuboid.max[k]! + 1e-4, `${entry} stays in its cuboid on axis ${k}: ${bounds.min[k]}..${bounds.max[k]}`);
      }
      // One skin, rigid, every joint node unrotated at rest; the channel, anchor and joint nodes exist.
      const skins = document.getRoot().listSkins();
      assert.equal(skins.length, 1, `${entry} is skinned`);
      const nodes = new Map(skins[0]!.listJoints().map((node) => [node.getName(), node]));
      for (const node of nodes.values()) assert.deepEqual(node.getRotation(), [0, 0, 0, 1], `${entry}: ${node.getName()} rests unrotated`);
      for (const primitive of document.getRoot().listMeshes()[0]!.listPrimitives()) {
        const weights = primitive.getAttribute("WEIGHTS_0")!;
        for (let i = 0; i < weights.getCount(); i += 1) assert.ok(Math.abs(weights.getElement(i, [])[0]! - 1) < 1e-3, `${entry}: rigid weights`);
      }
      const rig = WEAPON_RIGS[part.key]!;
      for (const name of [...weaponChannels(part).map((channel) => channel.node), ...rig.anchors.map((anchor) => anchor.node!), ...rig.joints.map((joint) => joint.node)]) {
        assert.ok(nodes.has(name), `${entry}: node ${name}`);
      }
      for (const joint of rig.joints) {
        assert.deepEqual(nodes.get(joint.node)!.getWorldTranslation().map((c) => Math.round(c * 1e4) / 1e4 || 0), joint.origin, `${entry}: ${joint.node} sits on its pivot`);
      }
      // Its states, as glTF animations of its own nodes, each as long as declared; loops end where they start.
      const clips = new Map(document.getRoot().listAnimations().map((clip) => [clip.getName(), clip]));
      assert.deepEqual([...clips.keys()].sort(), WEAPON_STATES[part.key]!.map((state) => state.name).sort(), `${entry}: its states`);
      for (const state of WEAPON_STATES[part.key]!) {
        const clip = clips.get(state.name)!;
        assert.ok(clip.listChannels().length > 0, `${entry} ${state.name}: moves something`);
        for (const channel of clip.listChannels()) {
          assert.ok(nodes.has(channel.getTargetNode()!.getName()), `${entry} ${state.name}: animates a skin joint`);
          const input = channel.getSampler()!.getInput()!.getArray()!, output = channel.getSampler()!.getOutput()!;
          assert.ok(Math.abs(input[input.length - 1]! - input[0]! - state.seconds) < 1e-3, `${entry} ${state.name}: ${state.seconds} s`);
          if (state.loop && channel.getTargetPath() !== "rotation") {
            assert.deepEqual(output.getElement(0, []).map((c) => c.toFixed(4)), output.getElement(output.getCount() - 1, []).map((c) => c.toFixed(4)), `${entry} ${state.name}: loops`);
          }
        }
      }
    }

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, WEAPON_PARTS[0]!.key, "default", WEAPONS_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.deepEqual(conforms(schema, descriptor, schema), []);
    assert.deepEqual(descriptor.parts.map((part: any) => [part.key, part.cells, part.socketCount]), WEAPON_PARTS.map((part) => [part.key, part.cells, 0]));
    assert.deepEqual(descriptor.mods.map((mod: any) => mod.key), WEAPON_MODS.map((mod) => mod.key));
    const tan = Math.tan(30 * Math.PI / 180);
    for (const entry of [...descriptor.parts, ...descriptor.mods]) {
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod0.triangles <= WEAPONS_TRIANGLE_BUDGET, `${entry.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${entry.key} lod1: ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${entry.key} lod2: ${lod2.triangles} is at most half of ${lod1.triangles}`);
      assert.ok(lod0.referenceMaxDistance >= 60 && lod1.referenceMaxDistance >= 180 && lod2.minScreenSize === 0);
      // minScreenSize is the radius over the distance times tan(fovY / 2), to four decimals (small mods round coarsely).
      assert.ok(Math.abs(entry.lods.boundingSphere.radius / (lod1.referenceMaxDistance * tan) - lod1.minScreenSize) <= 5e-5, `${entry.key}: lod1 minScreenSize`);
    }
    for (const part of descriptor.parts) assert.equal(part.hitProxies.length, 1, `${part.key} has a hit proxy`);
    for (const composition of descriptor.compositions) for (const item of composition.items) {
      assert.ok(item.placeholder || item.kit === "shooter-combat-robot" || manifest.assets.some((entry) => entry.key === item.key && entry.variant === item.variant), `${composition.name}: ${item.id} is a bundle entry, a robot part or a placeholder`);
      if (item.mod) assert.ok(manifest.assets.some((entry) => entry.key === item.mod.key), `${composition.name}: ${item.id}'s mod`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
