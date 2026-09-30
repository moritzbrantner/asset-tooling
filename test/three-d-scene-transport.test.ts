import test from "node:test";
import assert from "node:assert/strict";
import { parseThreeDSceneBytes } from "../src/three-d-scene-transport.js";

function canonicalScene() {
  return {
    schemaVersion: 1,
    coordinateSystem: "right-handed-y-up",
    unit: "meter",
    meshes: [
      {
        id: "mesh",
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        indices: [0, 1, 2],
      },
    ],
    nodes: [
      {
        id: "root",
        parent: null,
        mesh: "mesh",
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    ],
  };
}

function sceneBytes(document) {
  return Buffer.from(JSON.stringify(document), "utf8");
}

test("canonical scene validation accepts compact first-use vertex order", () => {
  const parsed = parseThreeDSceneBytes(sceneBytes(canonicalScene()), "fixture", {
    requireCanonical: true,
  });
  assert.equal(parsed.vertexCount, 3);
  assert.equal(parsed.triangleCount, 1);
});

test("canonical scene validation rejects negative zero before bytes are stored", () => {
  const json = JSON.stringify(canonicalScene()).replace(
    '"translation":[0,0,0]',
    '"translation":[-0,0,0]',
  );
  assert.match(json, /-0/);
  assert.throws(
    () => parseThreeDSceneBytes(Buffer.from(json, "utf8"), "fixture", { requireCanonical: true }),
    /positive zero in canonical output/,
  );
});

test("canonical scene validation rejects unused vertices", () => {
  const document = canonicalScene();
  document.meshes[0].vertices.push([2, 2, 2]);
  assert.throws(
    () => parseThreeDSceneBytes(sceneBytes(document), "fixture", { requireCanonical: true }),
    /must not contain unused vertices after normalization/,
  );
});

test("canonical scene validation rejects noncanonical first-use vertex order", () => {
  const document = canonicalScene();
  document.meshes[0].indices = [0, 2, 1];
  assert.throws(
    () => parseThreeDSceneBytes(sceneBytes(document), "fixture", { requireCanonical: true }),
    /canonical first-index-use vertex order/,
  );
});
