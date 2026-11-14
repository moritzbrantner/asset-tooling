// The Shooter locomotion kit's catalog, axles and review builds (scripts/build-robot-locomotion.ts,
// docs/robot-locomotion.md, #634) against Shooter's catalog and mechanics (crates/shooter-sim/src/robot.rs, mechanics.rs):
// wheel and track rows, the axles where Shooter's mechanics put its spheres, the belt's arithmetic, and the review
// builds assembling flush on the grid without overlaps, with every wheel and track on the ground.
import test from "node:test";
import assert from "node:assert/strict";
import { apply, partCuboid, partToGltf, type Transform } from "../src/socket-grid.ts";
import { PLACEHOLDER_PARTS, ROBOT_PARTS } from "../scripts/build-combat-robot.ts";
import { WEAPON_PARTS } from "../scripts/build-shooter-weapons.ts";
import {
  LOCOMOTION_COMPOSITIONS, LOCOMOTION_JOINTS, LOCOMOTION_PARTS, PITCHES_PER_TURN, TRACK_LINKS, TRACK_PITCH, TRACK_PITCH_RADIUS,
  locomotionOf, resolveBuild,
} from "../scripts/build-robot-locomotion.ts";

const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((c, k) => Math.abs(c - b[k]!) <= eps);

test("the kit's wheel and track are Shooter's catalog rows", () => {
  // robot.rs parts::WHEEL (code 41, 2 x 2 x 1, Faces::NONE) and parts::TRACK (code 42, 1 x 4 x 2, Faces::NONE).
  assert.deepEqual(LOCOMOTION_PARTS.map((part) => [part.key, part.cells]), [["robot.wheel", [2, 2, 1]], ["robot.track", [1, 4, 2]]]);
  for (const placeholder of PLACEHOLDER_PARTS.filter((part) => part.kind === "locomotion")) {
    assert.deepEqual(LOCOMOTION_PARTS.find((part) => part.key === placeholder.key)!.cells, placeholder.cells, `the robot kit's ${placeholder.key} placeholder`);
  }
});

test("the axles are where Shooter's mechanics put its wheels, turning about the mount normal", () => {
  // mechanics.rs, in the part's corner frame (centimetres): a wheel is one sphere of radius min(x, y) / 2 - WHEEL_INSET (2)
  // at (x, y, z) / 2; a track two of radius r = min(x, z) / 2 at (x / 2, r, z / 2) and (x / 2, y - r, z / 2). Every
  // revolute axis is the part's +z. The asset origin is the base cell's centre: (10, 10, 0) cm from the corner.
  const fromCorner = (cm: readonly number[]) => partToGltf([cm[0]! / 100 - 0.1, cm[1]! / 100 - 0.1, cm[2]! / 100]);
  for (const part of LOCOMOTION_PARTS) {
    const [x, y, z] = part.cells.map((c) => c * 20) as [number, number, number];
    const loc = locomotionOf(part);
    assert.deepEqual(loc.axis, [0, 1, 0]);
    const expected = part.type === "wheel"
      ? [{ centre: fromCorner([x / 2, y / 2, z / 2]), radius: (Math.min(x, y) / 2 - 2) / 100 }]
      : [Math.min(x, z) / 2, y - Math.min(x, z) / 2].map((along) => ({ centre: fromCorner([x / 2, along, z / 2]), radius: Math.min(x, z) / 200 }));
    assert.equal(loc.bodies.length, expected.length);
    for (const [i, body] of loc.bodies.entries()) {
      assert.ok(near(body.centre, expected[i]!.centre), `${part.key} ${body.joint}: ${body.centre} is Shooter's ${expected[i]!.centre}`);
      assert.ok(Math.abs(body.radius - expected[i]!.radius) < 1e-9, `${part.key} ${body.joint} radius`);
      const joint = LOCOMOTION_JOINTS[part.key]!.find((j) => j.name === body.joint)!;
      assert.deepEqual([joint.origin, joint.axis, joint.node], [body.centre, loc.axis, body.node]);
      assert.equal(joint.range, undefined, "continuous");
      // The body's disc (Shooter's sphere across its axle) stays inside the part's cuboid.
      const cuboid = partCuboid(part.cells);
      for (const k of [0, 2]) assert.ok(body.centre[k]! - body.radius >= cuboid.min[k]! - 1e-9 && body.centre[k]! + body.radius <= cuboid.max[k]! + 1e-9);
    }
    assert.ok(loc.wheels.length >= loc.bodies.length && loc.bodies.every((body) => loc.wheels.includes(body.node)));
    assert.equal(loc.roll.animation, "roll");
  }
});

test("the belt's links make a seamless roll: a whole number of links per wheel turn round a stadium inside the cuboid", () => {
  const track = locomotionOf(LOCOMOTION_PARTS.find((part) => part.type === "track")!);
  const tread = track.tread!;
  assert.equal(tread.links.length, TRACK_LINKS);
  // One wheel turn moves the belt 2 pi x the rolling radius: exactly PITCHES_PER_TURN links.
  assert.ok(Math.abs(PITCHES_PER_TURN * TRACK_PITCH - 2 * Math.PI * track.rollingRadius) < 1e-12);
  // The links close the loop: two straights between the axles and two half circles at the pitch radius.
  assert.ok(Math.abs(TRACK_LINKS * TRACK_PITCH - (2 * 0.6 + 2 * Math.PI * TRACK_PITCH_RADIUS)) < 1e-12);
  assert.ok(TRACK_PITCH_RADIUS < tread.outerRadius && tread.outerRadius <= track.rollingRadius, "the grousers end inside the 0.1 m rolling circle");
  assert.deepEqual(tread.centres, track.bodies.map((body) => body.centre), "the belt runs round Shooter's two road wheels");
});

test("the review builds assemble flush on the grid without overlaps, every wheel and track on the ground", () => {
  const types = new Map<string, readonly number[]>([...ROBOT_PARTS, ...WEAPON_PARTS, ...LOCOMOTION_PARTS].map((part) => [part.key, part.cells]));
  assert.deepEqual(Object.keys(LOCOMOTION_COMPOSITIONS), ["biped", "wheeler", "strafer", "mini-tank", "crab"]);
  const shown = new Set<string>();
  for (const [name, { items }] of Object.entries(LOCOMOTION_COMPOSITIONS)) {
    const resolved = resolveBuild(items);
    const box = (id: string, transform: Transform, key: string) => {
      const { min, max } = partCuboid(types.get(key)!);
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => apply(transform, [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]));
      return { id, min: [0, 1, 2].map((k) => Math.min(...corners.map((p) => p[k]!))), max: [0, 1, 2].map((k) => Math.max(...corners.map((p) => p[k]!))) };
    };
    const boxes = resolved.map((item) => ({ ...box(item.id, item.transform, item.key), parent: (item as { parent?: string }).parent }));
    const overlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - 1e-6 && b.min[k]! < a.max[k]! - 1e-6);
    const touch = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + 1e-6 && b.min[k]! <= a.max[k]! + 1e-6);
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) assert.ok(!overlap(a, b), `${name}: ${a.id} and ${b.id} overlap`);
      if (a.parent) assert.ok(touch(a, boxes.find((b) => b.id === a.parent)!), `${name}: ${a.id} sits on ${a.parent}`);
    }
    // Every Shooter body of every wheel and track touches the ground (y = 0) with a horizontal axle; nothing is below it.
    let bodies = 0;
    for (const item of resolved) {
      shown.add(item.key);
      const part = LOCOMOTION_PARTS.find((candidate) => candidate.key === item.key);
      if (!part) continue;
      const loc = locomotionOf(part);
      for (const body of loc.bodies) {
        const centre = apply(item.transform, body.centre);
        const axis = apply(item.transform, body.centre.map((c, k) => c + loc.axis[k]!)).map((c, k) => c - centre[k]!);
        assert.ok(Math.abs(centre[1]! - body.radius) < 1e-6, `${name}: ${item.id} ${body.joint} touches the ground (${centre[1]! - body.radius})`);
        assert.ok(Math.abs(axis[1]!) < 1e-9, `${name}: ${item.id} ${body.joint} has a horizontal axle`);
        bodies += 1;
      }
    }
    assert.ok(name === "biped" || bodies >= 4, `${name} rolls on its wheels or tracks`);
    const lowest = Math.min(...boxes.filter((b) => !resolved.find((item) => item.id === b.id)!.key.startsWith("robot.wheel")).map((b) => b.min[1]!));
    assert.ok(lowest > -1e-6, `${name}: nothing but a wheel's cuboid corner reaches below the ground`);
  }
  for (const key of ["robot.wheel", "robot.track", "robot.leg", "weapon.grapple-hook"]) assert.ok(shown.has(key), `${key} is in a review build`);
});
