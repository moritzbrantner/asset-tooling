// #318 damage-state collision helpers and recipe table (src/damage-recipe.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { DAMAGE_RECIPES, clipBox, damageLodVariant, subtractBox, type Box } from "../src/damage-recipe.js";
import { DEBRIS_PLANES } from "../src/debris-recipe.js";

const volume = (box: Box) => [0, 1, 2].reduce((product, axis) => product * (box.max[axis]! - box.min[axis]!), 1);

test("subtracting a breach leaves boxes that tile the rest and never enter the breach", () => {
  const wall: Box = { min: [-1, 0, -0.2], max: [1, 3, 0.2] };
  const breach: Box = { min: [-0.4, 1, -0.3], max: [0.5, 2, 0.3] };
  const pieces = subtractBox(wall, breach);
  assert.equal(pieces.length, 4, "left, right, below and above; the breach goes through the thickness");
  const overlap = (a: Box, b: Box) => [0, 1, 2].reduce((v, i) => v * Math.max(0, Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!)), 1);
  for (const piece of pieces) assert.equal(overlap(piece, breach), 0);
  const removed = overlap(wall, breach);
  assert.ok(Math.abs(pieces.reduce((sum, piece) => sum + volume(piece), 0) - (volume(wall) - removed)) < 1e-9);
});

test("a breach outside the box leaves it whole; one covering it removes it", () => {
  const post: Box = { min: [0, 0, 0], max: [0.2, 3, 0.2] };
  assert.deepEqual(subtractBox(post, { min: [1, 0, 0], max: [2, 1, 1] }), [post]);
  assert.deepEqual(subtractBox(post, { min: [-1, -1, -1], max: [1, 4, 1] }), []);
});

test("slivers thinner than the minimum are dropped", () => {
  const pieces = subtractBox({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [0.01, -1, -1], max: [2, 2, 2] });
  assert.deepEqual(pieces, []);
});

test("clipping to the stub keeps the lower part and drops boxes above it", () => {
  const stub: Box = { min: [-1, 0, -0.2], max: [1, 1.1, 0.2] };
  assert.deepEqual(clipBox({ min: [-1, 0, -0.1], max: [-0.6, 3, 0.1] }, stub), { min: [-1, 0, -0.1], max: [-0.6, 1.1, 0.1] });
  assert.equal(clipBox({ min: [-0.6, 2.2, -0.1], max: [0.6, 3, 0.1] }, stub), undefined);
});

test("every destructible piece has damaged, destroyed and debris cuts", () => {
  assert.deepEqual(Object.keys(DAMAGE_RECIPES).sort(), ["corner", "floor", "roof", "wall", "wall-plain"]);
  for (const [role, recipe] of Object.entries(DAMAGE_RECIPES)) {
    assert.ok(recipe.damaged.length >= 1 && recipe.damaged.length <= 4, role);
    assert.ok(recipe.destroyed.length >= 1 && recipe.destroyed.length <= 4, role);
    for (const breach of recipe.damaged) assert.ok(breach.radius.every((r) => r > 0) && breach.center.every((f) => f >= 0 && f <= 1), role);
    assert.ok((DEBRIS_PLANES as Record<string, unknown>)[role], `${role} has debris planes`);
  }
  assert.equal(damageLodVariant("damaged", "lod1"), "damaged-lod1");
});
