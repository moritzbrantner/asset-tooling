import test from "node:test";
import assert from "node:assert/strict";
import { parseCanonicalGlbBytes } from "../src/canonical-glb-validation.js";

function canonicalDocument() {
  return {
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
      },
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5125,
        count: 3,
        type: "SCALAR",
      },
    ],
    asset: { generator: "test", version: "2.0" },
    bufferViews: [
      { buffer: 0, byteLength: 36, byteOffset: 0, target: 34962 },
      { buffer: 0, byteLength: 12, byteOffset: 36, target: 34963 },
    ],
    buffers: [{ byteLength: 48 }],
    meshes: [
      {
        name: "triangle",
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }],
      },
    ],
    nodes: [
      {
        name: "root",
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        mesh: 0,
      },
    ],
    scene: 0,
    scenes: [{ name: "scene", nodes: [0] }],
  };
}

function binaryPayload({ outOfRangeIndex = false } = {}) {
  const bytes = Buffer.alloc(48);
  const positions = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];
  positions.forEach((position, vertex) => {
    position.forEach((value, axis) => bytes.writeFloatLE(value, vertex * 12 + axis * 4));
  });
  [0, 1, outOfRangeIndex ? 3 : 2].forEach((value, index) =>
    bytes.writeUInt32LE(value, 36 + index * 4),
  );
  return bytes;
}

function glb(document, binary = binaryPayload()) {
  let jsonBytes = Buffer.from(JSON.stringify(document), "utf8");
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPadding > 0) {
    jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
  }
  const binaryPadding = (4 - (binary.length % 4)) % 4;
  const binaryBytes =
    binaryPadding === 0 ? binary : Buffer.concat([binary, Buffer.alloc(binaryPadding)]);
  const totalLength = 12 + 8 + jsonBytes.length + 8 + binaryBytes.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binaryBytes.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binaryBytes]);
}

test("canonical GLB validation binds JSON structure to actual binary ranges", () => {
  assert.deepEqual(parseCanonicalGlbBytes(glb(canonicalDocument()), "fixture"), {
    meshCount: 1,
    nodeCount: 1,
    rootNodeCount: 1,
    vertexCount: 3,
    triangleCount: 1,
  });

  const outsideBuffer = canonicalDocument();
  outsideBuffer.bufferViews[0].byteLength = 64;
  assert.throws(
    () => parseCanonicalGlbBytes(glb(outsideBuffer), "fixture"),
    /exceeds the declared binary buffer/,
  );
});

test("canonical GLB validation reads index payloads instead of trusting accessor counts", () => {
  assert.throws(
    () => parseCanonicalGlbBytes(glb(canonicalDocument(), binaryPayload({ outOfRangeIndex: true })), "fixture"),
    /out-of-range vertex index/,
  );
});

test("canonical GLB validation rejects non-finite attribute payloads", () => {
  const binary = binaryPayload();
  binary.writeFloatLE(Number.NaN, 0);
  assert.throws(
    () => parseCanonicalGlbBytes(glb(canonicalDocument(), binary), "fixture"),
    /non-finite f32 component/,
  );
});
