// Build the Greyhaven Outpost inn bundle (#272, docs/greyhaven-inn.md) from the scripted Blender recipe
// adapters/blender/inn.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-greyhaven-inn.ts --out <directory>
// Each part (shell, ceiling, roof, door, furniture, collision) is one external.blender.script@1 run,
// imported through scene.import.gltf@2. The inn-descriptor attachment is measured on the imported GLBs.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/greyhaven.inn.tar (+ .sha256) with scripts/pack-asset-bundle.ts.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, documentBounds as bounds, emptyTranslation, exportKitBundle, round, round3, runKitCli, type KitPart, type Vec3 } from "../src/kit-bundle.js";

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

export function createInnAssetSpec({ part, scriptSha256, blenderVersion }: { part: InnPart; scriptSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: `${INN_KEY_PREFIX}.${part}`, inputs: { script: { path: "inn.py", sha256: scriptSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, part }, output: "inn.glb",
  });
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
  const parts = {} as Record<InnPart, KitPart>;
  for (const part of INN_PARTS) {
    log(`generate ${part} (external.blender.script@1 inn recipe, scene.import.gltf@2)`);
    parts[part] = await buildKitPart(root, {
      workspace: path.join(root, "inn", part), files: { "inn.py": source.bytes },
      spec: createInnAssetSpec({ part, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }),
    });
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
  const selections = INN_PARTS.map((part) => ({ key: key(part), variant: INN_VARIANT, ...(part === "shell" ? { attachments: [{ name: INN_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: INN_TAR_NAME, log,
    invocation: {
      parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections },
      inputs: { assets: INN_PARTS.map((part) => parts[part].asset), attachments: [descriptorAsset] },
    },
  });
  return {
    ...packed, descriptor,
    lineage: { recipe: { script: "adapters/blender/inn.py", sha256: source.sha256, blenderVersion: source.blenderVersion }, parts: Object.fromEntries(INN_PARTS.map((part) => [part, parts[part].asset])), descriptor: descriptorAsset },
  };
}

if (import.meta.main) await runKitCli("scripts/build-greyhaven-inn.ts", "inn", buildGreyhavenInn, { summary: (result) => ({ footprint: result.descriptor.footprint }) });
