// Build the #110 Ranger character bundle end to end from its canonical catalog members
// (docs/humanoid-ranger.md):
//   bun scripts/build-ranger-character.ts --processor-checkout <3d-lab checkout> --out <directory>
// The 3d-lab checkout must be source-clean at the commit stability/processors.json pins for
// `three-d-animation-retarget`, with its cargo dependencies fetched (the processor runs --offline).
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed
// to <directory>/humanoid.ranger.male.tar (+ .sha256) with scripts/pack-asset-bundle.ts.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { executeAnimationRetargetOperation } from "../src/animation-processing-operations.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject } from "../src/asset-store.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfEmbedAnimationOperation, executeGltfExtractAnimationOperation } from "../src/gltf-animation-operations.js";
import { executeGltfComposeSkinnedOperation } from "../src/gltf-compose-operations.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { executeGltfSubsetSkinnedOperation } from "../src/gltf-subset-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";

type Json = Record<string, any>;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWED = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const POLICY = { allowedValidatorWarnings: ALLOWED };

export const RANGER_BUNDLE_KEY = "humanoid.ranger.male";
export const RANGER_BUNDLE_VARIANT = "default";
export const RANGER_PROCESSOR_ID = "three-d-animation-retarget";
export const RANGER_PROCESSOR_MANIFEST = "examples/asset-tooling-animation-adapter/Cargo.toml";

export const RANGER_MEMBERS = {
  body: { archive: "quaternius.universal-base-characters-standard", path: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf" },
  outfit: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf" },
  clips: { archive: "quaternius.universal-animation-library-standard", path: "Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb" },
} as const;

/** The head/face subset of the UBC body (docs/gltf-subset.md, owner option A on #110). */
export const RANGER_HEAD_RECIPE = { keepJoints: ["neck_01", "Head"], minWeight: 0.5, keepMeshes: ["Face", "Face.001"], policy: POLICY };

/** Hips joints whose model-space height is each rig's reference height. */
export const RANGER_HIPS = { source: "DEF-hips", target: "pelvis" } as const;

/** The UAL1 clips and how they are retargeted (in-place: root translation removed, vertical bob kept). */
export const RANGER_CLIPS = [
  { name: "Idle_Loop", rootMotion: "in-place" },
  { name: "Walk_Loop", rootMotion: "in-place" },
] as const;
export const RANGER_SAMPLE_RATE = 30;

/** HumanoidBone id -> UAL1 Rigify `DEF-*` joint (source) and UBC/Outfits joint (target). */
export const RANGER_BONE_MAP: Record<string, { source: string; target: string }> = {
  root: { source: "root", target: "root" },
  hips: { source: "DEF-hips", target: "pelvis" },
  spine: { source: "DEF-spine.001", target: "spine_01" },
  chest: { source: "DEF-spine.003", target: "spine_03" },
  neck: { source: "DEF-neck", target: "neck_01" },
  head: { source: "DEF-head", target: "Head" },
  "left-shoulder": { source: "DEF-shoulder.L", target: "clavicle_l" },
  "left-upper-arm": { source: "DEF-upper_arm.L", target: "upperarm_l" },
  "left-lower-arm": { source: "DEF-forearm.L", target: "lowerarm_l" },
  "left-hand": { source: "DEF-hand.L", target: "hand_l" },
  "right-shoulder": { source: "DEF-shoulder.R", target: "clavicle_r" },
  "right-upper-arm": { source: "DEF-upper_arm.R", target: "upperarm_r" },
  "right-lower-arm": { source: "DEF-forearm.R", target: "lowerarm_r" },
  "right-hand": { source: "DEF-hand.R", target: "hand_r" },
  "left-upper-leg": { source: "DEF-thigh.L", target: "thigh_l" },
  "left-lower-leg": { source: "DEF-shin.L", target: "calf_l" },
  "left-foot": { source: "DEF-foot.L", target: "foot_l" },
  "left-toes": { source: "DEF-toe.L", target: "ball_l" },
  "right-upper-leg": { source: "DEF-thigh.R", target: "thigh_r" },
  "right-lower-leg": { source: "DEF-shin.R", target: "calf_r" },
  "right-foot": { source: "DEF-foot.R", target: "foot_r" },
  "right-toes": { source: "DEF-toe.R", target: "ball_r" },
};

function single(result: AssetOperationResult, port = "output"): AssetRef {
  const output = result.outputs[port];
  if (!output || Array.isArray(output)) throw new Error(`operation output '${port}' is missing`);
  return output;
}

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, file), "utf8"));
}

/** The pinned 3d-lab processor, run from an explicit checkout (verified clean at the pinned commit). */
export async function rangerProcessor(checkout: string) {
  if (!path.isAbsolute(checkout)) throw new Error("--processor-checkout must be an absolute path");
  const pins = await readJson("stability/processors.json");
  const pin = pins.processors.find((entry: Json) => entry.id === RANGER_PROCESSOR_ID);
  if (!pin) throw new Error(`stability/processors.json has no '${RANGER_PROCESSOR_ID}' pin`);
  return {
    repository: pin.repository, revision: pin.commit, executable: "cargo", scriptPath: "run",
    prefixArguments: ["--quiet", "--offline", "--manifest-path", path.join(checkout, ...pin.manifestPath.split("/")), "--bin", "animation_retarget", "--"],
    checkoutRoot: checkout,
  };
}

export async function buildRangerCharacter({ processorCheckout, outDir, log = () => {} }: { processorCheckout: string; outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const processor = await rangerProcessor(path.resolve(processorCheckout));
  const providers = await readJson("catalog/providers.json");
  const sources = await readJson("catalog/sources.json");
  const storage = await readJson("catalog/storage.json");
  const rawSources: Json[] = sources.sources;
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const memberId = ({ archive, path: memberPath }: { archive: string; path: string }) => {
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
    if (matches.length !== 1) throw new Error(`'${memberPath}' must be registered exactly once`);
    return matches[0]!.id as string;
  };
  // Adjacent basename, or the one member whose metadata.substitutesFor names the URI (docs/humanoid-sources.md).
  const resourceId = (archive: string, gltfId: string, uri: string) => {
    const substitutes = rawSources.filter((source) => source.metadata?.substitutesFor?.member === gltfId && source.metadata.substitutesFor.uri === uri);
    if (substitutes.length === 1) return substitutes[0]!.id as string;
    const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === uri);
    if (matches.length !== 1) throw new Error(`URI '${uri}' must resolve to exactly one member`);
    return matches[0]!.id as string;
  };
  const member = async (sourceId: string) =>
    (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: REPOSITORY_ROOT, objectStoreRoot: root })).asset as AssetRef;
  const importGltf = async (entry: { archive: string; path: string }) => {
    const gltfId = memberId(entry);
    const source = await member(gltfId);
    const json = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
    const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((item: Json) => item.uri);
    const resources: AssetRef[] = [];
    for (const uri of uris) resources.push(await member(resourceId(entry.archive, gltfId, uri)));
    return single(await executeGltfProductionImportOperation(root, { inputs: { source, resources }, parameters: { resourceUris: uris, policy: POLICY } }));
  };

  log("import body and outfit (scene.import.gltf@2)");
  const outfit = await importGltf(RANGER_MEMBERS.outfit);
  const body = await importGltf(RANGER_MEMBERS.body);
  log("subset body to head/face (scene.subset.skinned.gltf@1)");
  const head = single(await executeGltfSubsetSkinnedOperation(root, { inputs: { source: body }, parameters: RANGER_HEAD_RECIPE }));
  log("compose on the Male_Ranger skeleton (scene.compose.skinned.gltf@1)");
  const composed = single(await executeGltfComposeSkinnedOperation(root, { inputs: { skeleton: outfit, parts: [head] }, parameters: { policy: POLICY } }));

  log("extract target rig and UAL1 clips (scene.extract.animation.gltf@1)");
  const targetRig = single(await executeGltfExtractAnimationOperation(root, { inputs: { source: composed }, parameters: { hipsJoint: RANGER_HIPS.target, policy: POLICY } }), "rig");
  const library = await member(memberId(RANGER_MEMBERS.clips));
  const clips: { name: string; source: AssetRef; retargeted: AssetRef; observations: Json }[] = [];
  let sourceRig: AssetRef | undefined;
  for (const clip of RANGER_CLIPS) {
    const extracted = await executeGltfExtractAnimationOperation(root, {
      inputs: { source: library }, parameters: { hipsJoint: RANGER_HIPS.source, clip: clip.name, policy: POLICY },
    });
    sourceRig = single(extracted, "rig");
    const source = single(extracted, "animation");
    log(`retarget ${clip.name} (animation.retarget@1, rootMotion ${clip.rootMotion})`);
    const retargeted = await executeAnimationRetargetOperation(root, {
      inputs: { animation: source, "source-rig": sourceRig, "target-rig": targetRig },
      parameters: { bindings: RANGER_BONE_MAP, sampleRate: RANGER_SAMPLE_RATE, rootMotion: clip.rootMotion },
    }, processor);
    clips.push({ name: clip.name, source, retargeted: single(retargeted), observations: retargeted.observations as Json });
  }

  log("embed clips (scene.embed.animation.gltf@1)");
  const animated = single(await executeGltfEmbedAnimationOperation(root, {
    inputs: { source: composed, animations: clips.map((clip) => clip.retargeted) },
    parameters: { clips: clips.map((clip) => ({ name: clip.name })), policy: POLICY },
  }));

  log(`export gltf-resources-v1 bundle (asset.bundle@4, ${RANGER_BUNDLE_KEY}/${RANGER_BUNDLE_VARIANT})`);
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [{ key: RANGER_BUNDLE_KEY, variant: RANGER_BUNDLE_VARIANT }] },
    inputs: { assets: [animated] },
  });
  const tarPath = path.join(root, `${RANGER_BUNDLE_KEY}.tar`);
  log("pack release tar (scripts/pack-asset-bundle.ts)");
  const pack = Bun.spawnSync(["bun", path.join(REPOSITORY_ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tarPath], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`pack-asset-bundle failed: ${pack.stderr.toString()}`);
  const packed = JSON.parse(pack.stdout.toString());
  // The consumer pin is the tar's own content-only export.ref.json (docs/asset-bundles.md).
  const refEntry = readAssetBundleTar(await readFile(tarPath)).find((entry) => entry.path === ASSET_BUNDLE_REF_FILE);
  if (!refEntry) throw new Error(`packed tar has no ${ASSET_BUNDLE_REF_FILE}`);
  const exportRefPath = path.join(root, ASSET_BUNDLE_REF_FILE);
  await writeFile(exportRefPath, refEntry.bytes);
  return {
    bundleDir, tar: tarPath, tarSha256: packed.sha256 as string, tarByteLength: packed.byteLength as number,
    exportRef: JSON.parse(Buffer.from(refEntry.bytes).toString("utf8")) as Json, exportRefPath,
    lineage: {
      processor: { repository: processor.repository, revision: processor.revision },
      outfit, body, head, composed, targetRig, sourceRig, library, animated,
      clips: clips.map(({ name, source, retargeted, observations }) => ({ name, source, retargeted, observations })),
    },
  };
}

function parseArguments(args: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if ((flag !== "--processor-checkout" && flag !== "--out") || !value) return undefined;
    options[flag.slice(2)] = value;
  }
  return options["processor-checkout"] && options.out ? { processorCheckout: options["processor-checkout"], outDir: options.out } : undefined;
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error("Usage: bun scripts/build-ranger-character.ts --processor-checkout <absolute 3d-lab checkout> --out <directory>");
    process.exit(2);
  }
  try {
    const result = await buildRangerCharacter({ ...options, log: (line) => console.error(`[ranger] ${line}`) });
    await writeFile(path.join(path.resolve(options.outDir), "lineage.json"), `${JSON.stringify(result.lineage, null, 2)}\n`);
    console.log(JSON.stringify({ bundle: result.bundleDir, tar: result.tar, tarSha256: result.tarSha256, tarByteLength: result.tarByteLength, exportRef: result.exportRef, exportRefPath: result.exportRefPath }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
