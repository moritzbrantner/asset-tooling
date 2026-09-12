function finiteNumber(token, location) {
  if (typeof token !== "string" || token.length === 0) throw new Error(`${location} must be a number`);
  const value = Number(token);
  if (!Number.isFinite(value)) throw new Error(`${location} must be a finite number`);
  return Object.is(value, -0) ? 0 : value;
}

function integerIndex(token, count, location) {
  if (!/^-?[1-9][0-9]*$/.test(token)) {
    throw new Error(`${location} must be a non-zero integer OBJ index`);
  }
  const raw = Number(token);
  if (!Number.isSafeInteger(raw)) throw new Error(`${location} exceeds the safe integer range`);
  const resolved = raw > 0 ? raw - 1 : count + raw;
  if (resolved < 0 || resolved >= count) {
    throw new Error(`${location} references an undeclared OBJ element`);
  }
  return resolved;
}

function faceReference(token, counts, location) {
  const fields = token.split("/");
  if (fields.length < 1 || fields.length > 3 || fields[0].length === 0) {
    throw new Error(`${location} must be an OBJ vertex[/texcoord[/normal]] reference`);
  }
  const result = { vertex: integerIndex(fields[0], counts.vertices, `${location}.vertex`) };
  if (fields.length >= 2 && fields[1].length > 0) {
    result.texcoord = integerIndex(fields[1], counts.texcoords, `${location}.texcoord`);
  }
  if (fields.length === 3 && fields[2].length > 0) {
    result.normal = integerIndex(fields[2], counts.normals, `${location}.normal`);
  }
  return result;
}

function emptyBounds() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function extendBounds(bounds, vertex) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], vertex[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], vertex[axis]);
  }
}

function finalizedBounds(bounds, vertexCount) {
  if (vertexCount === 0) return null;
  return {
    min: bounds.min,
    max: bounds.max,
    size: bounds.max.map((maximum, axis) => maximum - bounds.min[axis]),
  };
}

function decodedText(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("OBJ mesh bytes must be a Buffer");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("OBJ mesh bytes must be valid UTF-8");
  }
}

export function inspectObjMesh(bytes) {
  const text = decodedText(bytes);
  const vertices = [];
  let texcoordCount = 0;
  let normalCount = 0;
  let faceCount = 0;
  let triangleCount = 0;
  let nonTriangleFaceCount = 0;
  let repeatedIndexFaceCount = 0;
  let materialLibraryCount = 0;
  let materialUseCount = 0;
  let objectCount = 0;
  let groupCount = 0;
  let unsupportedRecordCount = 0;
  let facesUsingNormals = 0;
  let facesUsingTexcoords = 0;
  const referencedVertices = new Set();
  const bounds = emptyBounds();

  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const uncommented = lines[lineIndex].split("#", 1)[0].trim();
    if (uncommented.length === 0) continue;
    const fields = uncommented.split(/\s+/);
    const record = fields[0];
    const values = fields.slice(1);
    const location = `OBJ line ${lineIndex + 1}`;

    if (record === "v") {
      if (values.length !== 3 && values.length !== 4) {
        throw new Error(`${location} vertex must contain x y z and optional w`);
      }
      const vertex = values.slice(0, 3).map((value, axis) => finiteNumber(value, `${location}.v[${axis}]`));
      if (values.length === 4) finiteNumber(values[3], `${location}.v[3]`);
      vertices.push(vertex);
      extendBounds(bounds, vertex);
      continue;
    }

    if (record === "vt") {
      if (values.length < 1 || values.length > 3) throw new Error(`${location} texture coordinate must contain 1..3 values`);
      values.forEach((value, index) => finiteNumber(value, `${location}.vt[${index}]`));
      texcoordCount += 1;
      continue;
    }

    if (record === "vn") {
      if (values.length !== 3) throw new Error(`${location} normal must contain exactly 3 values`);
      values.forEach((value, index) => finiteNumber(value, `${location}.vn[${index}]`));
      normalCount += 1;
      continue;
    }

    if (record === "f") {
      if (values.length < 3) throw new Error(`${location} face must contain at least 3 vertices`);
      const counts = { vertices: vertices.length, texcoords: texcoordCount, normals: normalCount };
      const references = values.map((value, index) => faceReference(value, counts, `${location}.f[${index}]`));
      const vertexIndices = references.map((reference) => reference.vertex);
      vertexIndices.forEach((index) => referencedVertices.add(index));
      if (new Set(vertexIndices).size !== vertexIndices.length) repeatedIndexFaceCount += 1;
      if (references.every((reference) => reference.normal !== undefined)) facesUsingNormals += 1;
      if (references.every((reference) => reference.texcoord !== undefined)) facesUsingTexcoords += 1;
      faceCount += 1;
      triangleCount += values.length - 2;
      if (values.length !== 3) nonTriangleFaceCount += 1;
      continue;
    }

    if (record === "mtllib") {
      if (values.length === 0) throw new Error(`${location} mtllib must name at least one library`);
      materialLibraryCount += values.length;
      continue;
    }
    if (record === "usemtl") {
      if (values.length !== 1) throw new Error(`${location} usemtl must name exactly one material`);
      materialUseCount += 1;
      continue;
    }
    if (record === "o") {
      if (values.length === 0) throw new Error(`${location} object record must have a name`);
      objectCount += 1;
      continue;
    }
    if (record === "g") {
      if (values.length === 0) throw new Error(`${location} group record must have a name`);
      groupCount += 1;
      continue;
    }

    unsupportedRecordCount += 1;
  }

  return {
    vertexCount: vertices.length,
    texcoordCount,
    normalCount,
    faceCount,
    triangleCount,
    nonTriangleFaceCount,
    repeatedIndexFaceCount,
    referencedVertexCount: referencedVertices.size,
    unreferencedVertexCount: vertices.length - referencedVertices.size,
    facesUsingNormals,
    facesUsingTexcoords,
    materialLibraryCount,
    materialUseCount,
    objectCount,
    groupCount,
    unsupportedRecordCount,
    bounds: finalizedBounds(bounds, vertices.length),
  };
}

export function validateObjMeshInspection(inspection, policy) {
  if (typeof inspection !== "object" || inspection === null || Array.isArray(inspection)) {
    throw new Error("mesh inspection must be a plain object");
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error("mesh validation policy must be a plain object");
  }
  const violations = [];
  if (inspection.vertexCount > policy.maxVertices) {
    violations.push({ code: "vertex-budget-exceeded", actual: inspection.vertexCount, limit: policy.maxVertices });
  }
  if (inspection.triangleCount > policy.maxTriangles) {
    violations.push({ code: "triangle-budget-exceeded", actual: inspection.triangleCount, limit: policy.maxTriangles });
  }
  if (policy.requireTriangles && inspection.nonTriangleFaceCount > 0) {
    violations.push({ code: "non-triangle-faces-present", count: inspection.nonTriangleFaceCount });
  }
  if (policy.requireNormals && inspection.faceCount > inspection.facesUsingNormals) {
    violations.push({ code: "normals-missing", faceCount: inspection.faceCount - inspection.facesUsingNormals });
  }
  if (!policy.allowUnusedVertices && inspection.unreferencedVertexCount > 0) {
    violations.push({ code: "unused-vertices-present", count: inspection.unreferencedVertexCount });
  }
  if (inspection.repeatedIndexFaceCount > 0) {
    violations.push({ code: "repeated-index-faces-present", count: inspection.repeatedIndexFaceCount });
  }
  if (policy.rejectUnsupportedRecords && inspection.unsupportedRecordCount > 0) {
    violations.push({ code: "unsupported-records-present", count: inspection.unsupportedRecordCount });
  }
  return { valid: violations.length === 0, violations };
}
