// Dedicated game-resolution nature delivery for mmorpg#49 (asset-tooling#270).
// All input bytes come from the hydrated, verified catalog; this build never downloads.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle } from "../src/asset-bundle.js";
import { ASSET_BUNDLE_REF_FILE, readAssetBundleTar } from "../src/asset-bundle-pack.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfPlaceOperation } from "../src/gltf-place-operations.js";
import { executeGltfProductionImportOperation } from "../src/gltf-production-operations.js";
import { executeGltfTextureResizeOperation } from "../src/gltf-texture-resize-operations.js";
import type { AssetOperationResult, AssetRef } from "../src/operations.js";
import { blenderScriptSpec, type BlenderSpecInput } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { sha256Bytes } from "../src/hash.js";
import { runBlenderRecipe } from "../src/blender-recipe-run.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARCHIVE = "quaternius.stylized-nature-megakit-standard";
export const NATURE_DESCRIPTOR_SCHEMA = "greyhaven-nature-descriptor-v1";
export const NATURE_DESCRIPTOR_ATTACHMENT = "nature-descriptor";
export const NATURE_TAR_NAME = "greyhaven.nature.tar";
/**
 * The broadleaf keeps CommonTree_1's trunk; adapters/blender/broadleaf_crown.py replaces its leaves with a clumped,
 * vertex-coloured leaf-card canopy over an opaque core (#446). The seed and card count are the reviewed defaults.
 */
export const BROADLEAF_CROWN = { schemaVersion: 1, seed: 446, cards: 1100 } as const;
/**
 * The conifer keeps Pine_1's trunk; adapters/blender/conifer_crown.py replaces its leaves with solid drooping tiers of
 * CC0 Poly Haven fir sprig cards over opaque skirts (#450, #454). The seed and card count are the reviewed defaults.
 */
export const CONIFER_CROWN = { schemaVersion: 1, seed: 454, cards: 2900 } as const;
/** Extra catalog sources a crown recipe reads, by recipe input name. */
const CONIFER_NEEDLES = { needles: "poly-haven.fir-tree-01-twig-diff-2k-jpg", needleAlpha: "poly-haven.fir-tree-01-twig-alpha-2k-jpg" } as const;
/**
 * The rocks are authored by adapters/blender/nature_rock.py (#451): a fractured, bedded and weathered sculpt whose CC0
 * Poly Haven rock and moss material is baked onto a game mesh of about ROCK_TRIANGLES triangles.
 */
export const ROCK_TRIANGLES = 2000;
const ROCK_TEXTURES = {
  rockColour: "poly-haven.rock-boulder-dry-diff-2k-jpg", rockHeight: "poly-haven.rock-boulder-dry-disp-2k-jpg",
  rockRoughness: "poly-haven.rock-boulder-dry-rough-2k-jpg", mossColour: "poly-haven.mossy-rock-diff-2k-jpg",
} as const;
/** Each rock's descriptor entry carries its convex-hull collision proxy under this field (consumed by mmorpg#577). */
export const NATURE_COLLISION_PROXY = "collisionProxy";
function rock(shape: "stratified" | "boulder" | "slab", seed: number, size: [number, number, number]) {
  return { schemaVersion: 1, shape, seed, size, triangles: ROCK_TRIANGLES };
}
export const NATURE_MEMBERS = [
  { key: "greyhaven.nature.tree.broadleaf", family: "tree", shape: "broadleaf", source: "CommonTree_1", crown: BROADLEAF_CROWN },
  { key: "greyhaven.nature.tree.conifer", family: "tree", shape: "conifer", source: "Pine_1", crown: CONIFER_CROWN, crownInputs: CONIFER_NEEDLES },
  { key: "greyhaven.nature.rock.1", family: "rock", shape: "stratified", rock: rock("stratified", 4511, [3.2, 3.0, 2.2]) },
  { key: "greyhaven.nature.rock.2", family: "rock", shape: "boulder", rock: rock("boulder", 4512, [3.0, 2.5, 1.9]) },
  { key: "greyhaven.nature.rock.3", family: "rock", shape: "slab", rock: rock("slab", 4513, [3.4, 3.4, 2.3]) },
] as const;
export type ConvexHullProxy = { shape: "convex-hull"; vertices: [number, number, number][]; triangles: [number, number, number][] };
export const NATURE_TEXTURE_POLICY = {
  maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 },
  default: 1024,
} as const;
const POLICY = { allowedValidatorWarnings: ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] };

type Source = { id: string; source?: { path?: string }; archiveMember?: { archive: string; path: string } };
type GltfResources = { buffers?: { uri: string }[]; images?: { uri: string }[] };
function single(result: AssetOperationResult): AssetRef {
  const ref = result.outputs.output;
  if (!ref || Array.isArray(ref)) throw new Error("asset operation returned no single output");
  return ref;
}

export async function buildGreyhavenNature(outDir: string, log: (message: string) => void = () => {}) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const rawSources: Source[] = sources.sources;
  const member = async (basename: string) => {
    const matches = rawSources.filter((item) => item.archiveMember?.archive === ARCHIVE && path.posix.basename(item.archiveMember.path) === basename);
    if (matches.length !== 1) throw new Error(`nature resource '${basename}' must have exactly one catalog source`);
    return (await importAssetCatalogStorageSource({ catalog, storage, sourceId: matches[0]!.id, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
  };
  const io = new NodeIO();
  const boundsOf = async (asset: AssetRef) => {
    const scene = (await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)))).getRoot().getDefaultScene();
    if (!scene) throw new Error(`${asset.sha256} has no default scene`);
    return getBounds(scene);
  };
  /** One external.blender.script@1 recipe run with the given catalog sources as named inputs (plus an optional source GLB). */
  const runRecipe = async (key: string, script: string, workspace: string, output: string, args: unknown, catalogInputs: Record<string, string>, source?: AssetRef) => {
    log(`${key}: external.blender.script@1 ${script}`);
    const recipe = await readBlenderRecipeSource(script);
    const files: Record<string, Uint8Array> = { [script]: recipe.bytes };
    const inputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = { script: { path: script, sha256: recipe.sha256 } };
    if (source) {
      files["source.glb"] = new Uint8Array(await resolveAssetObject(root, source));
      inputs.source = { path: "source.glb", sha256: sha256Bytes(files["source.glb"]) };
    }
    const extra: Record<string, AssetRef> = {};
    for (const [name, sourceId] of Object.entries(catalogInputs)) {
      const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
      const bytes = new Uint8Array(await resolveAssetObject(root, asset));
      const file = `${name}${path.posix.extname(rawSources.find((item) => item.id === sourceId)?.source?.path ?? "")}`;
      files[file] = bytes;
      inputs[name] = { path: file, sha256: sha256Bytes(bytes) };
      extra[name] = asset;
    }
    const { glb, observations } = await runBlenderRecipe(root, {
      workspace: path.join(root, workspace), files,
      spec: blenderScriptSpec({ assetId: key, inputs, blenderVersion: recipe.blenderVersion, arguments: args, output }),
    });
    // Normal maps ship without tangents, so the same validator allowance applies.
    const asset = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
    return { asset, observations: observations as Record<string, unknown>, ...(Object.keys(extra).length ? { inputs: extra } : {}) };
  };
  const built = [];
  for (const entry of NATURE_MEMBERS) {
    log(`build, place and resize ${entry.key}`);
    let shaped: AssetRef;
    let provenance: Record<string, unknown>;
    let collisionProxy: ConvexHullProxy | undefined;
    if ("rock" in entry) {
      const authored = await runRecipe(entry.key, "nature_rock.py", `rock-${entry.shape}`, `${entry.shape}.glb`, entry.rock, ROCK_TEXTURES);
      shaped = authored.asset;
      const { collisionProxy: hull, ...observations } = authored.observations as { collisionProxy: ConvexHullProxy };
      collisionProxy = hull;
      provenance = { recipe: "adapters/blender/nature_rock.py", license: "CC0-1.0", authored: { ...authored, observations } };
    } else {
      const source = await member(`${entry.source}.gltf`);
      const gltf: GltfResources = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
      const uris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].map((resource) => resource.uri);
      const resources = await Promise.all(uris.map((uri) => member(path.posix.basename(decodeURIComponent(uri)))));
      const imported = single(await executeGltfProductionImportOperation(root, {
        inputs: { source, resources }, parameters: { resourceUris: uris, policy: { ...POLICY, repairs: ["gltf-color-clamp-v1"] } },
      }));
      // broadleaf_crown.py (#446) or conifer_crown.py (#450), in a workspace named after the shape.
      const crown = await runRecipe(entry.key, `${entry.shape}_crown.py`, `${entry.shape}-crown`, `${entry.shape}.glb`, entry.crown,
        "crownInputs" in entry ? entry.crownInputs : {}, imported);
      shaped = crown.asset;
      provenance = { archive: ARCHIVE, member: `glTF/${entry.source}.gltf`, license: "CC0-1.0", source, resources, imported, crown };
    }
    const placed = single(await executeGltfPlaceOperation(root, {
      inputs: { source: shaped }, parameters: { parentName: entry.key, anchor: "footprint-base-center", policy: POLICY },
    }));
    const asset = single(await executeGltfTextureResizeOperation(root, {
      inputs: { source: placed }, parameters: { ...NATURE_TEXTURE_POLICY, policy: POLICY },
    }));
    const bounds = await boundsOf(asset);
    if (collisionProxy) {
      // The recipe grounds and centres the rock already; follow any residual placement shift exactly.
      const before = await boundsOf(shaped);
      const shift = [0, 1, 2].map((axis) => bounds.min[axis]! - before.min[axis]!);
      collisionProxy.vertices = collisionProxy.vertices.map((v) => v.map((value, axis) => Number((value + shift[axis]!).toFixed(4))) as [number, number, number]);
    }
    built.push({ entry, asset, bounds, collisionProxy, provenance: { ...provenance, placed } });
  }
  const descriptor = {
    schema: NATURE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "footprint-base-center",
    placement: "The consumer owns world placement and colliders. These meshes are presentation only; each rock also "
      + `carries a convex-hull ${NATURE_COLLISION_PROXY} (vertices in its own glTF frame, triangles wound outward).`,
    texturePolicy: NATURE_TEXTURE_POLICY,
    assets: built.map(({ entry, bounds, collisionProxy, provenance }) => ({
      key: entry.key, variant: "default", family: entry.family, shape: entry.shape,
      bounds, footprint: { width: bounds.max[0] - bounds.min[0], height: bounds.max[1] - bounds.min[1], depth: bounds.max[2] - bounds.min[2] },
      ...(collisionProxy ? { [NATURE_COLLISION_PROXY]: collisionProxy } : {}),
      provenance,
    })),
  };
  const attachment = (await storeAssetObject(root, {
    bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "descriptor", mediaType: "application/json", metadata: { schema: NATURE_DESCRIPTOR_SCHEMA },
  })).asset;
  const bundleDir = path.join(root, "bundle");
  const exported = await exportAssetBundle(root, bundleDir, {
    parameters: {
      profile: GLTF_RESOURCES_BUNDLE_PROFILE,
      assets: built.map(({ entry }, index) => ({ key: entry.key, variant: "default", ...(index === 0 ? { attachments: [{ name: NATURE_DESCRIPTOR_ATTACHMENT }] } : {}) })),
    },
    inputs: { assets: built.map(({ asset }) => asset), attachments: [attachment] },
  });
  const tar = path.join(root, NATURE_TAR_NAME);
  const pack = Bun.spawnSync(["bun", path.join(ROOT, "scripts/pack-asset-bundle.ts"), bundleDir, tar], { stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`bundle packing failed: ${pack.stderr.toString()}`);
  const ref = readAssetBundleTar(await readFile(tar)).find((item) => item.path === ASSET_BUNDLE_REF_FILE);
  if (!ref) throw new Error("packed nature bundle has no export ref");
  await writeFile(path.join(root, ASSET_BUNDLE_REF_FILE), ref.bytes);
  await writeFile(path.join(root, "lineage.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  return { bundleDir, tar, descriptor, manifest: exported.manifest, exportRef: JSON.parse(ref.bytes.toString("utf8")) };
}

if (import.meta.main) {
  const [flag, out, ...extra] = process.argv.slice(2);
  if (flag !== "--out" || !out || extra.length) throw new Error("Usage: bun scripts/build-greyhaven-nature.ts --out <directory>");
  const built = await buildGreyhavenNature(out, console.error);
  console.log(JSON.stringify({ tar: built.tar, exportRef: built.exportRef }, null, 2));
}
