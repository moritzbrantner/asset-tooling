// Independently authored core GLB used by both material transport proofs.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
export function materialGlb(change: Record<string, unknown> = {}) {
  const geometry = Buffer.alloc(152);
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]
    .forEach((value, i) => geometry.writeFloatLE(value, i * 4));
  [0, 1, 2].forEach((value, i) => geometry.writeUInt16LE(value, 96 + i * 2));
  [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1].forEach((value, i) => geometry.writeFloatLE(value, 104 + i * 4));
  const binary = Buffer.concat([geometry, png, Buffer.alloc((4 - png.length % 4) % 4)]);
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "root", translation: [2, 3, 4], children: [1] }, { name: "leaf", mesh: 0, translation: [0, 1, 0] }],
    meshes: [{ primitives: [0, 1].map(material => ({ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 4 }, indices: 3, material })) }],
    materials: [{ name: "paint", pbrMetallicRoughness: { baseColorFactor: [.5, .5, .5, 1], baseColorTexture: { index: 0 },
      metallicFactor: .15, roughnessFactor: .27, metallicRoughnessTexture: { index: 0 } },
      normalTexture: { index: 0, scale: .6 }, occlusionTexture: { index: 0, strength: .3 }, emissiveTexture: { index: 0 },
      emissiveFactor: [.1, .2, .3], alphaMode: "MASK", alphaCutoff: .42, doubleSided: true },
      { name: "keep", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: .3, roughnessFactor: .7 } }],
    images: [{ bufferView: 5, mimeType: "image/png" }], textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
    buffers: [{ byteLength: binary.length }], bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 }, { buffer: 0, byteOffset: 96, byteLength: 6 },
      { buffer: 0, byteOffset: 104, byteLength: 48 }, { buffer: 0, byteOffset: 152, byteLength: png.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" }, { bufferView: 4, componentType: 5126, count: 3, type: "VEC4" }], ...change };
  const json = Buffer.from(JSON.stringify(document)), padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, binary]);
}
