// Fewer draw calls for skinned characters (#517): a character assembled from many parts (the Quaternius outfits ship
// a mesh per boot, belt and bracer) draws once per part even when the parts share a material. This joins, per
// material, the primitives of the parts nothing addresses by name into one primitive on one node, keeping their
// skinning, vertex colours and morph targets, so the character looks and deforms exactly as before.
import { Document, Primitive, type Accessor, type Material, type Node, type Skin } from "@gltf-transform/core";
import { prune } from "@gltf-transform/functions";

type Json = Record<string, any>;

/** Every string anywhere in `value`: the node names an appearance descriptor can address. */
export function descriptorStrings(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const item of value) descriptorStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) descriptorStrings(item, out);
  return out;
}

const identity = (node: Node) =>
  node.getTranslation().every((v) => v === 0) && node.getScale().every((v) => v === 1) &&
  node.getRotation().every((v, i) => v === (i === 3 ? 1 : 0));

/** A skin's joints and inverse bind matrices, as a key: parts merge only onto the same binding. */
function skinKey(skin: Skin) {
  const ibm = skin.getInverseBindMatrices()?.getArray();
  return `${skin.listJoints().map((joint) => joint.getName()).join(",")}|${ibm ? Array.from(ibm, (v) => v.toFixed(6)).join(",") : ""}`;
}

const REQUIRED_SEMANTICS = new Set(["POSITION", "NORMAL", "TANGENT", "JOINTS_0", "WEIGHTS_0"]);
/** The UV sets a material samples (texture infos' `texCoord`). */
function texCoords(material: Material) {
  const infos = [material.getBaseColorTextureInfo(), material.getNormalTextureInfo(), material.getMetallicRoughnessTextureInfo(),
    material.getOcclusionTextureInfo(), material.getEmissiveTextureInfo()];
  return new Set(infos.flatMap((info) => (info ? [`TEXCOORD_${info.getTexCoord()}`] : [])));
}

/**
 * Join, per material, the primitives of the skinned mesh nodes whose names are not in `keep` (and that have no
 * children, an identity transform and default morph weights). Parts merge only when they share the skin binding, the
 * morph target names, the required vertex attributes and the UV sets their material samples. A vertex colour set a
 * part lacks is the glTF default, white; a UV set the material never samples is filled with zeros. Returns the merged
 * groups by node name; a document with nothing to merge is left unchanged.
 */
export async function mergeSkinnedParts(document: Document, { keep }: { keep: ReadonlySet<string> }) {
  const root = document.getRoot();
  const buffer = root.listBuffers()[0]!;
  type Part = { node: Node; primitive: Primitive; key: string };
  const parts: Part[] = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(), skin = node.getSkin();
    if (!mesh || !skin || keep.has(node.getName()) || node.listChildren().length || !identity(node)) continue;
    if (mesh.getWeights().some((weight) => weight !== 0)) continue;
    const targetNames = JSON.stringify((mesh.getExtras() as Json).targetNames ?? []);
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES || !primitive.getIndices() || !primitive.getMaterial()) continue;
      const sampled = texCoords(primitive.getMaterial()!);
      if (primitive.listSemantics().some((semantic) => !REQUIRED_SEMANTICS.has(semantic) && !/^(COLOR|TEXCOORD)_\d+$/.test(semantic))) continue;
      const semantics = primitive.listSemantics().filter((semantic) => REQUIRED_SEMANTICS.has(semantic) || sampled.has(semantic));
      const targets = primitive.listTargets().map((target) => target.listSemantics().sort().join("+")).join("~");
      parts.push({ node, primitive, key: [root.listMaterials().indexOf(primitive.getMaterial()!), skinKey(skin), targetNames, semantics.sort().join("+"), targets].join("|") });
    }
  }
  const groups = new Map<string, Part[]>();
  for (const part of parts) groups.set(part.key, [...(groups.get(part.key) ?? []), part]);
  const merged: string[][] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const vertexCounts = group.map(({ primitive }) => primitive.getAttribute("POSITION")!.getCount());
    const total = vertexCounts.reduce((sum, count) => sum + count, 0);
    const out = new Primitive(document.getGraph()).setMaterial(first.primitive.getMaterial()).setMode(Primitive.Mode.TRIANGLES);
    // The merged primitive keeps the attributes the material can use: the required ones, the first vertex colour set
    // (the only one renderers read) and the UV sets the material samples. Every attribute keeps its stored type.
    const sampled = texCoords(first.primitive.getMaterial()!);
    const semantics = [...new Set(group.flatMap(({ primitive }) => primitive.listSemantics()))]
      .filter((semantic) => REQUIRED_SEMANTICS.has(semantic) || semantic === "COLOR_0" || sampled.has(semantic));
    const concat = (sample: Accessor, read: (primitive: Primitive) => Accessor | null, fill: number) => {
      const size = sample.getElementSize(), source = sample.getArray()!;
      const array = new (source.constructor as new (length: number) => typeof source)(total * size);
      // Normalized integers read as 0..1 and are written back at their own scale.
      const scale = sample.getNormalized() ? (2 ** (8 * source.BYTES_PER_ELEMENT) - 1) : 1;
      const element: number[] = [];
      let offset = 0;
      for (const [index, { primitive }] of group.entries()) {
        const accessor = read(primitive);
        for (let i = 0; i < vertexCounts[index]!; i++) {
          const value = accessor ? accessor.getElement(i, element) : [];
          for (let c = 0; c < size; c++) {
            const v = value[c] ?? fill;
            array[(offset + i) * size + c] = scale === 1 ? v : Math.round(v * scale);
          }
        }
        offset += vertexCounts[index]!;
      }
      return document.createAccessor().setType(sample.getType()).setArray(array).setNormalized(sample.getNormalized()).setBuffer(buffer);
    };
    for (const semantic of semantics) {
      const sample = group.map(({ primitive }) => primitive.getAttribute(semantic)).find((accessor) => accessor)!;
      out.setAttribute(semantic, concat(sample, (primitive) => primitive.getAttribute(semantic), semantic === "COLOR_0" ? 1 : 0));
    }
    for (let t = 0; t < first.primitive.listTargets().length; t++) {
      const target = document.createPrimitiveTarget();
      for (const semantic of first.primitive.listTargets()[t]!.listSemantics()) {
        const sample = first.primitive.listTargets()[t]!.getAttribute(semantic)!;
        // Targets move few vertices; sparse storage writes only those, as the sources did.
        const accessor = concat(sample, (primitive) => primitive.listTargets()[t]!.getAttribute(semantic), 0);
        target.setAttribute(semantic, accessor.setSparse(movedElements(accessor) * 2 < accessor.getCount()));
      }
      out.addTarget(target);
    }
    const indexCount = group.reduce((sum, { primitive }) => sum + primitive.getIndices()!.getCount(), 0);
    const indices = total < 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
    let at = 0, base = 0;
    for (const [index, { primitive }] of group.entries()) {
      const source = primitive.getIndices()!;
      for (let i = 0; i < source.getCount(); i++) indices[at++] = source.getScalar(i) + base;
      base += vertexCounts[index]!;
    }
    out.setIndices(document.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer));
    const firstMesh = first.node.getMesh()!;
    const name = `merged.${first.primitive.getMaterial()!.getName()}`;
    const mesh = document.createMesh(name).addPrimitive(out).setWeights(firstMesh.getWeights().slice()).setExtras(structuredClone(firstMesh.getExtras()));
    const node = document.createNode(name).setMesh(mesh).setSkin(first.node.getSkin());
    const parent = first.node.getParentNode();
    if (parent) parent.addChild(node);
    else for (const scene of root.listScenes()) if (scene.listChildren().includes(first.node)) scene.addChild(node);
    for (const { primitive } of group) primitive.dispose();
    merged.push([...new Set(group.map(({ node: part }) => part.getName()))]);
  }
  if (!merged.length) return { merged };
  // A part whose every primitive merged is gone; its empty mesh and now-unused accessors and skins go with it.
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (mesh && mesh.listPrimitives().length === 0) { mesh.dispose(); node.dispose(); }
  }
  await document.transform(prune({ propertyTypes: ["Accessor", "Mesh", "Skin", "Primitive", "PrimitiveTarget"], keepLeaves: true, keepAttributes: true, keepIndices: true }));
  return { merged };
}

/**
 * The node names a character variant's appearance can address: the descriptor's shared sections (parts, eyebrows,
 * face, hair, headwear, …) and the record of the outfit that variant wears, but not the other outfits' records, whose
 * garments and hidden base nodes belong to other variants.
 */
export function variantKeep(descriptor: Json, variant: string): Set<string> {
  const outfits = ((descriptor.outfits ?? []) as Json[]).filter((outfit) =>
    outfit.variant === variant || ((outfit.skins ?? []) as Json[]).some((skin) => skin.variant === variant));
  return descriptorStrings({ ...descriptor, outfits });
}

/** How many of an accessor's elements are not all zero. */
function movedElements(accessor: Accessor) {
  const array = accessor.getArray()!, size = accessor.getElementSize();
  let moved = 0;
  for (let i = 0; i < accessor.getCount(); i++) {
    for (let c = 0; c < size; c++) if (array[i * size + c] !== 0) { moved += 1; break; }
  }
  return moved;
}
