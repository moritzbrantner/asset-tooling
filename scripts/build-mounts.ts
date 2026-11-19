// Greyhaven mounts (#769, docs/mounts.md): the tacked riding horse with its sockets and riding gaits.
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-mounts.ts --out <directory>
// One external.blender.script@1 run of adapters/blender/mounts.py over the hash-pinned CC0 Quaternius Horse.glb
// (imported offline from hydrated LFS storage), checked through scene.import.gltf@2 and exported as a
// gltf-resources-v1 bundle packed to <directory>/greyhaven.mounts.tar, next to the measured
// greyhaven-mounts-descriptor-v1, lineage.json and export.ref.json. The gait timing and the tack's seat-frame points
// come from src/mounts.ts, which the Ranger's ride clips share.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Node } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS, GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { generateAsset } from "../src/index.js";
import { MOUNT_TACK, mountArguments } from "../src/mounts.js";
import { parseAssetSpec } from "../src/schema.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const MOUNTS_RELEASE = "mounts";
export const MOUNTS_TAR_NAME = "greyhaven.mounts.tar";
export const MOUNTS_DESCRIPTOR_SCHEMA = "greyhaven-mounts-descriptor-v1";
export const MOUNTS_DESCRIPTOR_ATTACHMENT = "mounts-descriptor";
export const MOUNTS_DESCRIPTOR_FILE = "greyhaven.mounts.descriptor.json";
export const HORSE_KEY = "greyhaven.mount.horse";
export const HORSE_SOURCE = { sourceId: "quaternius.ultimate-animated-animals-horse-glb", member: "Horse.glb", pack: "Quaternius Ultimate Animated Animals" } as const;
/** The horse's clips in bundle order: the idle, the four gaits, the turns, the spook and the halt. */
export const HORSE_CLIPS = ["Ride_Idle_Loop", "Walk_Loop", "Trot_Loop", "Canter_Loop", "Gallop_Loop", "Turn_L", "Turn_R", "Rear", "Halt"] as const;
/** The sockets, all on `Torso2`: the rider's seat, its rein hands and its stirrup treads. */
export const HORSE_SOCKETS = ["saddle.seat", "reins.l", "reins.r", "stirrup.l", "stirrup.r"] as const;
/** The Ranger's ride clips (src/ranger-clips.ts RANGER_RIDE_CLIPS) and the horse clip each plays with. */
export const RIDER_CLIPS: Record<string, string> = {
  Mount_Horse: "Ride_Idle_Loop", Dismount_Horse: "Ride_Idle_Loop", Ride_Idle_Loop: "Ride_Idle_Loop", Ride_Walk_Loop: "Walk_Loop",
  Ride_Trot_Loop: "Trot_Loop", Ride_Canter_Loop: "Canter_Loop", Ride_Gallop_Loop: "Gallop_Loop", Ride_Turn_L: "Turn_L", Ride_Turn_R: "Turn_R",
};
const POLICY = { allowedValidatorWarnings: [...GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS] };
const round5 = (value: number) => +value.toFixed(5);

function single(result: AssetOperationResult): AssetRef {
  const output = result.outputs.output;
  if (!output || Array.isArray(output)) throw new Error("asset operation returned no single output");
  return output;
}

/**
 * A root-frame point (glTF axes, the horse at rest) as a socket of `joint`: its translation and the rotation that
 * turns the joint's frame back to the root's axes (the seat frame), so a child of the joint at this transform has
 * +X the horse's left, +Y up and +Z ahead.
 */
export function socketOn(joint: Node, at: readonly number[]) {
  const m = joint.getWorldMatrix();
  const scale = Math.hypot(m[0]!, m[1]!, m[2]!);
  // Columns of the joint's world rotation.
  const r = [0, 1, 2].map((c) => [m[c * 4]! / scale, m[c * 4 + 1]! / scale, m[c * 4 + 2]! / scale]);
  const d = [at[0]! - m[12]!, at[1]! - m[13]!, at[2]! - m[14]!];
  // Six decimals: the joint frame is scaled up about 42 times, so a joint-local metre is a few centimetres.
  const translation = r.map((column) => +((column[0]! * d[0]! + column[1]! * d[1]! + column[2]! * d[2]!) / scale).toFixed(6));
  // The inverse rotation (the transpose, m[i][j] = column i's j-th entry) as a quaternion (x, y, z, w).
  const m3 = (i: number, j: number) => r[i]![j]!;
  const trace = m3(0, 0) + m3(1, 1) + m3(2, 2);
  let q: number[];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m3(2, 1) - m3(1, 2)) / s, (m3(0, 2) - m3(2, 0)) / s, (m3(1, 0) - m3(0, 1)) / s, s / 4];
  } else if (m3(0, 0) > m3(1, 1) && m3(0, 0) > m3(2, 2)) {
    const s = Math.sqrt(1 + m3(0, 0) - m3(1, 1) - m3(2, 2)) * 2;
    q = [s / 4, (m3(0, 1) + m3(1, 0)) / s, (m3(0, 2) + m3(2, 0)) / s, (m3(2, 1) - m3(1, 2)) / s];
  } else if (m3(1, 1) > m3(2, 2)) {
    const s = Math.sqrt(1 + m3(1, 1) - m3(0, 0) - m3(2, 2)) * 2;
    q = [(m3(0, 1) + m3(1, 0)) / s, s / 4, (m3(1, 2) + m3(2, 1)) / s, (m3(0, 2) - m3(2, 0)) / s];
  } else {
    const s = Math.sqrt(1 + m3(2, 2) - m3(0, 0) - m3(1, 1)) * 2;
    q = [(m3(0, 2) + m3(2, 0)) / s, (m3(1, 2) + m3(2, 1)) / s, s / 4, (m3(1, 0) - m3(0, 1)) / s];
  }
  if (q[3]! < 0) q = q.map((value) => -value);
  return { translation, rotation: q.map(round5) };
}

export function createMountAssetSpec({ sourceSha256, scriptSha256, blenderVersion }: { sourceSha256: string; scriptSha256: string; blenderVersion: string }) {
  return parseAssetSpec({
    schemaVersion: 1, assetId: HORSE_KEY, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs: { script: { path: "mounts.py", sha256: scriptSha256 }, source: { path: "source.glb", sha256: sourceSha256 } }, models: {},
    parameters: { blenderVersion, arguments: mountArguments() }, output: { path: "horse.glb" }, reproducibility: { expected: "exact" },
  });
}

export async function buildMounts({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const read = async (file: string) => JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
  const [providers, sources, storage] = await Promise.all(["catalog/providers.json", "catalog/sources.json", "catalog/storage.json"].map(read));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const recipe = await readBlenderRecipeSource("mounts.py");
  log(`generate ${HORSE_KEY} (external.blender.script@1 mounts recipe over ${HORSE_SOURCE.sourceId})`);
  const workspace = path.join(root, "horse");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "mounts.py"), recipe.bytes);
  const source = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: HORSE_SOURCE.sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
  await writeFile(path.join(workspace, "source.glb"), await resolveAssetObject(root, source));
  const specPath = path.join(workspace, "asset.json");
  await writeFile(specPath, `${canonicalJson(createMountAssetSpec({ sourceSha256: source.sha256, scriptSha256: recipe.sha256, blenderVersion: recipe.blenderVersion }))}\n`);
  const generated = await generateAsset(specPath);
  const observations = (generated.receipt.observations as Json).script as Json;
  const glb = (await storeAssetObject(root, { bytes: await readFile(path.join(workspace, "horse.glb")), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
  const imported = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
  const document = await new NodeIO().readBinary(new Uint8Array(await resolveAssetObject(root, imported)));

  log("measure the mounts descriptor");
  const gltf = document.getRoot();
  const nodes = new Map(gltf.listNodes().map((node) => [node.getName(), node]));
  const sockets = HORSE_SOCKETS.map((id) => {
    const { bone, at } = observations.sockets[id] as { bone: string; at: number[] };
    const joint = nodes.get(bone);
    if (!joint) throw new Error(`the horse has no ${bone} joint for ${id}`);
    return { id, joint: bone, ...socketOn(joint, at), restAt: at };
  });
  const recipeRef = { script: "adapters/blender/mounts.py", sha256: recipe.sha256 };
  const { min, max } = observations.restBounds as { min: number[]; max: number[] };
  const descriptor = {
    schema: MOUNTS_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", facing: "+Z", handedness: "right", origin: "footprint-ground-center",
    placement: "A rideable horse. The consumer owns spawning, mounting rules, steering, travel, collision and gameplay; none is implied here.",
    clips: { names: [...HORSE_CLIPS], rootMotion: "in-place", sampleRate: observations.fps },
    assets: [{
      key: HORSE_KEY, variant: "default", mount: "horse",
      restBounds: { min, max },
      size: Object.fromEntries((["width", "height", "depth"] as const).map((name, axis) => [name, round5(max[axis]! - min[axis]!)])),
      triangles: gltf.listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0),
      joints: observations.joints,
      sockets,
      seat: {
        socket: "saddle.seat", heightMeters: observations.seatHeightMeters, frame: "+X the horse's left, +Y up, +Z ahead",
        rider: "the rider's root on saddle.seat; its pelvis joint sits there while seated", tack: MOUNT_TACK,
      },
      clips: Object.fromEntries(gltf.listAnimations().map((animation) => {
        const name = animation.getName();
        const observed = observations.clips[name] as Json;
        return [name, {
          seconds: round5(Math.max(...animation.listSamplers().map((s) => s.getInput()!.getMax([])[0]!))),
          loop: name.endsWith("_Loop"),
          ...Object.fromEntries(Object.entries(observed).filter(([key]) => !["durationSeconds", "loop", "reachErrorMeters"].includes(key))),
        }];
      })),
      rider: { family: "ride", releases: ["humanoid-ranger-male", "humanoid-ranger-female"], clips: RIDER_CLIPS },
      provenance: { pack: HORSE_SOURCE.pack, member: HORSE_SOURCE.member, catalogSource: HORSE_SOURCE.sourceId, license: "CC0-1.0", source,
        tack: "original, authored by the recipe", clips: "original, authored by the recipe", recipe: recipeRef },
    }],
  };
  const descriptorBytes = Buffer.from(`${canonicalJson(descriptor)}\n`);
  await writeFile(path.join(root, MOUNTS_DESCRIPTOR_FILE), descriptorBytes);
  const attachment = (await storeAssetObject(root, { bytes: descriptorBytes, kind: "descriptor", mediaType: "application/json", metadata: { schema: MOUNTS_DESCRIPTOR_SCHEMA } })).asset;

  log("export gltf-resources-v1 bundle and pack the release tar");
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [{ key: HORSE_KEY, variant: "default", attachments: [{ name: MOUNTS_DESCRIPTOR_ATTACHMENT }] }] },
    inputs: { assets: [imported], attachments: [attachment] },
  });
  const tar = path.join(root, MOUNTS_TAR_NAME);
  const pack = Bun.spawnSync(["bun", path.join(ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tar], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`bundle packing failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  const ref = readAssetBundleTar(await readFile(tar)).find((item) => item.path === ASSET_BUNDLE_REF_FILE);
  if (!ref) throw new Error("packed mounts bundle has no export ref");
  await writeFile(path.join(root, ASSET_BUNDLE_REF_FILE), ref.bytes);
  const lineage = {
    release: MOUNTS_RELEASE, recipe: { ...recipeRef, blenderVersion: recipe.blenderVersion },
    mounts: { horse: { key: HORSE_KEY, catalogSource: HORSE_SOURCE.sourceId, license: "CC0-1.0", source, generated: glb, imported, observations } },
  };
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(lineage, null, 2)}\n`);
  return {
    bundleDir, tar, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number, descriptor, manifest: exported.manifest,
    exportRef: JSON.parse(ref.bytes.toString("utf8")) as Json, lineage, glb,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") {
    console.error("Usage: ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-mounts.ts --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildMounts({ outDir: args[1]!, log: (line) => console.error(`[mounts] ${line}`) });
    console.log(JSON.stringify({ tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
