#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
if (mode === "probe") {
  process.stdout.write(
    JSON.stringify([
      {
        id: "three-d-scene-normalize",
        version: "0.1.0",
        algorithm: "three-d-scene-normalize-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "three-d-scene-json-v1",
        dependencies: { threeDScene: "0.1.0", threeDExport: "0.1.0" },
        cargoLock: "fixture-scene-lock-v1",
      },
      {
        id: "three-d-scene-export-glb",
        version: "0.1.0",
        algorithm: "three-d-export-glb-v1",
        protocol: "asset-tooling-process-adapter-v1",
        codec: "gltf-binary-v2",
        dependencies: { threeDScene: "0.1.0", threeDExport: "0.1.0" },
        cargoLock: "fixture-scene-lock-v1",
      },
    ]),
  );
  process.exit(0);
}

if (mode !== "generate" || process.argv.length !== 6) {
  throw new Error("usage: fixture probe | generate REQUEST OUTPUT OBSERVATIONS");
}

const [, , , requestPath, outputPath, observationsPath] = process.argv;
const request = JSON.parse(await readFile(requestPath, "utf8"));
const source = JSON.parse(await readFile(path.resolve(process.cwd(), request.inputPath), "utf8"));

function scaleFor(unit) {
  if (unit === "meter") return 1;
  if (unit === "centimeter") return 0.01;
  if (unit === "millimeter") return 0.001;
  throw new Error("unsupported fixture unit");
}

function canonicalQuaternion(value) {
  let [x, y, z, w] = value.map(Math.fround);
  const length = Math.hypot(x, y, z, w);
  x = Math.fround(x / length);
  y = Math.fround(y / length);
  z = Math.fround(z / length);
  w = Math.fround(w / length);
  const flip = w < 0 || (w === 0 && (x < 0 || (x === 0 && (y < 0 || (y === 0 && z < 0)))));
  if (flip) return [-x || 0, -y || 0, -z || 0, -w || 0];
  return [x || 0, y || 0, z || 0, w || 0];
}

function compactMesh(mesh, factor) {
  const remap = new Map();
  const vertices = [];
  const indices = [];
  const attributes = Object.fromEntries(
    ["normals", "tangents", "uvs", "colors"]
      .filter((key) => Array.isArray(mesh[key]))
      .map((key) => [key, []]),
  );
  for (const sourceIndex of mesh.indices) {
    if (!remap.has(sourceIndex)) {
      const target = vertices.length;
      remap.set(sourceIndex, target);
      vertices.push(mesh.vertices[sourceIndex].map((value) => Math.fround(value * factor) || 0));
      for (const [key, output] of Object.entries(attributes)) {
        output.push(mesh[key][sourceIndex].map((value) => Math.fround(value) || 0));
      }
    }
    indices.push(remap.get(sourceIndex));
  }
  return { id: mesh.id, vertices, indices, ...attributes };
}

function normalizeScene(document) {
  const factor = scaleFor(document.unit);
  const meshes = document.meshes.map((mesh) => compactMesh(mesh, factor)).sort((a, b) => a.id.localeCompare(b.id));
  const meshIds = new Set(meshes.map((mesh) => mesh.id));
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const children = new Map(document.nodes.map((node) => [node.id, []]));
  const roots = [];
  for (const node of document.nodes) {
    if (node.parent === null) roots.push(node.id);
    else children.get(node.parent).push(node.id);
  }
  roots.sort();
  for (const entries of children.values()) entries.sort();
  const order = [];
  function append(id) {
    order.push(id);
    for (const child of children.get(id)) append(child);
  }
  for (const root of roots) append(root);
  const nodes = order.map((id) => {
    const node = byId.get(id);
    if (node.mesh !== null && !meshIds.has(node.mesh)) throw new Error("unknown mesh");
    return {
      id,
      parent: node.parent,
      mesh: node.mesh,
      translation: node.translation.map((value) => Math.fround(value * factor) || 0),
      rotation: canonicalQuaternion(node.rotation),
      scale: node.scale.map((value) => Math.fround(value) || 0),
    };
  });
  return {
    schemaVersion: 1,
    coordinateSystem: "right-handed-y-up",
    unit: "meter",
    meshes,
    nodes,
  };
}

function counts(scene) {
  return {
    meshCount: scene.meshes.length,
    nodeCount: scene.nodes.length,
    rootNodeCount: scene.nodes.filter((node) => node.parent === null).length,
    vertexCount: scene.meshes.reduce((sum, mesh) => sum + mesh.vertices.length, 0),
    triangleCount: scene.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
  };
}

function align4(buffer) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function glbFor(scene) {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const gltfMeshes = [];
  let offset = 0;
  function addChunk(buffer, target) {
    const alignedOffset = (offset + 3) & ~3;
    if (alignedOffset > offset) chunks.push(Buffer.alloc(alignedOffset - offset));
    offset = alignedOffset;
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteLength: buffer.length, byteOffset: offset, target });
    chunks.push(buffer);
    offset += buffer.length;
    return index;
  }
  for (const mesh of scene.meshes) {
    const positions = Buffer.alloc(mesh.vertices.length * 12);
    mesh.vertices.forEach((vertex, index) => vertex.forEach((value, axis) => positions.writeFloatLE(value, index * 12 + axis * 4)));
    const positionView = addChunk(positions, 34962);
    const positionAccessor = accessors.length;
    accessors.push({ bufferView: positionView, byteOffset: 0, componentType: 5126, count: mesh.vertices.length, type: "VEC3" });
    const indices = Buffer.alloc(mesh.indices.length * 4);
    mesh.indices.forEach((value, index) => indices.writeUInt32LE(value, index * 4));
    const indexView = addChunk(indices, 34963);
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: indexView, byteOffset: 0, componentType: 5125, count: mesh.indices.length, type: "SCALAR" });
    gltfMeshes.push({ name: mesh.id, primitives: [{ attributes: { POSITION: positionAccessor }, indices: indexAccessor, mode: 4 }] });
  }
  const binary = align4(Buffer.concat(chunks));
  const nodeIndex = new Map(scene.nodes.map((node, index) => [node.id, index]));
  const childMap = new Map(scene.nodes.map((node) => [node.id, []]));
  const roots = [];
  scene.nodes.forEach((node, index) => {
    if (node.parent === null) roots.push(index);
    else childMap.get(node.parent).push(index);
  });
  const meshIndex = new Map(scene.meshes.map((mesh, index) => [mesh.id, index]));
  const nodes = scene.nodes.map((node) => ({
    name: node.id,
    translation: node.translation,
    rotation: node.rotation,
    scale: node.scale,
    ...(node.mesh === null ? {} : { mesh: meshIndex.get(node.mesh) }),
    ...(childMap.get(node.id).length === 0 ? {} : { children: childMap.get(node.id) }),
  }));
  void nodeIndex;
  const document = {
    accessors,
    asset: { generator: "fixture", version: "2.0" },
    bufferViews,
    buffers: [{ byteLength: binary.length }],
    meshes: gltfMeshes,
    nodes,
    scene: 0,
    scenes: [{ name: "scene", nodes: roots }],
  };
  let json = Buffer.from(JSON.stringify(document), "utf8");
  const jsonPadding = (4 - (json.length % 4)) % 4;
  if (jsonPadding) json = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const totalLength = 12 + 8 + json.length + 8 + binary.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, binary]);
}

const normalized = normalizeScene(source);
const sourceCounts = counts(source);
const resultCounts = counts(normalized);
if (request.operation === "scene.normalize") {
  const bytes = Buffer.from(JSON.stringify(normalized), "utf8");
  await writeFile(outputPath, bytes);
  await writeFile(
    observationsPath,
    JSON.stringify({
      sourceMeshCount: sourceCounts.meshCount,
      resultMeshCount: resultCounts.meshCount,
      nodeCount: resultCounts.nodeCount,
      rootNodeCount: resultCounts.rootNodeCount,
      sourceVertexCount: sourceCounts.vertexCount,
      resultVertexCount: resultCounts.vertexCount,
      removedUnusedVertexCount: sourceCounts.vertexCount - resultCounts.vertexCount,
      triangleCount: resultCounts.triangleCount,
      sourceUnit: source.unit,
      outputUnit: "meter",
      coordinateSystem: "right-handed-y-up",
      canonicalOrder: true,
      canonicalQuaternionSign: true,
    }),
  );
  process.exit(0);
}

if (request.operation === "scene.export.glb") {
  const bytes = glbFor(normalized);
  await writeFile(outputPath, bytes);
  await writeFile(
    observationsPath,
    JSON.stringify({
      meshCount: resultCounts.meshCount,
      nodeCount: resultCounts.nodeCount,
      rootNodeCount: resultCounts.rootNodeCount,
      vertexCount: resultCounts.vertexCount,
      triangleCount: resultCounts.triangleCount,
      coordinateSystem: "right-handed-y-up",
      unit: "meter",
      format: "glb-2.0",
      normalizedBeforeExport: true,
      byteLength: bytes.length,
    }),
  );
  process.exit(0);
}

throw new Error(`unsupported fixture operation '${request.operation}'`);
