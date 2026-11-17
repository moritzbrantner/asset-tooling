// #737: the combat-animation checks on a small stand-in rig: a weapon through the torso, a planted foot that slides and
// a strike no faster than its wind-up each fail, and their clean counterparts pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, type Node } from "@gltf-transform/core";
import { CLEARANCE_SUBSTEPS, CLEARANCE_TOLERANCE, PLANTED_DRIFT_LIMIT, STRIKE_SPEED_RATIO, checkCombatClip, combatCheckEntry } from "../src/combat-clip-checks.ts";

const SOCKETS = [{ id: "hand_r.weapon", joint: "hand_r", translation: [0, 0, 0], rotation: [0, 0, 0, 1] }];
const FRAMES = 13;

/** A figure facing +Z: the pelvis at 0.9 m, the neck at 1.5, the head above, thighs to the knees, both hands and balls. */
function figure() {
  const document = new Document();
  const buffer = document.createBuffer(), scene = document.createScene();
  const nodes = new Map<string, Node>();
  const add = (name: string, at: number[], parent?: Node) => {
    const node = document.createNode(name).setTranslation(at as [number, number, number]);
    (parent ?? scene).addChild(node);
    nodes.set(name, node);
    return node;
  };
  const pelvis = add("pelvis", [0, .9, 0]);
  const neck = add("neck_01", [0, .6, 0], pelvis);
  add("Head", [0, .08, 0], neck);
  for (const side of ["l", "r"]) {
    const thigh = add(`thigh_${side}`, [side === "l" ? .1 : -.1, -.05, 0], pelvis);
    const calf = add(`calf_${side}`, [0, -.4, 0], thigh);
    add(`ball_${side}`, [0, -.43, .1], calf);
  }
  add("hand_l", [.4, .2, .3], pelvis);
  add("hand_r", [-.6, .1, .4], pelvis);
  const clip = (name: string, tracks: Record<string, (frame: number) => number[]>) => {
    const animation = document.createAnimation(name);
    const input = document.createAccessor().setType("SCALAR").setBuffer(buffer)
      .setArray(new Float32Array(Array.from({ length: FRAMES }, (_, frame) => frame / 30)));
    for (const [joint, at] of Object.entries(tracks)) {
      const output = document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(new Float32Array(Array.from({ length: FRAMES }, (_, frame) => at(frame)).flat()));
      const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
      animation.addSampler(sampler).addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(nodes.get(joint)!).setTargetPath("translation"));
    }
  };
  // Clean: the hand creeps for the wind-up (10 frames, 1 cm each) and strikes in three (20 cm each), out to the side.
  const swing = (x: number) => (frame: number) => [x, .1, .4 + (frame <= 10 ? frame * .01 : .1 + (frame - 10) * .2)];
  clip("Clean_Strike", { hand_r: swing(-.6), ball_l: () => [0, -.43, .1] });
  // An in-place run at 6 m/s: the left ball moves back with the ground (20 cm a frame); a short stride's at half that.
  clip("Run", { ball_l: (frame) => [0, -.43, .1 - frame * .2] });
  clip("Short_Run", { ball_l: (frame) => [0, -.43, .1 - frame * .1] });
  // The blade held upright at the chest, the left ball sliding 1 cm a frame, the hand at one speed throughout.
  clip("Bad_Strike", { hand_r: (frame) => [-.02, .1, .02 + frame * .02], ball_l: (frame) => [0, -.43, .1 + frame * .01] });
  // mmorpg#804: every key clear of the body, the hand crossing in front of it from one key to the next.
  clip("Whip_Strike", { hand_r: (frame) => [frame <= 6 ? -.6 : .6, .1, 0] });
  return document;
}

const entry = (name: string) => ({
  name, durationSeconds: .4,
  strike: {
    weapon: { item: "equipment.sword.arming", socket: "hand_r.weapon", strikePoint: [0, .84, 0] },
    contactSeconds: .4, windupEnd: 10 / 30, footPlants: { l: [[0, .4]] },
  },
});

test("#737: a clean strike clears the body, keeps its planted foot and strikes much faster than it winds up", () => {
  const report = checkCombatClip(figure(), entry("Clean_Strike"), SOCKETS);
  assert.ok(report.clearance!.ok && report.clearance!.worstMeters <= CLEARANCE_TOLERANCE, JSON.stringify(report.clearance));
  assert.ok(report.feet!.ok && report.feet!.worstMeters < 1e-6);
  assert.ok(report.timing!.ok && report.timing!.ratio >= STRIKE_SPEED_RATIO && !report.timing!.inferredWindupEnd, JSON.stringify(report.timing));
  assert.ok(Math.abs(report.timing!.windupMeanSpeed - .3) < .01 && Math.abs(report.timing!.strikePeakSpeed - 6) < .01);
});

test("#737: a blade through the torso, a sliding planted foot and an even-paced strike each fail, with the worst frame named", () => {
  const report = checkCombatClip(figure(), entry("Bad_Strike"), SOCKETS);
  assert.equal(report.clearance!.ok, false);
  assert.ok(["torso", "head"].includes(report.clearance!.part) && report.clearance!.worstMeters > .1);
  assert.ok(report.clearance!.frame >= 0 && report.clearance!.alongItemMeters > 0);
  assert.equal(report.feet!.ok, false);
  assert.ok(Math.abs(report.feet!.worstMeters - .12) < 1e-3 && report.feet!.worstMeters > PLANTED_DRIFT_LIMIT && report.feet!.foot === "l");
  assert.equal(report.timing!.ok, false);
  assert.ok(Math.abs(report.timing!.ratio - 1) < .01);
});

test("#737: without a recorded wind-up end the check takes the slowest frame before the contact; data a clip lacks is not checked", () => {
  const { strike, ...rest } = entry("Clean_Strike");
  const { windupEnd: _, footPlants: __, ...timingOnly } = strike;
  const report = checkCombatClip(figure(), { ...rest, strike: timingOnly }, SOCKETS);
  assert.ok(report.timing!.inferredWindupEnd && report.timing!.windupEnd < .4);
  assert.equal(report.feet, undefined);
  const bare = checkCombatClip(figure(), { name: "Clean_Strike", durationSeconds: .4 }, SOCKETS);
  assert.deepEqual(bare, { clip: "Clean_Strike" });
});

test("mmorpg#804: a weapon that whips through the body between two clean keys fails when the check samples between them", () => {
  const keys = checkCombatClip(figure(), entry("Whip_Strike"), SOCKETS);
  assert.ok(keys.clearance!.ok, JSON.stringify(keys.clearance));
  const between = checkCombatClip(figure(), entry("Whip_Strike"), SOCKETS, { substeps: CLEARANCE_SUBSTEPS });
  assert.equal(between.clearance!.ok, false);
  assert.ok(between.clearance!.frame > 6 && between.clearance!.frame < 7 && between.clearance!.part === "torso", JSON.stringify(between.clearance));
});

test("mmorpg#804: a strike without a strike object is checked with its role family's item and its measured contact", () => {
  const clip = { name: "Whip_Strike", durationSeconds: .4, contact: { seconds: .2 } };
  assert.deepEqual(combatCheckEntry({ ...clip, role: "mace.strike.backhand" })!.strike, { weapon: { item: "equipment.mace.flanged", socket: "hand_r.weapon", strikePoint: [0, .5, 0] }, contactSeconds: .2 });
  assert.equal(combatCheckEntry({ ...clip, role: "staff.strike.jab" }, { l: [[0, .4]] })!.strike!.weapon!.socket, "hand_r.staff");
  assert.deepEqual(combatCheckEntry({ ...clip, role: "staff.strike.jab" }, { l: [[0, .4]] })!.strike!.footPlants, { l: [[0, .4]] });
  assert.equal(combatCheckEntry({ ...clip, role: "staff.draw" }), undefined);
  assert.equal(combatCheckEntry({ ...clip, role: "bow.shot" }), undefined);
  const recorded = entry("Clean_Strike");
  assert.equal(combatCheckEntry(recorded), recorded);
});

test("#804: an in-place gait's planted ball keeps pace with the ground its travel stands for, and a short stride fails", () => {
  const gait = (name: string) => ({ name, durationSeconds: .4, footPlants: { l: [[0, .2]] }, sourceRootDisplacement: { x: 0, y: 0, z: 2.4 } });
  const run = checkCombatClip(figure(), gait("Run"), SOCKETS);
  assert.ok(run.feet!.ok && run.feet!.worstMeters < 1e-6, JSON.stringify(run.feet));
  assert.equal(run.clearance, undefined);
  assert.equal(run.timing, undefined);
  const short = checkCombatClip(figure(), gait("Short_Run"), SOCKETS);
  assert.equal(short.feet!.ok, false);
  assert.ok(Math.abs(short.feet!.worstMeters - .6) < 1e-3, JSON.stringify(short.feet));
});
