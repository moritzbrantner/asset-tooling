// Build Marshal Elden Greywatch's furnished house (#413, docs/greyhaven-marshal-house.md) from the scripted
// Blender recipe adapters/blender/marshal_house.py, which reuses the Outpost kit recipe
// (adapters/blender/outpost.py) and the settlement props (adapters/blender/settlement_props.py) as its declared
// Python inputs `outpost` and `settlement`:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-marshal-house.ts --out <directory>
// Each part (shell, ceiling, roof, door, furniture, collision) is one external.blender.script@1 run, imported
// through scene.import.gltf@2. The house descriptor is measured on the imported GLBs. <directory> becomes the
// object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/greyhaven.marshal-house.tar, with export.ref.json, descriptor.json and lineage.json beside it.
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
import { triangles } from "./build-settlement-props.ts";

type Json = Record<string, any>;
type Vec3 = [number, number, number];
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const HOUSE_PARTS = ["shell", "ceiling", "roof", "door", "furniture", "collision"] as const;
export type HousePart = (typeof HOUSE_PARTS)[number];
export const HOUSE_KEY_PREFIX = "greyhaven.marshal-house";
export const HOUSE_VARIANT = "default";
export const HOUSE_DESCRIPTOR_SCHEMA = "greyhaven-marshal-house-descriptor-v1";
export const HOUSE_DESCRIPTOR_ATTACHMENT = "house-descriptor";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const HOUSE_RELEASE = "greyhaven-marshal-house";
export const HOUSE_TAR_NAME = "greyhaven.marshal-house.tar";
/** mmorpg's west Outpost house, collider 103: centre (-24, 36) m, 8 x 6 m, 5 m high. */
export const HOUSE_PLACEMENT_FOOTPRINT = { width: 8, depth: 6, height: 5 } as const;
/** The kit's door swings inward: +90 degrees about +Y turns the closed leaf (+X) to -Z, into the room. */
export const HOUSE_DOOR_OPEN_ANGLE = Math.PI / 2;

const round = (value: number) => { const r = Math.round(value * 1e6) / 1e6; return r === 0 ? 0 : r; };
const round3 = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];
export const houseKey = (part: HousePart) => `${HOUSE_KEY_PREFIX}.${part}`;

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

export function createHouseAssetSpec({ part, scriptSha256, outpostSha256, settlementSha256, commonSha256, blenderVersion }: {
  part: HousePart; scriptSha256: string; outpostSha256: string; settlementSha256: string; commonSha256: string; blenderVersion: string;
}) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: houseKey(part), generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: {
      script: { path: "marshal_house.py", sha256: scriptSha256 },
      outpost: { path: "outpost.py", sha256: outpostSha256 },
      settlement: { path: "settlement_props.py", sha256: settlementSha256 },
      common: { path: "kit_common.py", sha256: commonSha256 },
    },
    models: {}, parameters: { blenderVersion, arguments: { schemaVersion: 1, part } }, output: { path: "house.glb" }, reproducibility: { expected: "exact" },
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

/** The closed and open AABBs of the door leaf in the house frame, turned about its hinge. */
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
  return { closed: extent(0), open: extent(HOUSE_DOOR_OPEN_ANGLE) };
}

type Built = { asset: AssetRef; document: Document; observations: Json };

export async function buildGreyhavenMarshalHouse({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("marshal_house.py");
  const outpost = await readBlenderRecipeSource("outpost.py");
  const settlement = await readBlenderRecipeSource("settlement_props.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const io = new NodeIO();
  const parts = {} as Record<HousePart, Built>;
  for (const part of HOUSE_PARTS) {
    log(`generate ${part} (external.blender.script@1 marshal-house recipe, scene.import.gltf@2)`);
    const workspace = path.join(root, "marshal-house", part);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "marshal_house.py"), source.bytes);
    await writeFile(path.join(workspace, "outpost.py"), outpost.bytes);
    await writeFile(path.join(workspace, "settlement_props.py"), settlement.bytes);
    await writeFile(path.join(workspace, "kit_common.py"), common.bytes);
    const specPath = path.join(workspace, "asset.json");
    const spec = createHouseAssetSpec({ part, scriptSha256: source.sha256, outpostSha256: outpost.sha256, settlementSha256: settlement.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion });
    await writeFile(specPath, `${canonicalJson(spec)}\n`);
    const generated = await generateAsset(specPath);
    const observations = (generated.receipt.observations as Json).script as Json;
    const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "house.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
    const asset = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: { allowedValidatorWarnings: [] } } }));
    parts[part] = { asset, document: await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset))), observations };
  }

  log("measure the house descriptor");
  const hinge = emptyTranslation(parts.shell.document, "door.hinge");
  const leaf = bounds(parts.door.document);
  const exterior = [bounds(parts.shell.document), bounds(parts.roof.document)];
  const overall = { min: round3([0, 1, 2].map((k) => Math.min(...exterior.map((b) => b.min[k]!)))), max: round3([0, 1, 2].map((k) => Math.max(...exterior.map((b) => b.max[k]!)))) };
  const colliders = parts.collision.document.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => {
    const [, tag, ...rest] = node.getName().split(".");
    const box = bounds(parts.collision.document, node.getName());
    return { node: node.getName(), tag: tag!, name: rest.join("."), frame: tag === "door" ? "door" : "house", min: box.min, max: box.max };
  }).sort((a, b) => a.node < b.node ? -1 : a.node > b.node ? 1 : 0);
  const furniture = parts.furniture.document.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => node.getName()).sort();
  const descriptor = {
    schema: HOUSE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-base-center",
    exterior: { kit: "outpost-kit", composition: "house" },
    placementFootprint: HOUSE_PLACEMENT_FOOTPRINT,
    bounds: overall,
    entries: Object.fromEntries(HOUSE_PARTS.map((part) => [part, houseKey(part)])),
    hideForInterior: [houseKey("roof"), houseKey("ceiling")],
    room: { min: [-3.68, 0.02, -2.68], max: [3.68, 2.95, 2.68] },
    door: {
      key: houseKey("door"), mount: { parent: houseKey("shell"), translation: hinge }, hingeAxis: [0, 1, 0],
      closedAngle: 0, openAngle: round(HOUSE_DOOR_OPEN_ANGLE), swing: "inward", leafBounds: leaf, ...doorExtents(leaf, hinge),
    },
    smoke: emptyTranslation(parts.shell.document, "smoke"),
    spots: parts.furniture.observations.spots,
    furniture,
    triangles: Object.fromEntries(HOUSE_PARTS.map((part) => [part, triangles(parts[part].document)])),
    colliders,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "house-descriptor", mediaType: "application/json" })).asset;

  log("export gltf-resources-v1 bundle (asset.bundle@4)");
  const bundleDir = path.join(root, "bundle");
  const selections = HOUSE_PARTS.map((part) => ({ key: houseKey(part), variant: HOUSE_VARIANT, ...(part === "shell" ? { attachments: [{ name: HOUSE_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
    inputs: { assets: HOUSE_PARTS.map((part) => parts[part].asset), attachments: [descriptorAsset] },
  });
  const tarPath = path.join(root, HOUSE_TAR_NAME);
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
    lineage: {
      recipe: {
        script: "adapters/blender/marshal_house.py", sha256: source.sha256, blenderVersion: source.blenderVersion,
        outpost: { script: "adapters/blender/outpost.py", sha256: outpost.sha256 },
        common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 },
        settlement: { script: "adapters/blender/settlement_props.py", sha256: settlement.sha256 },
      },
      release: HOUSE_RELEASE, parts: Object.fromEntries(HOUSE_PARTS.map((part) => [part, parts[part].asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-marshal-house.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildGreyhavenMarshalHouse({ outDir: args[1]!, log: (line) => console.error(`[marshal-house] ${line}`) });
    await writeFile(path.join(path.resolve(args[1]!), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    await writeFile(path.join(path.resolve(args[1]!), "descriptor.json"), `${JSON.stringify(result.descriptor, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
