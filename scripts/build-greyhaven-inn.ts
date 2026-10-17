// Build the Greyhaven Outpost inn bundle (#272, docs/greyhaven-inn.md) from the scripted Blender recipe
// adapters/blender/inn.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-inn.ts --out <directory>
// Each part (shell, ceiling, roof, door, furniture, collision) is one external.blender.script@1 run,
// imported through scene.import.gltf@2. The inn-descriptor attachment is measured on the imported GLBs.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/greyhaven.inn.tar (+ .sha256) with scripts/pack-asset-bundle.ts.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { generateAsset } from "../src/index.js";
import { parseAssetSpec } from "../src/schema.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
type Vec3 = [number, number, number];
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const INN_PARTS = ["shell", "ceiling", "roof", "door", "furniture", "collision"] as const;
export type InnPart = (typeof INN_PARTS)[number];
export const INN_KEY_PREFIX = "greyhaven.inn";
export const INN_VARIANT = "default";
export const INN_DESCRIPTOR_SCHEMA = "greyhaven-inn-descriptor-v1";
export const INN_DESCRIPTOR_ATTACHMENT = "inn-descriptor";
export const INN_TAR_NAME = "greyhaven.inn.tar";
/** mmorpg's Outpost inn collider 101: x 8..22 m, z -5..5 m, 6 m high (crates/mmorpg-core greyhaven_vale.rs). */
export const INN_PLACEMENT_FOOTPRINT = { width: 14, depth: 10, height: 6 } as const;
/** The door swings inward: +90 degrees about +Y turns the closed leaf (+X) to -Z, into the room. */
export const INN_DOOR_OPEN_ANGLE = Math.PI / 2;

const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };
const round3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

export function createInnAssetSpec({ part, scriptSha256, blenderVersion }: { part: InnPart; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: `${INN_KEY_PREFIX}.${part}`, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "inn.py", sha256: scriptSha256 } }, models: {},
    parameters: { blenderVersion, arguments: { schemaVersion: 1, part } }, output: { path: "inn.glb" }, reproducibility: { expected: "exact" },
  });
}

/** World-space AABB of one mesh node, or of every mesh node in the document. */
function bounds(document: Document, nodeName?: string): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || (nodeName !== undefined && node.getName() !== nodeName)) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      const p: number[] = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        for (let k = 0; k < 3; k += 1) {
          const w = m[k]! * p[0]! + m[4 + k]! * p[1]! + m[8 + k]! * p[2]! + m[12 + k]!;
          min[k] = Math.min(min[k]!, w); max[k] = Math.max(max[k]!, w);
        }
      }
    }
  }
  if (!Number.isFinite(min[0]!)) throw new Error(`no mesh geometry${nodeName ? ` for node '${nodeName}'` : ""}`);
  return { min: round3(min), max: round3(max) };
}

function emptyTranslation(document: Document, name: string): Vec3 {
  const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === name && !candidate.getMesh());
  if (!node) throw new Error(`empty node '${name}' is missing`);
  return round3(node.getWorldTranslation());
}

/** The closed and open AABBs of the door leaf in the shell frame, turned about its hinge. */
function doorExtents(leaf: { min: Vec3; max: Vec3 }, hinge: Vec3) {
  const extent = (angle: number) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const x of [leaf.min[0], leaf.max[0]]) for (const y of [leaf.min[1], leaf.max[1]]) for (const z of [leaf.min[2], leaf.max[2]]) {
      const p = [hinge[0] + x * c + z * s, hinge[1] + y, hinge[2] - x * s + z * c];
      for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); }
    }
    return { min: round3(min), max: round3(max) };
  };
  return { closed: extent(0), open: extent(INN_DOOR_OPEN_ANGLE) };
}

export async function buildGreyhavenInn({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("inn.py");
  const io = new NodeIO();
  const parts = {} as Record<InnPart, { asset: AssetRef; document: Document }>;
  for (const part of INN_PARTS) {
    log(`generate ${part} (external.blender.script@1 inn recipe, scene.import.gltf@2)`);
    const workspace = path.join(root, "inn", part);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "inn.py"), source.bytes);
    const specPath = path.join(workspace, "asset.json");
    await writeFile(specPath, `${canonicalJson(createInnAssetSpec({ part, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }))}\n`);
    await generateAsset(specPath);
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "inn.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const asset = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings: [] } } }));
    parts[part] = { asset, document: await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))) };
  }

  log("measure the inn descriptor");
  const hinge = emptyTranslation(parts.shell.document, "door.hinge");
  const leaf = bounds(parts.door.document);
  const exterior = [bounds(parts.shell.document), bounds(parts.roof.document)];
  const overall = { min: round3([0, 1, 2].map((k) => Math.min(...exterior.map((b) => b.min[k]!)))), max: round3([0, 1, 2].map((k) => Math.max(...exterior.map((b) => b.max[k]!)))) };
  const colliders = parts.collision.document.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => {
    const [, tag, ...rest] = node.getName().split(".");
    const box = bounds(parts.collision.document, node.getName());
    return { node: node.getName(), tag: tag!, name: rest.join("."), frame: tag === "door" ? "door" : "inn", min: box.min, max: box.max };
  }).sort((a, b) => a.node < b.node ? -1 : a.node > b.node ? 1 : 0);
  const furnitureNodes = parts.furniture.document.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => node.getName()).sort();
  const key = (part: InnPart) => `${INN_KEY_PREFIX}.${part}`;
  const descriptor = {
    schema: INN_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-base-center",
    footprint: { width: round(overall.max[0] - overall.min[0]), depth: round(overall.max[2] - overall.min[2]), height: round(overall.max[1]) },
    placementFootprint: INN_PLACEMENT_FOOTPRINT,
    bounds: overall,
    entries: Object.fromEntries(INN_PARTS.map((part) => [part, key(part)])),
    hideForInterior: [key("roof"), key("ceiling")],
    door: {
      key: key("door"), mount: { parent: key("shell"), translation: hinge }, hingeAxis: [0, 1, 0],
      closedAngle: 0, openAngle: round(INN_DOOR_OPEN_ANGLE), swing: "inward", leafBounds: leaf, ...doorExtents(leaf, hinge),
    },
    furniture: furnitureNodes,
    colliders,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "inn-descriptor", mediaType: "application/json" })).asset;

  log("export gltf-resources-v1 bundle (asset.bundle@4)");
  const bundleDir = path.join(root, "bundle");
  const selections = INN_PARTS.map((part) => ({ key: key(part), variant: INN_VARIANT, ...(part === "shell" ? { attachments: [{ name: INN_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
    inputs: { assets: INN_PARTS.map((part) => parts[part].asset), attachments: [descriptorAsset] },
  });
  const tarPath = path.join(root, INN_TAR_NAME);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: { recipe: { script: "adapters/blender/inn.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, parts: Object.fromEntries(INN_PARTS.map((part) => [part, parts[part].asset])), descriptor: descriptorAsset },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-inn.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildGreyhavenInn({ outDir: args[1]!, log: (line) => console.error(`[inn] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef, footprint: result.descriptor.footprint }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
