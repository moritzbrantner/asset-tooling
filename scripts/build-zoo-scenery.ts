// Build the toy-style, flat-colour Zoo scenery (#357, docs/zoo-scenery.md) from the scripted Blender recipe
// adapters/blender/zoo_scenery.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-zoo-scenery.ts --out <directory>
// Each piece is one external.blender.script@1 run, checked through scene.import.gltf@2. The GLBs are exported
// as the self-contained static-glb-png-v1 package (the farm-structures format), packed to
// <directory>/zoo-scenery.tar (+ .sha256), next to the measured zoo-scenery-descriptor-v1
// (<directory>/zoo-scenery.descriptor.json), lineage.json and export.ref.json.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { STATIC_ASSET_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { generateAsset } from "../src/index.js";
import { parseAssetSpec } from "../src/schema.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";
import { documentBounds } from "./build-shrine-kit.ts";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

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

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

export function createZooSceneryAssetSpec({ piece, scriptSha256, blenderVersion }: { piece: ZooSceneryPiece; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: `zoo.${piece.kind}.${piece.variant}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "zoo_scenery.py", sha256: scriptSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, kind: piece.kind, variant: piece.variant } }, output: { path: `${pieceId(piece)}.glb` }, reproducibility: { expected: "exact" },
  });
}

function triangles(document: Document) {
  let count = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    count += (primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")!.getCount()) / 3;
  }
  return count;
}

export async function buildZooScenery({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("zoo_scenery.py");
  const io = new NodeIO();
  const parts = new Map<string, { piece: ZooSceneryPiece; asset: AssetRef; document: Document; observations: Json }>();
  for (const piece of ZOO_SCENERY_PIECES) {
    const id = pieceId(piece);
    log(`generate ${id} (external.blender.script@1 zoo-scenery recipe, scene.import.gltf@2)`);
    const workspace = path.join(root, "zoo", id);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "zoo_scenery.py"), source.bytes);
    const specPath = path.join(workspace, "asset.json");
    await writeFile(specPath, `${canonicalJson(createZooSceneryAssetSpec({ piece, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }))}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const bytes = await readFile(path.join(workspace, `${id}.glb`));
    const glb = (await storeAssetObject(root, { bytes, kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    // The import validates the GLB with no validator exceptions; the package ships the recipe's own GLB.
    single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings: [] } } }));
    parts.set(id, { piece, asset: glb, document: await io.readBinary(new Uint8Array(await resolveAssetObject(root, glb))), observations });
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

  log("export static-glb-png-v1 package (asset.bundle@1)");
  const bundleDir = path.join(root, "bundle");
  const ordered = [...parts.values()].sort((a, b) => zooMeshKey(a.piece.kind).localeCompare(zooMeshKey(b.piece.kind)) || a.piece.variant.localeCompare(b.piece.variant));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: STATIC_ASSET_BUNDLE_PROFILE, assets: ordered.map(({ piece }) => ({ key: zooMeshKey(piece.kind), variant: piece.variant })) },
    inputs: { assets: ordered.map(({ asset }) => asset) },
  });
  const tarPath = path.join(root, ZOO_TAR_NAME);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, descriptorPath,
    documents: Object.fromEntries([...parts].map(([id, part]) => [id, part.document])) as Record<string, Document>,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: {
      recipe: { script: "adapters/blender/zoo_scenery.py", sha256: source.sha256, blenderVersion: source.blenderVersion },
      provenance: "procedural: original scripted geometry, no imported meshes, no third-party assets, no textures",
      release: ZOO_RELEASE, parts: Object.fromEntries([...parts].map(([id, part]) => [id, part.asset])),
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-zoo-scenery.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildZooScenery({ outDir: args[1]!, log: (line) => console.error(`[zoo] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, descriptor: result.descriptorPath, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
