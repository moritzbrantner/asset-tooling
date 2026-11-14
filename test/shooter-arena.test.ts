// Shooter arena kit (docs/shooter-arena.md, #593), without Blender: the module table agrees with the recipe's placement
// boxes; every collision proxy lies in its box on whole centimetres; solid modules' proxies fill their box exactly; a
// broken variant's proxies lie inside its intact ones; and the review compositions use every module and variant, meet
// face to face without overlapping proxies, rest on the ground or on each other, and turn into integer Shooter pieces.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ARENA_COMPOSITIONS, ARENA_MODULES, moduleOf, place, shooterPieces, turnRises, worldProxies, type Proxy } from "../scripts/build-shooter-arena.ts";

const EPS = 1e-6;
const lo = (p: Proxy) => p.center.map((c, k) => c - p.size[k]! / 2);
const hi = (p: Proxy) => p.center.map((c, k) => c + p.size[k]! / 2);
const volume = (p: Proxy) => p.size[0]! * p.size[1]! * p.size[2]!;
const overlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
  [0, 1, 2].map((k) => Math.max(0, Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!)));
const isCm = (v: number) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
/** Modules whose proxies are not one solid filling of their box: an opening, leaves lapping into jambs, a trigger, a mast. */
const NOT_FILLED = new Set(["arena.doorway", "arena.door", "arena.jump-pad", "arena.hull-mast"]);

test("the module table matches the recipe's parts and placement boxes", async () => {
  const recipe = await readFile(new URL("../adapters/blender/shooter_arena.py", import.meta.url), "utf8");
  const boxes = new Map<string, number[][]>();
  for (const match of recipe.matchAll(/"(arena\.[a-z-]+)": \(\(([^)]*)\), \(([^)]*)\)\)/g)) {
    const values = (text: string) => text.split(",").map((v) => v.trim()).map((v) => (v === "T" ? 0.3 : v === "-T" ? -0.3 : Number(v)));
    boxes.set(match[1]!, [values(match[2]!), values(match[3]!)]);
  }
  assert.deepEqual([...boxes.keys()].sort(), ARENA_MODULES.map((m) => m.key).sort());
  for (const module of ARENA_MODULES) {
    assert.deepEqual(boxes.get(module.key), [module.box.min, module.box.max], module.key);
    assert.match(recipe, new RegExp(`"${module.key.replace(".", "\\.")}"`));
  }
  const broken = recipe.match(/BROKEN = \(([^)]*)\)/)![1]!.split(",").map((s) => s.trim().replaceAll('"', "")).filter(Boolean).sort();
  assert.deepEqual(broken, ARENA_MODULES.filter((m) => m.broken).map((m) => m.key).sort());
});

test("every proxy lies in its placement box on whole centimetres, and solid modules are filled exactly", () => {
  for (const module of ARENA_MODULES) {
    for (const variant of [module.proxies, module.broken ?? []]) {
      for (const proxy of variant) {
        const [a, b] = [lo(proxy), hi(proxy)];
        for (const k of [0, 1, 2]) {
          assert.ok(isCm(a[k]!) && isCm(b[k]!), `${module.key} ${proxy.name} has an edge off the centimetre`);
          if (proxy.tag !== "trigger") assert.ok(a[k]! >= module.box.min[k]! - EPS && b[k]! <= module.box.max[k]! + EPS, `${module.key} ${proxy.name} leaves its box`);
        }
        assert.ok(proxy.shape === "box" || proxy.rises, `${module.key} ${proxy.name}: a ramp names its rise`);
      }
      for (let i = 0; i < variant.length; i += 1) for (let j = i + 1; j < variant.length; j += 1) {
        const o = overlap({ min: lo(variant[i]!), max: hi(variant[i]!) }, { min: lo(variant[j]!), max: hi(variant[j]!) });
        assert.ok(o[0]! * o[1]! * o[2]! < EPS, `${module.key}: ${variant[i]!.name} overlaps ${variant[j]!.name}`);
      }
    }
    for (const k of [0, 1, 2]) assert.ok(isCm(module.box.min[k]!) && isCm(module.box.max[k]!), `${module.key} box off the centimetre`);
    if (!NOT_FILLED.has(module.key)) {
      const box = [0, 1, 2].map((k) => module.box.max[k]! - module.box.min[k]!);
      assert.ok(Math.abs(module.proxies.reduce((sum, p) => sum + volume(p), 0) - box[0]! * box[1]! * box[2]!) < EPS, `${module.key}: proxies do not fill the box`);
    }
  }
  const doorway = moduleOf("arena.doorway");
  const opening = (doorway.extras!.doorway as { min: number[]; max: number[] });
  for (const proxy of doorway.proxies) {
    const o = overlap(opening, { min: lo(proxy), max: hi(proxy) });
    assert.ok(o[0]! * o[1]! * o[2]! < EPS, `${proxy.name} reaches into the doorway`);
  }
  for (const proxy of moduleOf("arena.door").proxies) {
    for (const k of [0, 1]) assert.ok(lo(proxy)[k]! >= opening.min[k]! - EPS && hi(proxy)[k]! <= opening.max[k]! + EPS, `${proxy.name} leaves the opening`);
  }
});

test("a broken variant keeps its placement and its proxies lie inside the intact ones", () => {
  for (const module of ARENA_MODULES.filter((m) => m.broken)) {
    for (const proxy of module.broken!) {
      const inside = module.proxies.some((whole) => [0, 1, 2].every((k) => lo(proxy)[k]! >= lo(whole)[k]! - EPS && hi(proxy)[k]! <= hi(whole)[k]! + EPS));
      assert.ok(inside, `${module.key} broken ${proxy.name} is not inside an intact proxy`);
      assert.equal(proxy.tag, "blocked");
    }
    assert.ok(module.broken!.reduce((sum, p) => sum + volume(p), 0) < module.proxies.reduce((sum, p) => sum + volume(p), 0), `${module.key}: broken is not smaller`);
  }
});

test("yaw turns points and ramp rises the way Shooter's RampRise turns", () => {
  assert.deepEqual(place([1, 0, 0], 90, [0, 0, 0]), [0, 0, -1]);
  assert.deepEqual(place([0, 0, 1], 90, [0, 0, 0]), [1, 0, 0]);
  assert.equal(turnRises("-Z", 0), "-Z");
  assert.equal(turnRises("-Z", 90), "-X");
  assert.equal(turnRises("-Z", 180), "+Z");
  assert.equal(turnRises("-Z", 270), "+X");
});

test("the review compositions use every module and variant, meet without overlaps and rest on something", () => {
  const used = new Set<string>();
  for (const [name, { items }] of Object.entries(ARENA_COMPOSITIONS)) {
    for (const item of items) {
      const module = moduleOf(item.key);
      used.add(`${item.key}#${item.variant ?? "default"}`);
      if (item.variant === "broken") assert.ok(module.broken, `${name}: ${item.key} has no broken variant`);
      for (const c of item.translation) assert.ok(isCm(c), `${name}: ${item.key} off the centimetre`);
    }
    const proxies = worldProxies(items).filter((p) => p.tag !== "trigger");
    for (let i = 0; i < proxies.length; i += 1) for (let j = i + 1; j < proxies.length; j += 1) {
      const [a, b] = [proxies[i]!, proxies[j]!];
      if (a.item === b.item) continue;
      const o = overlap(a, b);
      assert.ok(o[0]! * o[1]! * o[2]! < EPS, `${name}: ${items[a.item]!.key} ${a.name} overlaps ${items[b.item]!.key} ${b.name} at ${a.center}`);
    }
    items.forEach((item, index) => {
      const own = worldProxies(items).filter((p) => p.item === index);
      if (own.some((p) => p.min[1]! <= EPS)) return;
      const touches = own.some((p) => proxies.some((q) => {
        if (q.item === index) return false;
        const o = overlap(p, q);
        const contact = [0, 1, 2].filter((k) => o[k]! < EPS && (Math.abs(p.max[k]! - q.min[k]!) < EPS || Math.abs(p.min[k]! - q.max[k]!) < EPS));
        return contact.length === 1 && [0, 1, 2].filter((k) => k !== contact[0]).every((k) => o[k]! > EPS);
      }));
      assert.ok(touches, `${name}: ${item.key} at ${item.translation} floats`);
    });
    for (const piece of shooterPieces(items)) {
      for (const v of [...piece.center, ...piece.half]) assert.ok(Number.isInteger(v), `${name}: a ${piece.piece} is off the centimetre`);
    }
  }
  for (const module of ARENA_MODULES) {
    assert.ok(used.has(`${module.key}#default`), `no composition shows ${module.key}`);
    if (module.broken) assert.ok(used.has(`${module.key}#broken`), `no composition shows ${module.key} broken`);
  }
});

test("Shooter's greybox-yard walls, walkway, ramps and pads compose from the kit's modules", () => {
  // The yard's 5 m wall line block([-1600, 250, -1200], [800, 250, 30]): eight 5 m walls; its walkway deck and support
  // and a 12 m ramp: block([0, 280, 0], [1600, 20, 200]), block([800, 130, 0], [50, 130, 50]), ramp([2200, 150, 0], [600, 150, 200], NegX).
  const items = [
    ...Array.from({ length: 8 }, (_, i) => ({ key: "arena.wall-tall", translation: [-23 + 2 * i, 0, -12] as [number, number, number] })),
    { key: "arena.walkway", translation: [1, 2.6, 0] as [number, number, number] },
    { key: "arena.support", translation: [8, 0, 0] as [number, number, number] },
    { key: "arena.ramp-tall", translation: [22, 0, -1] as [number, number, number], yawDegrees: 90 as const },
    { key: "arena.ramp-tall", translation: [22, 0, 1] as [number, number, number], yawDegrees: 90 as const },
    { key: "arena.jump-pad", translation: [-12, 0, -5] as [number, number, number] },
  ];
  const pieces = shooterPieces(items);
  const walls = pieces.slice(0, 8);
  assert.equal(Math.min(...walls.map((w) => w.center[0]! - w.half[0]!)), -2400);
  assert.equal(Math.max(...walls.map((w) => w.center[0]! + w.half[0]!)), -800);
  assert.ok(walls.every((w) => w.center[1] === 250 && w.half[1] === 250 && w.center[2] === -1200 && w.half[2] === 30));
  assert.deepEqual(pieces[8], { piece: "Block", center: [100, 280, 0], half: [100, 20, 200], tag: "walkable" });
  assert.deepEqual(pieces[9], { piece: "Block", center: [800, 130, 0], half: [50, 130, 50], tag: "blocked" });
  assert.deepEqual(pieces[10], { piece: "Ramp", center: [2200, 150, -100], half: [600, 150, 100], rises: "NegX" });
  assert.deepEqual(pieces[12], { piece: "JumpPad", center: [-1200, 0, -500], half: [80, 80] });
});
