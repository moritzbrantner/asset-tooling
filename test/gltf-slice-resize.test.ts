import { test } from "node:test";
import assert from "node:assert/strict";
import { Document } from "@gltf-transform/core";
import { documentBounds, sliceResizeDocument } from "../src/gltf-slice-resize.js";

/** Two primitives under a translated, rotated node: a 2 x 1 x 1 "board" (wood) and a small "fitting" (metal). */
function fixture() {
  const document = new Document();
  const buffer = document.createBuffer();
  const wood = document.createMaterial("wood"), metal = document.createMaterial("metal");
  const accessor = (values: number[]) => document.createAccessor().setType("VEC3").setArray(new Float32Array(values)).setBuffer(buffer);
  // In the node's local frame X runs along world -Z after the quarter turn about Y below.
  const xs = [-1, -0.9, 0, 0.9, 1];
  const board = xs.flatMap((x) => [x, 0, -0.5, x, 1, 0.5]);
  const normals = xs.flatMap(() => [0.6, 0.8, 0, 0.6, 0.8, 0]);
  const mesh = document.createMesh("crate")
    .addPrimitive(document.createPrimitive().setAttribute("POSITION", accessor(board)).setAttribute("NORMAL", accessor(normals)).setMaterial(wood))
    .addPrimitive(document.createPrimitive().setAttribute("POSITION", accessor([0.95, 0.5, 0, 0.98, 0.6, 0.1])).setMaterial(metal));
  const node = document.createNode("crate").setMesh(mesh).setTranslation([3, 0.25, -1]).setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  document.createScene().addChild(node);
  return document;
}

test("slice resize stretches only the middle and keeps both end margins and the base", () => {
  const document = fixture();
  const before = documentBounds(document);
  const result = sliceResizeDocument(document, { size: { z: 3, y: 2 }, margin: { x: 0.1, y: 0.2, z: 0.1 } });
  const after = documentBounds(document);
  assert.ok(Math.abs(after.max[2]! - after.min[2]! - 3) < 1e-5, "new Z size");
  assert.ok(Math.abs((after.min[2]! + after.max[2]!) / 2 - (before.min[2]! + before.max[2]!) / 2) < 1e-5, "Z stays centred");
  assert.ok(Math.abs(after.min[1]! - before.min[1]!) < 1e-6 && Math.abs(after.max[1]! - after.min[1]! - 2) < 1e-5, "Y keeps its base");
  assert.deepEqual(result.dropped, []);
  // The vertices at local x = +-0.9 sit on the margin boundary: they move with the ends, 0.1 m inside them.
  const positions = Array.from(document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray()!);
  const localX = positions.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.max(...localX) - 1.5) < 1e-5 && localX.some((x) => Math.abs(x - 1.4) < 1e-5), `${localX}`);
  // Stretched normals are corrected with the inverse scale and stay unit length.
  const normals = Array.from(document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("NORMAL")!.getArray()!);
  for (let i = 0; i < normals.length; i += 3) assert.ok(Math.abs(Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) - 1) < 1e-5);
});

test("slice resize drops a construction part by material and rejects impossible sizes", () => {
  const document = fixture();
  const result = sliceResizeDocument(document, { size: {}, margin: { x: 0.1, y: 0.1, z: 0.1 }, dropMaterials: ["metal"] });
  assert.deepEqual(result.dropped, ["metal"]);
  assert.deepEqual(document.getRoot().listMaterials().map((material) => material.getName()), ["wood"]);
  assert.throws(() => sliceResizeDocument(fixture(), { size: { x: 0.1 }, margin: { x: 0.1, y: 0.1, z: 0.1 } }), /must exceed both margins/);
  assert.throws(() => sliceResizeDocument(fixture(), { size: {}, margin: { x: 0.6, y: 0.1, z: 0.1 } }), /margin/);
  assert.throws(() => sliceResizeDocument(fixture(), { size: {}, margin: { x: 0.1, y: 0.1, z: 0.1 }, dropMaterials: ["glass"] }), /no material named 'glass'/);
});
