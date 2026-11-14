// The socket-grid convention (src/socket-grid.ts) against Shooter's catalog (crates/shooter-sim/src/robot.rs): socket
// counts and numbering, the asset frame, and the review compositions assembling flush on the grid without overlaps.
import test from "node:test";
import assert from "node:assert/strict";
import { FACES, QUARTER_TURN, SOCKET_FACES, apply, compose, faceGrid, mountTransform, partCuboid, partSockets, revoluteFrames } from "../src/socket-grid.ts";
import { LEG_CLIPS, PLACEHOLDER_PARTS, ROBOT_COMPOSITIONS, ROBOT_JOINTS, ROBOT_PARTS, resolveComposition, socketGridConvention } from "../scripts/build-combat-robot.ts";

const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!].map((c) => c || 0);

test("the kit's parts are Shooter's catalog rows, with its socket counts", () => {
  const rows = Object.fromEntries(ROBOT_PARTS.map((part) => [part.key, [part.cells, part.sockets]]));
  // robot.rs parts: key, cells, socket faces (robot.battery from shooter#79).
  assert.deepEqual(rows, {
    "robot.chassis.20x40x80": [[1, 2, 4], "ALL"], "robot.chassis.40x40x80": [[2, 2, 4], "ALL"], "robot.chassis.40x60x80": [[2, 3, 4], "ALL"],
    "robot.beam.20x20x40": [[1, 1, 2], "ALL"], "robot.beam.20x20x80": [[1, 1, 4], "ALL"],
    "robot.core": [[1, 1, 1], "NONE"], "robot.sensor": [[1, 1, 1], "NONE"], "robot.battery": [[1, 2, 1], "NONE"], "robot.armor.plate": [[2, 2, 1], "NONE"],
    "robot.joint.hinge": [[1, 1, 1], "TOP"], "robot.joint.rotor": [[1, 1, 1], "TOP"], "robot.leg": [[1, 1, 4], "NONE"],
  });
  const count = (key: string) => { const part = ROBOT_PARTS.find((p) => p.key === key)!; return partSockets(part.cells, SOCKET_FACES[part.sockets]).length; };
  assert.equal(count("robot.joint.hinge"), 1);
  assert.equal(count("robot.joint.rotor"), 1);
  assert.equal(count("robot.leg"), 0);
  assert.equal(count("robot.chassis.20x40x80"), 28);
  assert.equal(count("robot.chassis.40x40x80"), 40);
  assert.equal(count("robot.chassis.40x60x80"), 52);
  assert.equal(count("robot.beam.20x20x40"), 10);
  assert.equal(count("robot.beam.20x20x80"), 18);
  assert.equal(count("robot.core"), 0);
  assert.equal(ROBOT_PARTS.find((p) => p.key === "robot.armor.plate")!.variants.includes("damaged"), true);
});

test("sockets follow Shooter's numbering and sit on their faces, one per cell", () => {
  const cells = [1, 2, 4];
  const sockets = partSockets(cells, FACES);
  // Shooter's frame(): the arm on PosY at (side - 1, 0) and on NegY at (0, right - 1), the core on NegX at (2, 0).
  assert.equal(sockets.find((s) => s.face === "PosY" && s.u === 3 && s.v === 0)!.id, 8 + 8 + 3);
  assert.equal(sockets.find((s) => s.face === "NegX" && s.u === 2 && s.v === 0)!.id, 8 + 2);
  assert.deepEqual(faceGrid("NegY", cells), [1, 4]);
  const cuboid = partCuboid(cells);
  assert.deepEqual(cuboid, { min: [-0.1, 0, -0.3], max: [0.1, 0.8, 0.1] });
  for (const socket of sockets) {
    assert.deepEqual(cross(socket.uAxis, socket.vAxis), socket.normal, `${socket.face}: u x v is the normal`);
    const axis = socket.normal.findIndex((c) => c !== 0);
    const plane = socket.normal[axis]! > 0 ? cuboid.max[axis]! : cuboid.min[axis]!;
    assert.ok(Math.abs(socket.position[axis]! - plane) < 1e-9, `${socket.face} (${socket.u}, ${socket.v}) is on its face`);
    for (let k = 0; k < 3; k += 1) if (k !== axis) {
      const offset = (socket.position[k]! - cuboid.min[k]!) / 0.2;
      assert.ok(Math.abs(offset - Math.floor(offset) - 0.5) < 1e-9, `${socket.face} (${socket.u}, ${socket.v}) is at a cell centre`);
    }
  }
  // The base cell (0, 0) of the mount face is the origin.
  assert.deepEqual(sockets.find((s) => s.face === "NegZ" && s.u === 0 && s.v === 0)!.position, [0, 0, 0]);
});

test("a quarter turn on a socket turns the footprint as Shooter's footprint() does", () => {
  const socket = partSockets([2, 2, 4], ["PosZ"]).find((s) => s.u === 0 && s.v === 0)!;
  // A 1 x 2 base at no turn reserves (u, v + 1); a quarter turn reserves (u - 1, v), i.e. (i, j) -> (-j, i).
  const cellCentre = (transform: ReturnType<typeof mountTransform>, i: number, j: number) => apply(transform, [i * 0.2, 0, -j * 0.2]);
  assert.deepEqual(cellCentre(mountTransform(socket), 0, 1).map((c) => Math.round(c * 1e6) / 1e6), [0, 0.8, -0.2]);
  assert.deepEqual(cellCentre(mountTransform(socket, { yaw: QUARTER_TURN, pitch: 0, roll: 0 }), 0, 1).map((c) => Math.round(c * 1e6) / 1e6 || 0), [-0.2, 0.8, 0]);
});

test("the review compositions assemble flush on the grid without overlaps", () => {
  assert.equal(socketGridConvention().frame.origin, "mount-anchor");
  const types = new Map([...ROBOT_PARTS, ...PLACEHOLDER_PARTS].map((part) => [part.key, part]));
  for (const [name, { items }] of Object.entries(ROBOT_COMPOSITIONS)) {
    const resolved = resolveComposition(items);
    const boxes = resolved.map((item) => {
      const { min, max } = partCuboid(types.get(item.key)!.cells);
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => apply(item.transform, [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]));
      return { id: item.id, parent: (item as { parent?: string }).parent, min: [0, 1, 2].map((k) => Math.min(...corners.map((p) => p[k]!))), max: [0, 1, 2].map((k) => Math.max(...corners.map((p) => p[k]!))) };
    });
    const overlap = (a: (typeof boxes)[number], b: (typeof boxes)[number]) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - 1e-6 && b.min[k]! < a.max[k]! - 1e-6);
    const touch = (a: (typeof boxes)[number], b: (typeof boxes)[number]) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + 1e-6 && b.min[k]! <= a.max[k]! + 1e-6);
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) assert.ok(!overlap(a, b), `${name}: ${a.id} and ${b.id} overlap`);
      if (a.parent) assert.ok(touch(a, boxes.find((b) => b.id === a.parent)!), `${name}: ${a.id} sits on ${a.parent}`);
    }
    assert.ok(Math.min(...boxes.map((b) => b.min[1]!)) > -1e-6, `${name} stands on the ground`);
  }
});

const near = (a: readonly number[], b: readonly number[]) => a.every((c, k) => Math.abs(c - b[k]!) < 1e-9);

test("joint frames: unit part axes through the part's centre line, the moving socket on the axis's far side", () => {
  for (const part of ROBOT_PARTS) {
    const { joints = [], anchors = [] } = ROBOT_JOINTS[part.key] ?? {};
    assert.equal(joints.length > 0, part.kind === "joint" || part.key === "robot.leg", `${part.key} has joints exactly when it articulates`);
    const cuboid = partCuboid(part.cells);
    const sockets = partSockets(part.cells, SOCKET_FACES[part.sockets]);
    for (const joint of joints) {
      assert.equal(Math.hypot(...joint.axis), 1, `${part.key} ${joint.name}: unit axis`);
      assert.equal(joint.axis.filter((c) => c !== 0).length, 1, `${part.key} ${joint.name}: along a part axis`);
      assert.ok(joint.origin.every((c, k) => c > cuboid.min[k]! && c < cuboid.max[k]!), `${part.key} ${joint.name}: pivot inside the part`);
      assert.ok(joint.origin[0] === 0 && joint.origin[2] === 0, `${part.key} ${joint.name}: on the centre line`);
      if (joint.parent) assert.ok(joints.some((other) => other.name === joint.parent), `${part.key} ${joint.name}: parent joint exists`);
      for (const id of joint.movingSockets ?? []) {
        assert.equal(sockets[id]!.face, "PosZ", `${part.key}: the moving side is the top (Faces::TOP)`);
        assert.ok(sockets[id]!.position[1] > joint.origin[1], `${part.key}: the socket is beyond the pivot`);
      }
      if (joint.range) assert.ok(joint.range[0] < joint.range[1]);
    }
    for (const anchor of anchors) assert.ok(joints.some((joint) => joint.node === anchor.node), `${part.key} ${anchor.name} rides a joint node`);
  }
  // The hinge pitches about x, the rotor turns about the socket normal, the leg's three joints are a chain about x.
  assert.deepEqual(ROBOT_JOINTS["robot.joint.hinge"]!.joints.map((j) => [j.origin, j.axis, j.movingSockets]), [[[0, 0.1, 0], [1, 0, 0], [0]]]);
  assert.deepEqual(ROBOT_JOINTS["robot.joint.rotor"]!.joints.map((j) => [j.origin, j.axis, j.movingSockets]), [[[0, 0.1, 0], [0, 1, 0], [0]]]);
  assert.deepEqual(ROBOT_JOINTS["robot.leg"]!.joints.map((j) => [j.name, j.parent ?? null]), [["hip", null], ["knee", "hip"], ["ankle", "knee"]]);
  assert.deepEqual(ROBOT_JOINTS["robot.leg"]!.anchors[0]!.position, [0, 0.8, -0.01]);
  assert.deepEqual(Object.values(LEG_CLIPS["walk-quadruped"].phases).sort(), [0, 0.25, 0.5, 0.75]);
});

test("revolute frames: the child on the moving socket gets the same pivot and axis in its own frame", () => {
  const top = partSockets([1, 1, 1], SOCKET_FACES.TOP)[0]!;
  const hinge = ROBOT_JOINTS["robot.joint.hinge"]!.joints[0]!, rotor = ROBOT_JOINTS["robot.joint.rotor"]!.joints[0]!;
  assert.deepEqual(revoluteFrames(hinge, top), { anchorA: [0, 0.1, 0], axisA: [1, 0, 0], anchorB: [0, -0.1, 0], axisB: [1, 0, 0] });
  // A child turned a quarter on the rotor still turns about its own up axis; on the hinge the axis turns with it.
  assert.deepEqual(revoluteFrames(rotor, top, { yaw: QUARTER_TURN, pitch: 0, roll: 0 }).axisB, [0, 1, 0]);
  const turned = revoluteFrames(hinge, top, { yaw: QUARTER_TURN, pitch: 0, roll: 0 });
  assert.ok(near(turned.axisB, [0, 0, 1]) || near(turned.axisB, [0, 0, -1]), `${turned.axisB}`);
  // Mapped back through the mount, body B's anchor is body A's.
  assert.ok(near(apply(mountTransform(top, { yaw: QUARTER_TURN, pitch: 0, roll: 0 }), turned.anchorB), hinge.origin));
});

test("the review builds articulate as intended: legs walk forward, rotors turn about up, hinges pitch the guns", () => {
  assert.deepEqual(Object.keys(ROBOT_COMPOSITIONS), ["humanoid", "robo-dog", "mini-tank", "turret"]);
  const world = (name: string) => new Map(resolveComposition(ROBOT_COMPOSITIONS[name]!.items).map((item) => [item.id, item]));
  const dir = (item: { transform: Parameters<typeof compose>[0] }, v: number[]) => apply({ ...item.transform, translation: [0, 0, 0] }, v).map((c) => Math.round(c * 1e6) / 1e6 || 0);
  for (const name of ["humanoid", "robo-dog"]) for (const item of world(name).values()) if (item.key === "robot.leg") {
    assert.deepEqual(dir(item, [0, 0, -1]), [1, 0, 0], `${name} ${item.id}: the toe (+y) faces +X`);
    assert.deepEqual(dir(item, [0, 1, 0]), [0, -1, 0], `${name} ${item.id}: hangs down`);
    assert.equal(Math.abs(dir(item, [1, 0, 0])[2]!), 1, `${name} ${item.id}: its joints turn about a sideways axis`);
  }
  for (const name of ["mini-tank", "turret"]) {
    const items = world(name);
    assert.deepEqual(dir(items.get("rotor")!, [0, 1, 0]), [0, 1, 0], `${name}: the rotor turns about up`);
    assert.equal(Math.abs(dir(items.get("elevation")!, [1, 0, 0])[2]!), 1, `${name}: the hinge pitches about a sideways axis`);
  }
  const neck = world("robo-dog").get("neck")!;
  assert.equal(Math.abs(dir(neck, [1, 0, 0])[2]!), 1, "the dog's head nods");
});
