// Independently authored animated GLBs for posed render tests. A unit quad spans x -.5..5, y 0..1.
// "skinned": every vertex is bound to joint "tip" (rest y .5); clip "lift" raises the quad by one unit over one second
// and clip "drop" holds it five units down. "rigid": node "plane" carries the quad; clip "slide" moves it +x by one.
function glb(document: Record<string, unknown>, payload: Buffer) {
  const json = Buffer.from(JSON.stringify({ ...document, buffers: [{ byteLength: payload.length }] }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + payload.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(payload.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, payload]);
}

class Payload {
  chunks: Buffer[] = []; views: Record<string, number>[] = []; accessors: Record<string, unknown>[] = []; offset = 0;
  add(bytes: Buffer, accessor: Record<string, unknown>) {
    this.views.push({ buffer: 0, byteOffset: this.offset, byteLength: bytes.length });
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4);
    this.chunks.push(bytes, padding); this.offset += bytes.length + padding.length;
    this.accessors.push({ bufferView: this.views.length - 1, ...accessor });
    return this.accessors.length - 1;
  }
  floats(values: number[], type: string, minMax = false) {
    const bytes = Buffer.alloc(values.length * 4); values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    const count = values.length / width;
    const bounds = minMax ? { min: Array.from({ length: width }, (_, c) => Math.min(...values.filter((_, i) => i % width === c))),
      max: Array.from({ length: width }, (_, c) => Math.max(...values.filter((_, i) => i % width === c))) } : {};
    return this.add(bytes, { componentType: 5126, count, type, ...bounds });
  }
  bytes() { return Buffer.concat(this.chunks); }
}

function quad(payload: Payload) {
  const position = payload.floats([-.5, 0, 0, .5, 0, 0, .5, 1, 0, -.5, 1, 0], "VEC3", true);
  const normal = payload.floats(Array.from({ length: 4 }, () => [0, 0, 1]).flat(), "VEC3");
  const indexBytes = Buffer.alloc(12); [0, 1, 2, 0, 2, 3].forEach((value, i) => indexBytes.writeUInt16LE(value, i * 2));
  const indices = payload.add(indexBytes, { componentType: 5123, count: 6, type: "SCALAR" });
  return { position, normal, indices };
}
const material = { pbrMetallicRoughness: { baseColorFactor: [.25, .5, .75, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true };
const linear = (input: number, output: number) => ({ input, output, interpolation: "LINEAR" });

export function skinnedGlb() {
  const payload = new Payload(), { position, normal, indices } = quad(payload);
  const joints = payload.add(Buffer.from(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat()), { componentType: 5121, count: 4, type: "VEC4" });
  const weights = payload.floats(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(), "VEC4");
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const inverseBind = payload.floats([...identity, ...identity.slice(0, 12), 0, -.5, 0, 1], "MAT4");
  const times = payload.floats([0, 1], "SCALAR", true);
  const lift = payload.floats([0, .5, 0, 0, 1.5, 0], "VEC3"), drop = payload.floats([0, -4.5, 0, 0, -4.5, 0], "VEC3");
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: "skinned", mesh: 0, skin: 0 }, { name: "root", children: [2] }, { name: "tip", translation: [0, .5, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal, JOINTS_0: joints, WEIGHTS_0: weights }, indices, material: 0 }] }],
    materials: [material], skins: [{ joints: [1, 2], inverseBindMatrices: inverseBind, skeleton: 1 }],
    animations: [
      { name: "lift", samplers: [linear(times, lift)], channels: [{ sampler: 0, target: { node: 2, path: "translation" } }] },
      { name: "drop", samplers: [linear(times, drop)], channels: [{ sampler: 0, target: { node: 2, path: "translation" } }] },
    ],
    bufferViews: payload.views, accessors: payload.accessors }, payload.bytes());
}

export function rigidGlb() {
  const payload = new Payload(), { position, normal, indices } = quad(payload);
  const times = payload.floats([0, 1], "SCALAR", true), slide = payload.floats([0, 0, 0, 1, 0, 0], "VEC3");
  return glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "plane", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material: 0 }] }],
    materials: [material],
    animations: [{ name: "slide", samplers: [linear(times, slide)], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] }],
    bufferViews: payload.views, accessors: payload.accessors }, payload.bytes());
}
