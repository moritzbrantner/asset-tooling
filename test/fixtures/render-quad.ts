// Independently authored GLB: one 2x1 quad and a distant duplicate. No production writer oracle.
export function quadGlb(change: Record<string, unknown> = {}, images: Buffer[] = []) {
  const binary = Buffer.alloc(108);
  [-1, -.5, 0, 1, -.5, 0, 1, .5, 0, -1, .5, 0, ...Array.from({ length: 4 }, () => [0, 0, 1]).flat()]
    .forEach((value, i) => binary.writeFloatLE(value, i * 4));
  [0, 1, 2, 0, 2, 3].forEach((value, i) => binary.writeUInt16LE(value, 96 + i * 2));
  const imageViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const chunks: Buffer[] = [binary];
  let offset = binary.length;
  for (const bytes of images) {
    imageViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4);
    chunks.push(bytes, padding); offset += bytes.length + padding.length;
  }
  const payload = Buffer.concat(chunks);
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: "plane", mesh: 0, translation: [2, 3, 4] }, { name: "other", mesh: 0, translation: [10, 3, 4] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.25, .5, .75, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    buffers: [{ byteLength: payload.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 12 }, ...imageViews],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-1, -.5, 0], max: [1, .5, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" }, { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" }],
    ...(images.length ? { images: images.map((_, i) => ({ bufferView: 3 + i, mimeType: "image/png" })),
      textures: images.map((_, source) => ({ source })) } : {}), ...change };
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + payload.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(payload.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, payload]);
}
