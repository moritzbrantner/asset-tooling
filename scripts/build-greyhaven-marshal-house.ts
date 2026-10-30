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
import { mkdir } from "node:fs/promises";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, documentBounds as bounds, emptyTranslation, exportKitBundle, round, round3, runKitCli, triangles, type KitPart, type Vec3 } from "../src/kit-bundle.js";

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

export const houseKey = (part: HousePart) => `${HOUSE_KEY_PREFIX}.${part}`;

export function createHouseAssetSpec({ part, scriptSha256, outpostSha256, settlementSha256, commonSha256, blenderVersion }: {
  part: HousePart; scriptSha256: string; outpostSha256: string; settlementSha256: string; commonSha256: string; blenderVersion: string;
}) {
  return blenderScriptSpec({
    assetId: houseKey(part),
    inputs: {
      script: { path: "marshal_house.py", sha256: scriptSha256 },
      outpost: { path: "outpost.py", sha256: outpostSha256 },
      settlement: { path: "settlement_props.py", sha256: settlementSha256 },
      common: { path: "kit_common.py", sha256: commonSha256 },
    },
    blenderVersion, arguments: { schemaVersion: 1, part }, output: "house.glb",
  });
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

export async function buildGreyhavenMarshalHouse({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("marshal_house.py");
  const outpost = await readBlenderRecipeSource("outpost.py");
  const settlement = await readBlenderRecipeSource("settlement_props.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const parts = {} as Record<HousePart, KitPart>;
  for (const part of HOUSE_PARTS) {
    log(`generate ${part} (external.blender.script@1 marshal-house recipe, scene.import.gltf@2)`);
    parts[part] = await buildKitPart(root, {
      workspace: path.join(root, "marshal-house", part),
      files: { "marshal_house.py": source.bytes, "outpost.py": outpost.bytes, "settlement_props.py": settlement.bytes, "kit_common.py": common.bytes },
      spec: createHouseAssetSpec({ part, scriptSha256: source.sha256, outpostSha256: outpost.sha256, settlementSha256: settlement.sha256, commonSha256: common.sha256, blenderVersion: source.blenderVersion }),
    });
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

  const selections = HOUSE_PARTS.map((part) => ({ key: houseKey(part), variant: HOUSE_VARIANT, ...(part === "shell" ? { attachments: [{ name: HOUSE_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: HOUSE_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: HOUSE_PARTS.map((part) => parts[part].asset), attachments: [descriptorAsset] },
    },
  });
  return {
    ...packed, descriptor,
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

if (import.meta.main) await runKitCli("scripts/build-greyhaven-marshal-house.ts", "marshal-house", buildGreyhavenMarshalHouse, { descriptorFile: true });
