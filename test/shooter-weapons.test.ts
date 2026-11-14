// The Shooter weapon kit's catalog and frames (scripts/build-shooter-weapons.ts, docs/shooter-weapons.md, #594) against
// Shooter's catalog (crates/shooter-sim/src/robot.rs): weapon and mod rows, anchors inside each weapon, mods inside their
// weapon's cuboid, and Shooter's loadouts plus the turret and mini-tank assembling flush on the grid without overlaps.
import test from "node:test";
import assert from "node:assert/strict";
import { apply, compose, mountTransform, partCuboid, type Transform } from "../src/socket-grid.ts";
import { PLACEHOLDER_PARTS, ROBOT_PARTS } from "../scripts/build-combat-robot.ts";
import {
  MOD_ANCHORS, WEAPON_COMPOSITIONS, WEAPON_MODS, WEAPON_PARTS, WEAPON_RIGS, WEAPON_STATES, anchorSocket, resolveLoadout, weaponChannels,
} from "../scripts/build-shooter-weapons.ts";

const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!].map((c) => c || 0);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, c, k) => sum + c * b[k]!, 0);

test("the kit's weapons and mods are Shooter's catalog rows", () => {
  // robot.rs parts::weapon: light 1 x 1 x 2, heavy (rail gun, rocket launcher) 1 x 2 x 2; BETA.mods (code 4, the heat sink, retired).
  assert.deepEqual(Object.fromEntries(WEAPON_PARTS.map((part) => [part.key, part.cells])), {
    "weapon.energy-rifle": [1, 1, 2], "weapon.shotgun": [1, 1, 2], "weapon.laser": [1, 1, 2], "weapon.flamethrower": [1, 1, 2],
    "weapon.grapple-hook": [1, 1, 2], "weapon.energy-blade": [1, 1, 2], "weapon.rail-gun": [1, 2, 2], "weapon.rocket-launcher": [1, 2, 2],
  });
  const single = ["weapon.energy-rifle", "weapon.rail-gun", "weapon.shotgun"];
  assert.deepEqual(Object.fromEntries(WEAPON_MODS.map((mod) => [mod.key, [...mod.fits].sort()])), {
    "mod.rapid-cycler": single.sort(), "mod.overcharger": single.sort(), "mod.long-barrel": ["weapon.energy-rifle", "weapon.laser", "weapon.rail-gun"],
    "mod.efficiency-coil": ["weapon.energy-rifle", "weapon.rail-gun", "weapon.rocket-launcher", "weapon.shotgun"],
  });
  // The robot kit's placeholders for these weapons have the same cells.
  for (const placeholder of PLACEHOLDER_PARTS.filter((part) => part.key.startsWith("weapon."))) {
    assert.deepEqual(WEAPON_PARTS.find((part) => part.key === placeholder.key)!.cells, placeholder.cells, placeholder.key);
  }
});

test("anchors sit inside their weapon, with unit frames, and every weapon a mod fits has its anchor", () => {
  for (const part of WEAPON_PARTS) {
    const { anchors, joints } = WEAPON_RIGS[part.key]!;
    const cuboid = partCuboid(part.cells);
    for (const anchor of anchors) {
      assert.ok(anchor.position.every((c, k) => c >= cuboid.min[k]! - 1e-9 && c <= cuboid.max[k]! + 1e-9), `${part.key} ${anchor.name} inside its cuboid`);
      assert.equal(Math.hypot(...anchor.normal), 1);
      assert.equal(Math.hypot(...anchor.up!), 1);
      assert.equal(dot(anchor.normal, anchor.up!), 0, `${part.key} ${anchor.name}: up is perpendicular to the normal`);
    }
    assert.ok(anchors.some((anchor) => ["muzzle", "emitter", "launcher", "blade-edge"].includes(anchor.kind)), `${part.key} has a muzzle or emitter frame`);
    for (const mod of WEAPON_MODS) {
      assert.equal(anchors.some((anchor) => anchor.name === mod.mount), mod.fits.includes(part.key) || (mod.mount === "mod-side" && WEAPON_MODS.some((other) => other.mount === "mod-side" && other.fits.includes(part.key))),
        `${part.key}: a ${mod.mount} anchor exactly when a mod on it fits`);
    }
    for (const joint of joints) assert.ok(joint.range && joint.range[0] < 0 && joint.range[1] > 0);
    assert.deepEqual(weaponChannels(part).map((channel) => channel.node), part.key === "weapon.energy-blade" ? ["glow-charge"] : ["glow-charge", "glow-fire"]);
    assert.ok(WEAPON_STATES[part.key]!.length > 0, `${part.key} has states`);
  }
});

test("every mod stays inside the cuboid of every weapon it fits", () => {
  for (const mod of WEAPON_MODS) for (const key of mod.fits) {
    const part = WEAPON_PARTS.find((candidate) => candidate.key === key)!;
    const at = WEAPON_RIGS[key]!.anchors.find((anchor) => anchor.name === mod.mount)!;
    const frame = anchorSocket(at);
    assert.deepEqual(cross(frame.uAxis, frame.vAxis), frame.normal, `${mod.key} on ${key}: u x v is the normal`);
    const place = mountTransform(frame);
    const cuboid = partCuboid(part.cells);
    const { min, max } = mod.envelope;
    for (let c = 0; c < 8; c += 1) {
      const p = apply(place, [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]);
      assert.ok(p.every((x, k) => x >= cuboid.min[k]! - 1e-6 && x <= cuboid.max[k]! + 1e-6), `${mod.key} on ${key}: corner ${p} inside ${JSON.stringify(cuboid)}`);
    }
    // The long barrel's own muzzle continues the weapon's muzzle along its fire direction.
    if (mod.key === "mod.long-barrel") {
      const muzzle = WEAPON_RIGS[key]!.anchors.find((anchor) => anchor.name === "muzzle")!;
      const moved = apply(place, MOD_ANCHORS[mod.key]![0]!.position);
      assert.deepEqual(moved.map((c, k) => Math.round((c - muzzle.position[k]!) * 1e6) / 1e6 || 0), muzzle.normal.map((c) => c * 0.09));
    }
  }
});

test("Shooter's loadouts, the turret and the mini-tank assemble flush on the grid without overlaps", () => {
  const types = new Map<string, readonly number[]>([...ROBOT_PARTS, ...PLACEHOLDER_PARTS, ...WEAPON_PARTS].map((part) => [part.key, part.cells]));
  assert.deepEqual(Object.keys(WEAPON_COMPOSITIONS), ["standard", "heavy", "skirmisher", "marksman", "turret", "mini-tank"]);
  const shown = new Set<string>();
  for (const [name, { items }] of Object.entries(WEAPON_COMPOSITIONS)) {
    const resolved = resolveLoadout(items);
    const box = (id: string, transform: Transform, min: readonly number[], max: readonly number[]) => {
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => apply(transform, [c & 1 ? max[0]! : min[0]!, c & 2 ? max[1]! : min[1]!, c & 4 ? max[2]! : min[2]!]));
      return { id, min: [0, 1, 2].map((k) => Math.min(...corners.map((p) => p[k]!))), max: [0, 1, 2].map((k) => Math.max(...corners.map((p) => p[k]!))) };
    };
    const boxes = resolved.map((item) => ({ ...box(item.id, item.transform, partCuboid(types.get(item.key)!).min, partCuboid(types.get(item.key)!).max), parent: (item as { parent?: string }).parent }));
    const overlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - 1e-6 && b.min[k]! < a.max[k]! - 1e-6);
    const touch = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + 1e-6 && b.min[k]! <= a.max[k]! + 1e-6);
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) assert.ok(!overlap(a, b), `${name}: ${a.id} and ${b.id} overlap`);
      if (a.parent) assert.ok(touch(a, boxes.find((b) => b.id === a.parent)!), `${name}: ${a.id} sits on ${a.parent}`);
    }
    assert.ok(Math.min(...boxes.map((b) => b.min[1]!)) > -1e-6, `${name} stands on the ground`);
    for (const item of resolved) {
      shown.add(item.key);
      if (!item.modTransform) continue;
      shown.add(item.mod!.key);
      // A mounted mod stays inside its weapon's cuboid, so it clips nothing the weapon does not.
      const weapon = boxes.find((b) => b.id === item.id)!;
      const { min, max } = WEAPON_MODS.find((mod) => mod.key === item.mod!.key)!.envelope;
      const modBox = box(`${item.id} mod`, item.modTransform, min, max);
      assert.ok([0, 1, 2].every((k) => modBox.min[k]! >= weapon.min[k]! - 1e-6 && modBox.max[k]! <= weapon.max[k]! + 1e-6), `${name}: ${item.id}'s ${item.mod!.key} inside it`);
      assert.deepEqual(compose(item.transform, mountTransform(anchorSocket(WEAPON_RIGS[item.key]!.anchors.find((a) => a.name === item.mod!.anchor)!))).translation.map((c) => Math.round(c * 1e6) / 1e6), item.mod!.translation);
    }
  }
  // Between them the builds show every weapon and every mod.
  for (const key of [...WEAPON_PARTS.map((part) => part.key), ...WEAPON_MODS.map((mod) => mod.key)]) assert.ok(shown.has(key), `${key} is in a review build`);
});
