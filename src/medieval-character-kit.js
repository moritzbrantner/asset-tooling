import { createHash } from "node:crypto";
import { generateBoxObj, generateCylinderObj, generateUvSphereObj } from "./procedural-mesh.js";

const MICRO_SCALE = 1_000_000n;
const RECIPE_VERSION = "1";
const COORDINATE_SYSTEM = "right-handed-y-up";
const UNIT = "millimeter";
const ARCHETYPES = Object.freeze(["soldier", "archer", "knight"]);

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

const COMMON = {
  legs: [
    { name: "left-leg", primitive: "box", parameters: { width: 180, height: 700, depth: 200 }, translate: [-140, 350, 0] },
    { name: "right-leg", primitive: "box", parameters: { width: 180, height: 700, depth: 200 }, translate: [140, 350, 0] },
  ],
  head: { name: "head", primitive: "uv-sphere", parameters: { radius: 180, latitudeSegments: 8, longitudeSegments: 16 }, translate: [0, 1580, 0] },
};

export const MEDIEVAL_CHARACTER_RECIPES = deepFreeze({
  soldier: {
    label: "Foot soldier",
    parts: [
      ...COMMON.legs,
      { name: "torso", primitive: "box", parameters: { width: 520, height: 700, depth: 280 }, translate: [0, 1050, 0] },
      COMMON.head,
      { name: "left-arm", primitive: "box", parameters: { width: 140, height: 620, depth: 160 }, translate: [-340, 1040, 0] },
      { name: "right-arm", primitive: "box", parameters: { width: 140, height: 620, depth: 160 }, translate: [340, 1040, 0] },
      { name: "shield", primitive: "box", parameters: { width: 360, height: 520, depth: 80 }, translate: [-490, 1050, 0] },
      { name: "spear", primitive: "cylinder", parameters: { radius: 28, height: 1900, radialSegments: 8 }, translate: [520, 950, 0] },
    ],
  },
  archer: {
    label: "Archer",
    parts: [
      ...COMMON.legs,
      { name: "torso", primitive: "box", parameters: { width: 460, height: 680, depth: 240 }, translate: [0, 1040, 0] },
      COMMON.head,
      { name: "left-arm", primitive: "box", parameters: { width: 120, height: 600, depth: 140 }, translate: [-310, 1050, 0] },
      { name: "right-arm", primitive: "box", parameters: { width: 120, height: 600, depth: 140 }, translate: [310, 1050, 0] },
      { name: "bow-stave", primitive: "box", parameters: { width: 70, height: 1250, depth: 55 }, translate: [500, 1050, 0] },
      { name: "bow-string", primitive: "box", parameters: { width: 16, height: 1120, depth: 16 }, translate: [560, 1050, 0] },
      { name: "quiver", primitive: "box", parameters: { width: 180, height: 620, depth: 180 }, translate: [-250, 1170, -250] },
    ],
  },
  knight: {
    label: "Armored knight",
    parts: [
      { name: "left-leg", primitive: "box", parameters: { width: 220, height: 720, depth: 240 }, translate: [-150, 360, 0] },
      { name: "right-leg", primitive: "box", parameters: { width: 220, height: 720, depth: 240 }, translate: [150, 360, 0] },
      { name: "armored-torso", primitive: "box", parameters: { width: 620, height: 760, depth: 360 }, translate: [0, 1090, 0] },
      { name: "helmet", primitive: "cylinder", parameters: { radius: 220, height: 360, radialSegments: 16 }, translate: [0, 1610, 0] },
      { name: "left-arm", primitive: "box", parameters: { width: 180, height: 660, depth: 200 }, translate: [-400, 1080, 0] },
      { name: "right-arm", primitive: "box", parameters: { width: 180, height: 660, depth: 200 }, translate: [400, 1080, 0] },
      { name: "left-pauldron", primitive: "uv-sphere", parameters: { radius: 210, latitudeSegments: 4, longitudeSegments: 8 }, translate: [-360, 1390, 0] },
      { name: "right-pauldron", primitive: "uv-sphere", parameters: { radius: 210, latitudeSegments: 4, longitudeSegments: 8 }, translate: [360, 1390, 0] },
      { name: "shield", primitive: "box", parameters: { width: 440, height: 650, depth: 100 }, translate: [-570, 1050, 0] },
      { name: "sword", primitive: "box", parameters: { width: 70, height: 1150, depth: 55 }, translate: [570, 900, 0] },
    ],
  },
});

function parseMicro(value) {
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(value)) throw new Error(`unsupported OBJ coordinate '${value}'`);
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const micro = BigInt(whole) * MICRO_SCALE + BigInt(fraction.padEnd(6, "0"));
  return negative ? -micro : micro;
}

function formatMicro(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MICRO_SCALE;
  const remainder = absolute % MICRO_SCALE;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole}`;
  const fraction = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function validateTranslate(translate, location) {
  if (!Array.isArray(translate) || translate.length !== 3 || translate.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${location} translate must contain exactly three integer coordinates`);
  }
  return translate;
}

function primitiveMesh(part) {
  if (part.primitive === "box") return generateBoxObj(part.parameters);
  if (part.primitive === "cylinder") return generateCylinderObj(part.parameters);
  if (part.primitive === "uv-sphere") return generateUvSphereObj(part.parameters);
  throw new Error(`unsupported medieval character primitive '${part.primitive}'`);
}

function parsePrimitive(mesh, part) {
  const translate = validateTranslate(part.translate, `part '${part.name}'`).map((value) => BigInt(value) * MICRO_SCALE);
  const vertices = [];
  const faces = [];
  for (const line of mesh.bytes.toString("utf8").split(/\r?\n/)) {
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.split(/\s+/);
      vertices.push([parseMicro(x) + translate[0], parseMicro(y) + translate[1], parseMicro(z) + translate[2]]);
    } else if (line.startsWith("f ")) {
      const [, a, b, c] = line.split(/\s+/);
      faces.push([Number.parseInt(a, 10), Number.parseInt(b, 10), Number.parseInt(c, 10)]);
    }
  }
  if (vertices.length !== mesh.vertexCount || faces.length !== mesh.triangleCount) {
    throw new Error(`part '${part.name}' OBJ topology does not match primitive metadata`);
  }
  return { vertices, faces };
}

function boundsFor(vertices) {
  const minima = [...vertices[0]];
  const maxima = [...vertices[0]];
  for (const vertex of vertices.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (vertex[axis] < minima[axis]) minima[axis] = vertex[axis];
      if (vertex[axis] > maxima[axis]) maxima[axis] = vertex[axis];
    }
  }
  return {
    min: minima.map(formatMicro),
    max: maxima.map(formatMicro),
  };
}

export function generateMedievalCharacterObj(archetype) {
  if (!ARCHETYPES.includes(archetype)) throw new Error(`unknown medieval character archetype '${archetype}'`);
  const recipe = MEDIEVAL_CHARACTER_RECIPES[archetype];
  const lines = [
    "# asset-tooling medieval character kit OBJ v1",
    `# recipe-version ${RECIPE_VERSION}`,
    `o medieval-${archetype}`,
  ];
  const allVertices = [];
  let vertexOffset = 0;
  let triangleCount = 0;

  for (const part of recipe.parts) {
    const parsed = parsePrimitive(primitiveMesh(part), part);
    lines.push(`g ${part.name}`);
    for (const vertex of parsed.vertices) {
      allVertices.push(vertex);
      lines.push(`v ${formatMicro(vertex[0])} ${formatMicro(vertex[1])} ${formatMicro(vertex[2])}`);
    }
    for (const face of parsed.faces) {
      lines.push(`f ${face[0] + vertexOffset} ${face[1] + vertexOffset} ${face[2] + vertexOffset}`);
    }
    vertexOffset += parsed.vertices.length;
    triangleCount += parsed.faces.length;
  }

  const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  return {
    bytes,
    archetype,
    label: recipe.label,
    recipeVersion: RECIPE_VERSION,
    coordinateSystem: COORDINATE_SYSTEM,
    unit: UNIT,
    consumerScaleToMeters: "0.001",
    vertexCount: vertexOffset,
    triangleCount,
    bounds: boundsFor(allVertices),
    partNames: recipe.parts.map((part) => part.name),
  };
}

export function generateMedievalCharacterKit() {
  return ARCHETYPES.map((archetype) => generateMedievalCharacterObj(archetype));
}

export function buildMedievalCharacterKitManifest() {
  const assets = generateMedievalCharacterKit().map((asset) => ({
    id: `medieval.${asset.archetype}`,
    fileName: `${asset.archetype}.obj`,
    label: asset.label,
    mediaType: "model/obj",
    sha256: createHash("sha256").update(asset.bytes).digest("hex"),
    byteLength: asset.bytes.length,
    vertexCount: asset.vertexCount,
    triangleCount: asset.triangleCount,
    bounds: asset.bounds,
    parts: asset.partNames,
  }));
  return {
    schemaVersion: 1,
    id: "medieval-character-kit",
    recipeVersion: RECIPE_VERSION,
    coordinateSystem: COORDINATE_SYSTEM,
    unit: UNIT,
    consumerScaleToMeters: "0.001",
    assets,
  };
}
