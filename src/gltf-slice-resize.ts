import type { Document } from "@gltf-transform/core";

/**
 * Resize a static asset to new outer dimensions while keeping its edges (#121): every axis is cut into a fixed margin
 * at each end and a stretchable middle, in the asset's own frame. Vertices in a margin move with that end, so bevels,
 * rims, trims and fittings keep their size; the middle is scaled to make up the difference. X and Z stay centred on
 * the asset's current centre and Y keeps its base, matching the starter kit's footprint-base-center placement.
 * Normals of stretched vertices are corrected with the inverse scale. Primitives whose material is named in
 * `dropMaterials` are removed (a construction choice such as "no metal fittings"). UVs, materials and textures are
 * otherwise untouched, so trim-sheet textures stay shared with the source asset.
 */
export type SliceResizeAxis = "x" | "y" | "z";
export interface SliceResizeOptions {
  /** New outer size per axis in metres; omitted axes keep their size. */
  size: Partial<Record<SliceResizeAxis, number>>;
  /** Fixed end margin per axis in metres (both ends; Y: base and top). */
  margin: Record<SliceResizeAxis, number>;
  dropMaterials?: readonly string[];
}

const AXES: readonly SliceResizeAxis[] = ["x", "y", "z"];

function invert3(M: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = M as [[number, number, number], [number, number, number], [number, number, number]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error("slice resize: a mesh node's world transform is singular");
  return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]];
}

export function documentBounds(document: Document): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      const p: number[] = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        const world = [0, 1, 2].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!);
        for (let a = 0; a < 3; a += 1) { min[a] = Math.min(min[a]!, world[a]!); max[a] = Math.max(max[a]!, world[a]!); }
      }
    }
  }
  if (!Number.isFinite(min[0]!)) throw new Error("slice resize: the document has no mesh vertices");
  return { min, max };
}

export function sliceResizeDocument(document: Document, options: SliceResizeOptions) {
  for (const axis of Object.keys(options.size)) if (!AXES.includes(axis as SliceResizeAxis)) throw new Error(`slice resize: unknown axis '${axis}'`);
  const drop = new Set(options.dropMaterials ?? []);
  const materials = new Set(document.getRoot().listMaterials().map((material) => material.getName()));
  for (const name of drop) if (!materials.has(name)) throw new Error(`slice resize: no material named '${name}'`);
  // Drop first, so the measured bounds are those of the remaining construction.
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (drop.has(primitive.getMaterial()?.getName() ?? "")) { mesh.removePrimitive(primitive); primitive.dispose(); }
    }
    if (mesh.listPrimitives().length === 0) throw new Error(`slice resize: mesh '${mesh.getName()}' would have no primitives left`);
  }
  const { min, max } = documentBounds(document);
  const maps = AXES.map((axis, a) => {
    const size = max[a]! - min[a]!, margin = options.margin[axis];
    const target = options.size[axis] ?? size;
    if (!(margin >= 0) || 2 * margin >= size) throw new Error(`slice resize: ${axis} margin ${margin} must be at least 0 and leave a middle in ${size.toFixed(4)} m`);
    if (!(target > 2 * margin)) throw new Error(`slice resize: ${axis} size ${target} must exceed both margins (${2 * margin} m)`);
    const newMin = axis === "y" ? min[a]! : (min[a]! + max[a]!) / 2 - target / 2;
    const scale = (target - 2 * margin) / (size - 2 * margin);
    return {
      scale,
      map: (value: number) => value < min[a]! + margin ? newMin + (value - min[a]!)
        : value > max[a]! - margin ? newMin + target - (max[a]! - value)
          : newMin + margin + (value - min[a]! - margin) * scale,
      stretched: (value: number) => value >= min[a]! + margin && value <= max[a]! - margin,
      before: size, after: target,
    };
  });
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (node.getSkin()) throw new Error("slice resize supports static meshes only");
    const m = node.getWorldMatrix();
    // Column-major affine world matrix: A (3 x 3) and translation t; local = A^-1 (world - t).
    const A = [[m[0]!, m[4]!, m[8]!], [m[1]!, m[5]!, m[9]!], [m[2]!, m[6]!, m[10]!]], t = [m[12]!, m[13]!, m[14]!];
    const inverse = invert3(A);
    const apply = (M: number[][], v: number[]) => M.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!);
    const transpose = (M: number[][]) => M[0]!.map((_, c) => M.map((row) => row[c]!));
    const normalToWorld = transpose(inverse), normalToLocal = transpose(A);
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!, normal = primitive.getAttribute("NORMAL");
      const p: number[] = [0, 0, 0], n: number[] = [0, 0, 0];
      const positions = position.clone(), normals = normal?.clone();
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        const world = apply(A, p).map((value, a) => value + t[a]!);
        const moved = world.map((value, a) => maps[a]!.map(value) - t[a]!);
        positions.setElement(i, apply(inverse, moved));
        if (normal && normals) {
          normal.getElement(i, n);
          const worldNormal = apply(normalToWorld, n).map((value, a) => maps[a]!.stretched(world[a]!) ? value / maps[a]!.scale : value);
          const local = apply(normalToLocal, worldNormal);
          const length = Math.hypot(...local) || 1;
          normals.setElement(i, local.map((value) => value / length));
        }
      }
      primitive.setAttribute("POSITION", positions);
      if (normal && normals) primitive.setAttribute("NORMAL", normals);
    }
  }
  // Remove what nothing references any more: replaced accessors, dropped materials and their textures.
  const root = document.getRoot();
  const unused = (property: { listParents(): unknown[] }) => property.listParents().every((parent) => parent === root);
  for (const accessor of root.listAccessors()) if (unused(accessor)) accessor.dispose();
  for (const material of root.listMaterials()) if (unused(material)) material.dispose();
  for (const texture of root.listTextures()) if (unused(texture)) texture.dispose();
  return { size: Object.fromEntries(AXES.map((axis, a) => [axis, { before: maps[a]!.before, after: maps[a]!.after }])), dropped: [...drop].sort() };
}
