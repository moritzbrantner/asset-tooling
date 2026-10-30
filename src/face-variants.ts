import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { NodeIO, type Document, type Primitive } from "@gltf-transform/core";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { readBlenderRecipeSource } from "./blender-recipe-source.js";
import { canonicalJson } from "./canonical.js";
import { generateAsset } from "./core.js";
import { sha256Bytes } from "./hash.js";
import type { AssetRef } from "./operations.js";
import { blenderScriptSpec } from "./blender-recipe-run.js";

/**
 * Ranger facial variants (#348): four independently selectable features, each with a base (no morph) and two
 * authored shape keys from adapters/blender/face_variants.py. Options of one feature are exclusive; features combine
 * freely. The keys never move the cranium, the ears or the neck seam, so every hair, headwear, hood, skin and outfit
 * stays compatible. Levels of detail carry no morph targets and always show the base face.
 */
export const FACE_FEATURES = Object.freeze([
  { id: "face", label: "Face shape", options: [["face.base", "Base"], ["face.broad", "Broad jaw"], ["face.narrow", "Narrow, long chin"]] },
  { id: "eyes", label: "Eyes", options: [["eyes.base", "Base"], ["eyes.large", "Large"], ["eyes.narrow", "Narrow, almond"]] },
  { id: "nose", label: "Nose", options: [["nose.base", "Base"], ["nose.broad", "Broad"], ["nose.long", "Long"]] },
  { id: "mouth", label: "Mouth", options: [["mouth.base", "Base"], ["mouth.full", "Full lips"], ["mouth.thin", "Thin lips"]] },
] as const);
/** The morph target names, in the order the recipe adds them to every face mesh. */
export const FACE_MORPH_TARGETS: readonly string[] = Object.freeze(FACE_FEATURES.flatMap((feature) => feature.options.slice(1).map(([id]) => id)));
/** Nodes that carry the face morph targets: the head and the eyes and eyebrows meshes. */
export const FACE_MORPH_NODES = Object.freeze({ male: ["SuperHero_Male", "Eyes", "Eyebrows"], female: ["Superhero_Female", "Eyes", "Eyebrows"] });

export function createFaceVariantsAssetSpec({ assetId, scriptSha256, sourceSha256, blenderVersion }: {
  assetId: string; scriptSha256: string; sourceSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId, inputs: { script: { path: "face_variants.py", sha256: scriptSha256 }, source: { path: "source.glb", sha256: sourceSha256 } },
    blenderVersion, arguments: { schemaVersion: 1 }, output: "face.glb",
  });
}

/**
 * The head part with the face morph targets: Blender authors the shape keys on a copy, and only the morph targets come
 * back onto the original part (`transferFaceMorphs`), so the shipped skin, materials and attributes are unchanged.
 */
export async function addFaceVariants(root: string, head: AssetRef, label: string) {
  const script = await readBlenderRecipeSource("face_variants.py");
  const workspace = path.join(root, "face-variants", label);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "face_variants.py"), script.bytes);
  const bytes = await resolveAssetObject(root, head);
  await writeFile(path.join(workspace, "source.glb"), bytes);
  const spec = createFaceVariantsAssetSpec({ assetId: `face-variants.${label}`, scriptSha256: script.sha256, sourceSha256: sha256Bytes(bytes), blenderVersion: script.blenderVersion });
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(spec)}\n`);
  const generated = await generateAsset(specPath);
  const authored = new Uint8Array(await readFile(path.join(workspace, "face.glb")));
  const { glb, transfer } = await applyFaceVariants(root, head, authored);
  return { glb, authored, observations: { ...((generated.receipt.observations as Record<string, any>).script as Record<string, any>), transfer } };
}

/** Copies the authored face morph targets onto `part` (the same head geometry, e.g. with another skin texture). */
export async function applyFaceVariants(root: string, part: AssetRef, authored: Uint8Array) {
  const { glb, transfer } = await transferFaceMorphs(new Uint8Array(await resolveAssetObject(root, part)), authored);
  const asset = (await storeAssetObject(root, { bytes: glb, kind: "scene", mediaType: "model/gltf-binary",
    metadata: { operation: "face-variants-v1", source: part.sha256, authored: sha256Bytes(authored) } })).asset;
  return { glb: asset, transfer };
}

type Sample = { position: number[]; normal: number[]; deltas: { position: number[]; normal: number[] }[] };
const MATCH_TOLERANCE = 1e-4;
const cellOf = (size: number) => (p: ArrayLike<number>) => [0, 1, 2].map((i) => Math.round(p[i]! / size));

/**
 * Copies the morph targets of every mesh node in `authored` onto the node of the same name in `source`. Each source
 * vertex takes the deltas of the authored vertex at its position (within 0.1 mm; of several, the one whose normal is
 * closest). Fails when a vertex has no counterpart or the target names differ from `FACE_MORPH_TARGETS`. The targets are
 * written as sparse accessors, since most vertices do not move for most keys.
 */
export async function transferFaceMorphs(sourceBytes: Uint8Array, authoredBytes: Uint8Array) {
  return transferMorphTargets(sourceBytes, authoredBytes, FACE_MORPH_TARGETS, { exact: true, label: "the head part" });
}

/**
 * Copies the morph targets named in `wanted` from every mesh node of `authored` onto the node of the same name in
 * `source`, after any targets the source node already has (#380 adds the age and build keys after the face keys).
 * Vertices are matched as in `transferFaceMorphs`, within `tolerance` (default 0.1 mm; the nearest wins, then the normal).
 * A composed character binds its head and outfit skins a little differently at the neck, so Blender re-poses a few
 * vertices there by up to 2 mm; the variety keys are smooth fields and take a 3 mm tolerance. With `exact`, every
 * authored node's targets must be exactly `wanted`,
 * every authored node must exist in the source and the source must have no targets yet; otherwise authored nodes the
 * source lacks are skipped (one authoring run may carry several assets) and the report says which nodes took targets.
 */
export async function transferMorphTargets(sourceBytes: Uint8Array, authoredBytes: Uint8Array, wanted: readonly string[],
  { exact = false, label = "the source", tolerance = MATCH_TOLERANCE }: { exact?: boolean; label?: string; tolerance?: number } = {}) {
  const cell = cellOf(tolerance);
  const io = new NodeIO().setAllowNetwork(false);
  const source = await io.readBinary(sourceBytes);
  const authored = await io.readBinary(authoredBytes);
  const buffer = source.getRoot().listBuffers()[0]!;
  const report: Record<string, { vertices: number; maxMatchDistance: number; movedVertices: Record<string, number> }> = {};
  for (const node of authored.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !mesh.listPrimitives().some((primitive) => primitive.listTargets().length)) continue;
    const authoredNames = (mesh.getExtras() as { targetNames?: string[] }).targetNames ?? [];
    if (exact && JSON.stringify(authoredNames) !== JSON.stringify(wanted)) throw new Error(`${node.getName()}: morph targets ${JSON.stringify(authoredNames)} are not the face keys`);
    const names = authoredNames.filter((name) => wanted.includes(name));
    if (!names.length) continue;
    const target = source.getRoot().listNodes().find((candidate) => candidate.getName() === node.getName() && candidate.getMesh());
    if (!target) {
      if (exact) throw new Error(`${label} has no mesh node '${node.getName()}'`);
      continue;
    }
    const grid = new Map<string, Sample[]>();
    for (const primitive of mesh.listPrimitives()) {
      for (const sample of samples(primitive, names.map((name) => authoredNames.indexOf(name)))) {
        const key = cell(sample.position).join(",");
        grid.set(key, [...(grid.get(key) ?? []), sample]);
      }
    }
    const targetMesh = target.getMesh()!;
    const existing = (targetMesh.getExtras() as { targetNames?: string[] }).targetNames ?? [];
    const clash = names.find((name) => existing.includes(name));
    if (clash) throw new Error(`${node.getName()} already has the morph target ${clash}`);
    const entry = report[node.getName()] = { vertices: 0, maxMatchDistance: 0, movedVertices: Object.fromEntries(names.map((name) => [name, 0])) };
    for (const primitive of targetMesh.listPrimitives()) {
      if (exact && primitive.listTargets().length) throw new Error(`${node.getName()} already has morph targets`);
      if (primitive.listTargets().length !== existing.length) throw new Error(`${node.getName()}: its primitives' morph targets do not match its targetNames`);
      const positions = primitive.getAttribute("POSITION")!, normals = primitive.getAttribute("NORMAL");
      const count = positions.getCount();
      const deltas = names.map(() => ({ position: new Float32Array(count * 3), normal: new Float32Array(count * 3) }));
      const p: number[] = [], n: number[] = [];
      for (let vertex = 0; vertex < count; vertex += 1) {
        positions.getElement(vertex, p);
        if (normals) normals.getElement(vertex, n);
        const [x, y, z] = cell(p);
        let best: Sample | undefined, bestDistance = Infinity, bestNormal = -Infinity;
        for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
          for (const candidate of grid.get(`${x! + dx},${y! + dy},${z! + dz}`) ?? []) {
            const distance = Math.hypot(...[0, 1, 2].map((i) => candidate.position[i]! - p[i]!));
            if (distance > tolerance) continue;
            const facing = normals ? candidate.normal.reduce((sum, value, i) => sum + value * n[i]!, 0) : 0;
            // Nearest first (to 0.1 mm), then the closest normal (seams have several vertices at one position).
            const bucket = Math.round(distance / MATCH_TOLERANCE), bestBucket = Math.round(bestDistance / MATCH_TOLERANCE);
            if (bucket < bestBucket || (bucket === bestBucket && (facing > bestNormal + 1e-6 || (Math.abs(facing - bestNormal) <= 1e-6 && distance < bestDistance)))) {
              best = candidate; bestDistance = distance; bestNormal = facing;
            }
          }
        }
        if (!best) throw new Error(`${node.getName()}: vertex ${vertex} at ${p.map((value) => value.toFixed(5))} has no authored counterpart`);
        entry.maxMatchDistance = Math.max(entry.maxMatchDistance, bestDistance);
        best.deltas.forEach((delta, index) => {
          deltas[index]!.position.set(delta.position, vertex * 3);
          deltas[index]!.normal.set(delta.normal, vertex * 3);
          if (Math.hypot(...delta.position) > 1e-6) entry.movedVertices[names[index]!]! += 1;
        });
      }
      entry.vertices += count;
      names.forEach((name, index) => {
        const morph = source.createPrimitiveTarget(name)
          .setAttribute("POSITION", accessor(source, buffer, `${name}.POSITION`, deltas[index]!.position));
        if (normals) morph.setAttribute("NORMAL", accessor(source, buffer, `${name}.NORMAL`, deltas[index]!.normal));
        primitive.addTarget(morph);
      });
    }
    targetMesh.setWeights([...existing, ...names].map(() => 0)).setExtras({ ...(targetMesh.getExtras() as object), targetNames: [...existing, ...names] });
  }
  const missing = Object.keys(report).length === 0;
  if (missing) throw new Error(`the authored ${exact ? "head part" : "asset"} has no morph targets for ${label}`);
  return { glb: await io.writeBinary(source), transfer: report };
}

function accessor(document: Document, buffer: ReturnType<Document["createBuffer"]>, name: string, array: Float32Array) {
  let moved = 0;
  for (let index = 0; index < array.length; index += 3) if (array[index] || array[index + 1] || array[index + 2]) moved += 1;
  return document.createAccessor(name).setType("VEC3").setArray(array).setBuffer(buffer).setSparse(moved * 6 < array.length);
}

function samples(primitive: Primitive, indices?: readonly number[]): Sample[] {
  const positions = primitive.getAttribute("POSITION")!, normals = primitive.getAttribute("NORMAL");
  const all = primitive.listTargets();
  const targets = indices ? indices.map((index) => all[index]!) : all;
  const out: Sample[] = [];
  for (let vertex = 0; vertex < positions.getCount(); vertex += 1) {
    out.push({
      position: positions.getElement(vertex, []), normal: normals ? normals.getElement(vertex, []) : [0, 0, 0],
      deltas: targets.map((morph) => ({
        position: morph.getAttribute("POSITION")?.getElement(vertex, []) ?? [0, 0, 0],
        normal: morph.getAttribute("NORMAL")?.getElement(vertex, []) ?? [0, 0, 0],
      })),
    });
  }
  return out;
}

/**
 * The `face` section of the `humanoid-appearance-v1` descriptor: the features with their options (each option names
 * the morph weights it sets; the base sets none), the nodes carrying the targets, the character variants that have
 * them, and the variants that do not (levels of detail), where a non-base option must be refused.
 */
export function faceAppearance({ nodes, variants, unsupported }: { nodes: readonly string[]; variants: readonly string[]; unsupported: readonly string[] }) {
  return {
    nodes: [...nodes],
    variants: [...variants],
    unsupported: { variants: [...unsupported], reason: "levels of detail carry no face morph targets and show the base face" },
    features: FACE_FEATURES.map((feature) => ({
      id: feature.id, label: feature.label, default: feature.options[0][0],
      options: feature.options.map(([id, label], index) => ({ id, label, morphs: index === 0 ? {} : { [id]: 1 } })),
    })),
  };
}
