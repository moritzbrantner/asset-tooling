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
export const NATURE_MEMBERS = [
  { key: "greyhaven.nature.tree.broadleaf", family: "tree", shape: "broadleaf", source: "CommonTree_1", crown: BROADLEAF_CROWN },
  { key: "greyhaven.nature.tree.conifer", family: "tree", shape: "conifer", source: "Pine_1", crown: CONIFER_CROWN, crownInputs: CONIFER_NEEDLES },
  { key: "greyhaven.nature.rock.1", family: "rock", shape: "medium-1", source: "Rock_Medium_1" },
  { key: "greyhaven.nature.rock.2", family: "rock", shape: "medium-2", source: "Rock_Medium_2" },
  { key: "greyhaven.nature.rock.3", family: "rock", shape: "medium-3", source: "Rock_Medium_3" },
] as const;
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
  const built = [];
  for (const entry of NATURE_MEMBERS) {
    log(`import, place and resize ${entry.key}`);
    const source = await member(`${entry.source}.gltf`);
    const gltf: GltfResources = JSON.parse((await resolveAssetObject(root, source)).toString("utf8"));
    const uris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].map((resource) => resource.uri);
    const resources = await Promise.all(uris.map((uri) => member(path.posix.basename(decodeURIComponent(uri)))));
    const imported = single(await executeGltfProductionImportOperation(root, {
      inputs: { source, resources }, parameters: { resourceUris: uris, policy: { ...POLICY, repairs: ["gltf-color-clamp-v1"] } },
    }));
    let shaped = imported;
    let crown: { asset: AssetRef; observations: Record<string, unknown>; inputs?: Record<string, AssetRef> } | undefined;
    if ("crown" in entry) {
      // broadleaf_crown.py (#446) or conifer_crown.py (#450), in a workspace named after the shape.
      const script = `${entry.shape}_crown.py`;
      log(`rebuild the ${entry.key} crown (external.blender.script@1 ${script})`);
      const recipe = await readBlenderRecipeSource(script);
      const source = new Uint8Array(await resolveAssetObject(root, imported));
      const files: Record<string, Uint8Array> = { [script]: recipe.bytes, "source.glb": source };
      const inputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = {
        script: { path: script, sha256: recipe.sha256 }, source: { path: "source.glb", sha256: sha256Bytes(source) },
      };
      const extra: Record<string, AssetRef> = {};
      for (const [name, sourceId] of Object.entries("crownInputs" in entry ? entry.crownInputs : {})) {
        const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
        const bytes = new Uint8Array(await resolveAssetObject(root, asset));
        const file = `${name}${path.posix.extname(rawSources.find((item) => item.id === sourceId)?.source?.path ?? "")}`;
        files[file] = bytes;
        inputs[name] = { path: file, sha256: sha256Bytes(bytes) };
        extra[name] = asset;
      }
      const { glb, observations } = await runBlenderRecipe(root, {
        workspace: path.join(root, `${entry.shape}-crown`),
        files,
        spec: blenderScriptSpec({
          assetId: entry.key, inputs, blenderVersion: recipe.blenderVersion, arguments: entry.crown, output: `${entry.shape}.glb`,
        }),
      });
      // The bark keeps the source's normal map without tangents, so the same validator allowance applies.
      shaped = single(await executeGltfProductionImportOperation(root, { inputs: { source: glb }, parameters: { policy: POLICY } }));
      crown = { asset: shaped, observations: observations as Record<string, unknown>, ...(Object.keys(extra).length ? { inputs: extra } : {}) };
    }
    const placed = single(await executeGltfPlaceOperation(root, {
      inputs: { source: shaped }, parameters: { parentName: entry.key, anchor: "footprint-base-center", policy: POLICY },
    }));
    const asset = single(await executeGltfTextureResizeOperation(root, {
      inputs: { source: placed }, parameters: { ...NATURE_TEXTURE_POLICY, policy: POLICY },
    }));
    const document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, asset)));
    const scene = document.getRoot().getDefaultScene();
    if (!scene) throw new Error(`${entry.key} has no default scene`);
    const bounds = getBounds(scene);
    built.push({ entry, asset, bounds, provenance: { source, resources, imported, ...(crown ? { crown } : {}), placed } });
  }
  const descriptor = {
    schema: NATURE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "footprint-base-center",
    placement: "The consumer owns world placement and colliders. These meshes are presentation only.",
    texturePolicy: NATURE_TEXTURE_POLICY,
    assets: built.map(({ entry, bounds, provenance }) => ({
      key: entry.key, variant: "default", family: entry.family, shape: entry.shape,
      bounds, footprint: { width: bounds.max[0] - bounds.min[0], height: bounds.max[1] - bounds.min[1], depth: bounds.max[2] - bounds.min[2] },
      provenance: { archive: ARCHIVE, member: `glTF/${entry.source}.gltf`, license: "CC0-1.0", ...provenance },
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
