// Build the toy-style, flat-colour Zoo scenery (#357, docs/zoo-scenery.md) from the scripted Blender recipe
// adapters/blender/zoo_scenery.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-zoo-scenery.ts --out <directory>
// Each piece is one external.blender.script@1 run, checked through scene.import.gltf@2. The GLBs are exported
// as the self-contained static-glb-png-v1 package (the farm-structures format), packed to
// <directory>/zoo-scenery.tar (+ .sha256), next to the measured zoo-scenery-descriptor-v1
// (<directory>/zoo-scenery.descriptor.json), lineage.json and export.ref.json.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { STATIC_ASSET_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, documentBounds, exportKitBundle, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";

export type ZooSceneryKind = "tree" | "bush" | "grass" | "rock";
export type ZooSceneryPiece = { kind: ZooSceneryKind; variant: string };
/** Logical keys `<kind>.mesh`; the first variant of each kind is its default. */
export const ZOO_SCENERY_PIECES: readonly ZooSceneryPiece[] = [
  { kind: "tree", variant: "round" }, { kind: "tree", variant: "pine" }, { kind: "tree", variant: "acacia" }, { kind: "bush", variant: "round" },
  { kind: "grass", variant: "tuft" }, { kind: "rock", variant: "round" }, { kind: "rock", variant: "boulder" },
];
export const ZOO_DESCRIPTOR_SCHEMA = "zoo-scenery-descriptor-v1";
export const ZOO_DESCRIPTOR_FILE = "zoo-scenery.descriptor.json";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const ZOO_RELEASE = "zoo-scenery";
export const ZOO_TAR_NAME = "zoo-scenery.tar";
/** Each piece stands on one 1 m Zoo tile; only the acacia's flat crown overhangs it a little. */
export const ZOO_FOOTPRINT = { width: 1, depth: 1 };

export const zooMeshKey = (kind: ZooSceneryKind) => `${kind}.mesh`;
const pieceId = ({ kind, variant }: ZooSceneryPiece) => `${kind}-${variant}`;

export function createZooSceneryAssetSpec({ piece, scriptSha256, blenderVersion }: { piece: ZooSceneryPiece; scriptSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: `zoo.${piece.kind}.${piece.variant}`, inputs: { script: { path: "zoo_scenery.py", sha256: scriptSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, kind: piece.kind, variant: piece.variant }, output: `${pieceId(piece)}.glb`,
  });
}

export async function buildZooScenery({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("zoo_scenery.py");
  const parts = new Map<string, KitPart & { piece: ZooSceneryPiece }>();
  for (const piece of ZOO_SCENERY_PIECES) {
    const id = pieceId(piece);
    log(`generate ${id} (external.blender.script@1 zoo-scenery recipe, scene.import.gltf@2)`);
    // The import validates the GLB with no validator exceptions; the package ships the recipe's own GLB.
    parts.set(id, { piece, ...await buildKitPart(root, {
      workspace: path.join(root, "zoo", id), files: { "zoo_scenery.py": source.bytes }, use: "source",
      spec: createZooSceneryAssetSpec({ piece, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }

  log("measure the zoo-scenery descriptor");
  const descriptor = {
    schema: ZOO_DESCRIPTOR_SCHEMA, units: "metre", tile: 1, up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-ground-center",
    footprint: ZOO_FOOTPRINT,
    assets: [...parts.values()].map(({ piece, document, observations }) => {
      const bounds = documentBounds(document);
      return {
        key: zooMeshKey(piece.kind), variant: piece.variant, role: piece.kind, triangles: triangles(document),
        visual: { width: +(bounds.max[0] - bounds.min[0]).toFixed(6), depth: +(bounds.max[2] - bounds.min[2]).toFixed(6), height: +(bounds.max[1] - bounds.min[1]).toFixed(6) },
        bounds, piece: observations.piece,
      };
    }),
  };
  const descriptorPath = path.join(root, ZOO_DESCRIPTOR_FILE);
  await writeFile(descriptorPath, `${canonicalJson(descriptor)}\n`);

  const ordered = [...parts.values()].sort((a, b) => zooMeshKey(a.piece.kind).localeCompare(zooMeshKey(b.piece.kind)) || a.piece.variant.localeCompare(b.piece.variant));
  const packed = await exportKitBundle(root, {
    tarName: ZOO_TAR_NAME, log,
    invocation: {
      parameters: { profile: STATIC_ASSET_BUNDLE_PROFILE, assets: ordered.map(({ piece }) => ({ key: zooMeshKey(piece.kind), variant: piece.variant })) },
      inputs: { assets: ordered.map(({ asset }) => asset) },
    },
  });
  return {
    ...packed, descriptor, descriptorPath,
    documents: Object.fromEntries([...parts].map(([id, part]) => [id, part.document])) as Record<string, Document>,
    lineage: {
      recipe: { script: "adapters/blender/zoo_scenery.py", sha256: source.sha256, blenderVersion: source.blenderVersion },
      provenance: "procedural: original scripted geometry, no imported meshes, no third-party assets, no textures",
      release: ZOO_RELEASE, parts: Object.fromEntries([...parts].map(([id, part]) => [id, part.asset])),
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-zoo-scenery.ts", "zoo", buildZooScenery, { summary: (result) => ({ descriptor: result.descriptorPath }) });
