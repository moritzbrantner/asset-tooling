export type CanonicalGlbSummary = {
  meshCount: number;
  nodeCount: number;
  rootNodeCount: number;
  vertexCount: number;
  triangleCount: number;
};
type BufferView = { byteOffset: number; byteLength: number; target: number };
type Accessor = { bufferView: number; byteOffset: number; byteLength: number; componentType: number; type: string; count: number };

const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const ARRAY_BUFFER_TARGET = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET = 34963;
const COMPONENT_F32 = 5126;
const COMPONENT_U32 = 5125;
const TRIANGLES_MODE = 4;
const COMPONENT_SIZE = new Map([
  [COMPONENT_F32, 4],
  [COMPONENT_U32, 4],
]);
const TYPE_WIDTH = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
]);
const ATTRIBUTE_SHAPE = new Map<string, readonly [number, string]>([
  ["POSITION", [COMPONENT_F32, "VEC3"]],
  ["NORMAL", [COMPONENT_F32, "VEC3"]],
  ["TANGENT", [COMPONENT_F32, "VEC4"]],
  ["TEXCOORD_0", [COMPONENT_F32, "VEC2"]],
  ["COLOR_0", [COMPONENT_F32, "VEC3"]],
]);
const UNIT_QUATERNION_TOLERANCE = 1.0e-4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${location} must be an object`);
  return value;
}

function integer(value: unknown, location: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${location} must be an integer >= ${minimum}`);
  }
  return value;
}

function finiteVector(value: unknown, width: number, location: string): number[] {
  if (!Array.isArray(value) || value.length !== width) {
    throw new Error(`${location} must contain exactly ${width} finite numbers`);
  }
  for (let index = 0; index < width; index += 1) {
    if (typeof value[index] !== "number" || !Number.isFinite(value[index])) {
      throw new Error(`${location}[${index}] must be finite`);
    }
  }
  return value;
}

function canonicalQuaternion(rotation: number[]): boolean {
  // finiteVector has validated exactly four finite components at this call site.
  const [x, y, z, w] = rotation as [number, number, number, number];
  if (w > 0) return true;
  if (w < 0) return false;
  if (x > 0) return true;
  if (x < 0) return false;
  if (y > 0) return true;
  if (y < 0) return false;
  return z >= 0;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateBufferViews(document: Record<string, unknown>, bufferByteLength: number, location: string): BufferView[] {
  if (!Array.isArray(document.bufferViews)) {
    throw new Error(`${location} GLB JSON must contain bufferViews`);
  }
  return document.bufferViews.map((entry, index) => {
    const view = object(entry, `${location}.bufferViews[${index}]`);
    if (view.buffer !== 0) {
      throw new Error(`${location}.bufferViews[${index}].buffer must be 0`);
    }
    const byteOffset = integer(view.byteOffset ?? 0, `${location}.bufferViews[${index}].byteOffset`);
    const byteLength = integer(view.byteLength, `${location}.bufferViews[${index}].byteLength`, 1);
    if (byteOffset + byteLength > bufferByteLength) {
      throw new Error(`${location}.bufferViews[${index}] exceeds the declared binary buffer`);
    }
    if (typeof view.target !== "number" || ![ARRAY_BUFFER_TARGET, ELEMENT_ARRAY_BUFFER_TARGET].includes(view.target)) {
      throw new Error(`${location}.bufferViews[${index}].target is not canonical`);
    }
    if (view.byteStride !== undefined) {
      throw new Error(`${location}.bufferViews[${index}] must not use byteStride`);
    }
    return { byteOffset, byteLength, target: integer(view.target, `${location} bufferView target`) };
  });
}

function validateAccessors(document: Record<string, unknown>, views: BufferView[], location: string): Accessor[] {
  if (!Array.isArray(document.accessors)) {
    throw new Error(`${location} GLB JSON must contain accessors`);
  }
  return document.accessors.map((entry, index) => {
    const accessor = object(entry, `${location}.accessors[${index}]`);
    const bufferView = integer(accessor.bufferView, `${location}.accessors[${index}].bufferView`);
    const view = views[bufferView];
    if (!view) {
      throw new Error(`${location}.accessors[${index}] references a missing bufferView`);
    }
    const byteOffset = integer(accessor.byteOffset ?? 0, `${location}.accessors[${index}].byteOffset`);
    const componentType = integer(accessor.componentType, `${location}.accessors[${index}].componentType`);
    const type = accessor.type;
    const componentSize = COMPONENT_SIZE.get(componentType);
    const width = typeof type === "string" ? TYPE_WIDTH.get(type) : undefined;
    if (!componentSize || !width || typeof type !== "string") {
      throw new Error(`${location}.accessors[${index}] uses a non-canonical component/type`);
    }
    const count = integer(accessor.count, `${location}.accessors[${index}].count`, 1);
    const byteLength = count * componentSize * width;
    if (!Number.isSafeInteger(byteLength) || byteOffset + byteLength > view.byteLength) {
      throw new Error(`${location}.accessors[${index}] exceeds its bufferView`);
    }
    return {
      bufferView,
      byteOffset,
      byteLength,
      componentType,
      type,
      count,
    };
  });
}

function accessorStart(binaryStart: number, views: BufferView[], accessor: Accessor): number {
  return binaryStart + views[accessor.bufferView]!.byteOffset + accessor.byteOffset;
}

function validateFiniteF32Accessor(bytes: Buffer, binaryStart: number, views: BufferView[], accessor: Accessor, location: string): void {
  if (accessor.componentType !== COMPONENT_F32) return;
  const start = accessorStart(binaryStart, views, accessor);
  const componentCount = accessor.count * TYPE_WIDTH.get(accessor.type)!;
  for (let index = 0; index < componentCount; index += 1) {
    if (!Number.isFinite(bytes.readFloatLE(start + index * 4))) {
      throw new Error(`${location} contains a non-finite f32 component`);
    }
  }
}

function validateMeshGeometry(bytes: Buffer, binaryStart: number, document: Record<string, unknown>, views: BufferView[], accessors: Accessor[], location: string) {
  if (!Array.isArray(document.meshes)) {
    throw new Error(`${location} GLB JSON must contain meshes`);
  }
  let vertexCount = 0;
  let triangleCount = 0;
  let previousName = null;
  for (const [meshIndex, meshValue] of document.meshes.entries()) {
    const mesh = object(meshValue, `${location}.meshes[${meshIndex}]`);
    if (typeof mesh.name !== "string" || mesh.name.length === 0) {
      throw new Error(`${location}.meshes[${meshIndex}].name must be non-empty`);
    }
    if (previousName !== null && compareCodeUnits(previousName, mesh.name) > 0) {
      throw new Error(`${location}.meshes must use canonical name order`);
    }
    previousName = mesh.name;
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length !== 1) {
      throw new Error(`${location}.meshes[${meshIndex}] must contain exactly one primitive`);
    }
    const primitive = object(mesh.primitives[0], `${location}.meshes[${meshIndex}].primitives[0]`);
    if (primitive.mode !== TRIANGLES_MODE) {
      throw new Error(`${location}.meshes[${meshIndex}] primitive mode must be TRIANGLES`);
    }
    const attributes = object(
      primitive.attributes,
      `${location}.meshes[${meshIndex}].primitives[0].attributes`,
    );
    if (!Object.hasOwn(attributes, "POSITION")) {
      throw new Error(`${location}.meshes[${meshIndex}] must contain POSITION`);
    }
    for (const semantic of Object.keys(attributes)) {
      if (!ATTRIBUTE_SHAPE.has(semantic)) {
        throw new Error(`${location}.meshes[${meshIndex}] contains unsupported attribute '${semantic}'`);
      }
      const accessorIndex = integer(
        attributes[semantic],
        `${location}.meshes[${meshIndex}].attributes.${semantic}`,
      );
      const accessor = accessors[accessorIndex];
      if (!accessor) {
        throw new Error(`${location}.meshes[${meshIndex}] attribute '${semantic}' has no accessor`);
      }
      const [componentType, type] = ATTRIBUTE_SHAPE.get(semantic)!;
      if (accessor.componentType !== componentType || accessor.type !== type) {
        throw new Error(`${location}.meshes[${meshIndex}] attribute '${semantic}' has the wrong accessor shape`);
      }
      validateFiniteF32Accessor(
        bytes,
        binaryStart,
        views,
        accessor,
        `${location}.meshes[${meshIndex}] attribute '${semantic}'`,
      );
    }
    const positionAccessor = accessors[integer(attributes.POSITION, `${location} POSITION accessor`)]!;
    for (const [semantic, accessorIndex] of Object.entries(attributes)) {
      if (accessors[integer(accessorIndex, `${location} attribute accessor`)]!.count !== positionAccessor.count) {
        throw new Error(`${location}.meshes[${meshIndex}] attribute '${semantic}' count differs from POSITION`);
      }
    }
    const indexAccessorIndex = integer(
      primitive.indices,
      `${location}.meshes[${meshIndex}].primitives[0].indices`,
    );
    const indexAccessor = accessors[indexAccessorIndex];
    if (!indexAccessor) {
      throw new Error(`${location}.meshes[${meshIndex}] index accessor is missing`);
    }
    if (indexAccessor.componentType !== COMPONENT_U32 || indexAccessor.type !== "SCALAR") {
      throw new Error(`${location}.meshes[${meshIndex}] indices must use u32 SCALAR accessors`);
    }
    if (indexAccessor.count % 3 !== 0) {
      throw new Error(`${location}.meshes[${meshIndex}] index count must be divisible by three`);
    }
    const indexStart = accessorStart(binaryStart, views, indexAccessor);
    for (let index = 0; index < indexAccessor.count; index += 1) {
      if (bytes.readUInt32LE(indexStart + index * 4) >= positionAccessor.count) {
        throw new Error(`${location}.meshes[${meshIndex}] contains an out-of-range vertex index`);
      }
    }
    vertexCount += positionAccessor.count;
    triangleCount += indexAccessor.count / 3;
  }
  return { meshCount: document.meshes.length, vertexCount, triangleCount };
}

function validateNodes(document: Record<string, unknown>, location: string, meshCount: number) {
  if (!Array.isArray(document.nodes) || document.nodes.length === 0) {
    throw new Error(`${location} GLB JSON must contain at least one node`);
  }
  const parentCounts: number[] = Array(document.nodes.length).fill(0);
  const names: string[] = [];
  for (const [nodeIndex, nodeValue] of document.nodes.entries()) {
    const node = object(nodeValue, `${location}.nodes[${nodeIndex}]`);
    if (typeof node.name !== "string" || node.name.length === 0) {
      throw new Error(`${location}.nodes[${nodeIndex}].name must be non-empty`);
    }
    names.push(node.name);
    finiteVector(node.translation, 3, `${location}.nodes[${nodeIndex}].translation`);
    const rotation = finiteVector(node.rotation, 4, `${location}.nodes[${nodeIndex}].rotation`);
    if (Math.abs(Math.hypot(...rotation) - 1) > UNIT_QUATERNION_TOLERANCE) {
      throw new Error(`${location}.nodes[${nodeIndex}].rotation must be normalized`);
    }
    if (!canonicalQuaternion(rotation)) {
      throw new Error(`${location}.nodes[${nodeIndex}].rotation sign is not canonical`);
    }
    finiteVector(node.scale, 3, `${location}.nodes[${nodeIndex}].scale`);
    if (node.mesh !== undefined) {
      const mesh = integer(node.mesh, `${location}.nodes[${nodeIndex}].mesh`);
      if (mesh >= meshCount) {
        throw new Error(`${location}.nodes[${nodeIndex}] references a missing mesh`);
      }
    }
    const children = node.children ?? [];
    if (!Array.isArray(children)) {
      throw new Error(`${location}.nodes[${nodeIndex}].children must be an array`);
    }
    let previousChildName = null;
    for (const [childPosition, childValue] of children.entries()) {
      const child = integer(
        childValue,
        `${location}.nodes[${nodeIndex}].children[${childPosition}]`,
      );
      if (!document.nodes[child] || child <= nodeIndex) {
        throw new Error(`${location}.nodes[${nodeIndex}] children must be later canonical nodes`);
      }
      parentCounts[child] = (parentCounts[child] ?? 0) + 1;
      if (parentCounts[child]! > 1) {
        throw new Error(`${location}.nodes[${child}] has more than one parent`);
      }
      const childName = object(document.nodes[child], `${location}.nodes[${child}]`).name;
      if (typeof childName !== "string") throw new Error(`${location} child name must be a string`);
      if (previousChildName !== null && compareCodeUnits(previousChildName, childName) > 0) {
        throw new Error(`${location}.nodes[${nodeIndex}] children must use stable name order`);
      }
      previousChildName = childName;
    }
  }
  return { parentCounts, names };
}

function validateSelectedScene(document: Record<string, unknown>, parentCounts: number[], names: string[], location: string): number {
  if (document.scene !== 0 || !Array.isArray(document.scenes) || document.scenes.length !== 1) {
    throw new Error(`${location} must contain exactly one selected canonical scene`);
  }
  const selected = object(document.scenes[0], `${location}.scenes[0]`);
  if (!Array.isArray(selected.nodes)) {
    throw new Error(`${location}.scenes[0].nodes must be an array`);
  }
  const roots = selected.nodes.map((value, index) =>
    integer(value, `${location}.scenes[0].nodes[${index}]`),
  );
  const expectedRoots = parentCounts
    .map((count, index) => (count === 0 ? index : null))
    .filter((index) => index !== null);
  if (
    roots.length !== expectedRoots.length ||
    roots.some((value, index) => value !== expectedRoots[index])
  ) {
    throw new Error(`${location}.scenes[0].nodes does not match canonical hierarchy roots`);
  }
  for (let index = 1; index < roots.length; index += 1) {
    if (compareCodeUnits(names[roots[index - 1]!]!, names[roots[index]!]!) > 0) {
      throw new Error(`${location} root nodes must use stable name order`);
    }
  }
  return roots.length;
}

export function parseCanonicalGlbBytes(bytes: Buffer, location: string): CanonicalGlbSummary {
  if (!Buffer.isBuffer(bytes) || bytes.length < 28) {
    throw new Error(`${location} must be a canonical GLB 2.0 byte sequence`);
  }
  if (bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error(`${location} has invalid GLB magic`);
  }
  if (bytes.readUInt32LE(4) !== 2) throw new Error(`${location} GLB version must be 2`);
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`${location} GLB declared byte length does not match output bytes`);
  }

  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== GLB_JSON_CHUNK) {
    throw new Error(`${location} first GLB chunk must be JSON`);
  }
  const jsonEnd = 20 + jsonLength;
  if (jsonEnd + 8 > bytes.length) {
    throw new Error(`${location} is missing the canonical BIN chunk`);
  }
  let rawDocument: unknown;
  try {
    rawDocument = JSON.parse(bytes.toString("utf8", 20, jsonEnd).trimEnd());
  } catch (error) {
    throw new Error(`${location} contains invalid GLB JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = object(rawDocument, `${location} GLB JSON`);
  if (object(document.asset, `${location}.asset`).version !== "2.0") {
    throw new Error(`${location} GLB JSON must declare glTF 2.0`);
  }

  const binLength = bytes.readUInt32LE(jsonEnd);
  if (bytes.readUInt32LE(jsonEnd + 4) !== GLB_BIN_CHUNK) {
    throw new Error(`${location} second GLB chunk must be BIN`);
  }
  const binaryStart = jsonEnd + 8;
  if (binaryStart + binLength !== bytes.length) {
    throw new Error(`${location} BIN chunk length does not match output bytes`);
  }
  if (!Array.isArray(document.buffers) || document.buffers.length !== 1) {
    throw new Error(`${location} must contain exactly one canonical binary buffer`);
  }
  const bufferByteLength = integer(
    object(document.buffers[0], `${location}.buffers[0]`).byteLength,
    `${location}.buffers[0].byteLength`,
  );
  if (bufferByteLength > binLength || binLength - bufferByteLength > 3) {
    throw new Error(`${location} binary buffer length disagrees with the BIN chunk`);
  }

  const views = validateBufferViews(document, bufferByteLength, location);
  const accessors = validateAccessors(document, views, location);
  const geometry = validateMeshGeometry(bytes, binaryStart, document, views, accessors, location);
  const { parentCounts, names } = validateNodes(document, location, geometry.meshCount);
  const rootNodeCount = validateSelectedScene(document, parentCounts, names, location);
  return {
    meshCount: geometry.meshCount,
    nodeCount: names.length,
    rootNodeCount,
    vertexCount: geometry.vertexCount,
    triangleCount: geometry.triangleCount,
  };
}
