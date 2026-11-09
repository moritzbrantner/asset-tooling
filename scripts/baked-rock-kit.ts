// The build shared by the rock kits, one per geology (docs/limestone-rocks.md, docs/river-stones.md). Each piece is one
// external.blender.script@1 run of the kit's recipe, imported through scene.import.gltf@2; adapters/blender/nature_lod.py
// makes lod1 and lod2 from it in the same frame. A last recipe run packs the baked maps into one atlas, every level moves
// onto it, and the textures ship as KTX2. The kit's own script holds only its constants.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { tangents, unweld, weld } from "@gltf-transform/functions";
import { generateTangents } from "mikktspace";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec, type BlenderSpecInput } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOD_VARIANTS = ["lod1", "lod2"] as const;
const LOD_RATIOS = [0.35, 0.1] as const;
const LOD_REFERENCE_FOV_Y = 60;
/** The recipes export no tangents: the normal map uses the generated tangent space, as the crag outcrops do. */
const VALIDATOR_WARNINGS = ["MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];

export type BakedRockKit<Part extends string> = {
  release: string; tarName: string; keyPrefix: string; material: string; descriptorSchema: string; descriptorAttachment: string;
  /** In the order of the recipe's tables, which the atlas's numbered inputs follow. */
  parts: readonly Part[];
  /** The recipe, and the recipes it loads, by declared input name. */
  recipe: string; recipeInputs: Record<string, string>;
  /** Catalog sources by declared input name. */
  sources: Record<string, string>;
  /** Where LOD0 and lod1 end, in metres at the reference FOV, for every piece. */
  lodDistances: readonly [number, number];
  placement: string;
};

/**
 * Gives every primitive MikkTSpace tangents and a white COLOR_0. mmorpg's lit material needs tangents for normal maps, and
 * reads an absent COLOR_0 from WebGL's global default attribute values, which other draws overwrite: without one, a mesh
 * can render black, depending on what was drawn before it.
 */
async function withLightingAttributes(document: Document) {
  await document.transform(unweld(), tangents({ generateTangents, overwrite: true }), weld());
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute("POSITION")!;
    // Triangles the decimation made degenerate get no tangent: any unit vector across the normal is valid for them.
    const normal = primitive.getAttribute("NORMAL")!, tangent = primitive.getAttribute("TANGENT")!;
    for (let i = 0, n = [0, 0, 0], t = [0, 0, 0, 0]; i < tangent.getCount(); i += 1) {
      tangent.getElement(i, t);
      let length = Math.hypot(t[0]!, t[1]!, t[2]!);
      if (length < 1e-4) {
        normal.getElement(i, n);
        const axis = Math.abs(n[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        t = [n[1]! * axis[2]! - n[2]! * axis[1]!, n[2]! * axis[0]! - n[0]! * axis[2]!, n[0]! * axis[1]! - n[1]! * axis[0]!, 1];
        length = Math.hypot(t[0]!, t[1]!, t[2]!);
      }
      tangent.setElement(i, [t[0]! / length, t[1]! / length, t[2]! / length, t[3]! < 0 ? -1 : 1]);
    }
    primitive.setAttribute("COLOR_0", document.createAccessor().setType("VEC4").setArray(new Uint8Array(position.getCount() * 4).fill(255)).setNormalized(true).setBuffer(position.getBuffer()));
  }
}

const fileOf = (repoPath: string) => path.posix.basename(repoPath);
export const bakedRockKey = (kit: BakedRockKit<string>, part: string) => `${kit.keyPrefix}.${part}`;
export const bakedRockKind = (part: string) => part.split("-")[0]!;

/** The spec of one piece's recipe run. `recipeSha256` has the `script` and each `recipeInputs` name. */
export function createBakedRockSpec<Part extends string>(kit: BakedRockKit<Part>, { part, recipeSha256, inputSha256, blenderVersion }: {
  part: Part; recipeSha256: Record<string, string>; inputSha256: Record<string, string>; blenderVersion: string;
}) {
  const inputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = { script: { path: fileOf(kit.recipe), sha256: recipeSha256.script! } };
  for (const [name, recipe] of Object.entries(kit.recipeInputs)) inputs[name] = { path: fileOf(recipe), sha256: recipeSha256[name]! };
  for (const name of Object.keys(kit.sources)) inputs[name] = { path: `${name}.jpg`, sha256: inputSha256[name]! };
  return blenderScriptSpec({ assetId: bakedRockKey(kit, part), inputs, blenderVersion, arguments: { schemaVersion: 1, part }, output: "rock.glb" });
}

export async function buildBakedRockKit<Part extends string>(kit: BakedRockKit<Part>, { outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource(fileOf(kit.recipe));
  const lodSource = await readBlenderRecipeSource("nature_lod.py");
  const recipeFiles: Record<string, Uint8Array> = { [fileOf(kit.recipe)]: source.bytes };
  const recipeSha256: Record<string, string> = { script: source.sha256 };
  const recipeLineage: Record<string, { script: string; sha256: string }> = {};
  for (const [name, recipe] of Object.entries(kit.recipeInputs)) {
    const loaded = await readBlenderRecipeSource(fileOf(recipe));
    recipeFiles[fileOf(recipe)] = loaded.bytes;
    recipeSha256[name] = loaded.sha256;
    recipeLineage[name] = { script: recipe, sha256: loaded.sha256 };
  }
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const files: Record<string, Uint8Array> = { ...recipeFiles };
  const inputSha256: Record<string, string> = {};
  const inputAssets: Record<string, AssetRef> = {};
  for (const [name, sourceId] of Object.entries(kit.sources)) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    const bytes = new Uint8Array(await resolveAssetObject(root, asset));
    files[`${name}.jpg`] = bytes;
    inputSha256[name] = sha256Bytes(bytes);
    inputAssets[name] = asset;
  }

  const pieces: (KitPart & { part: Part; variant: string })[] = [];
  for (const part of kit.parts) {
    log(`generate ${part}`);
    const main = await buildKitPart(root, {
      workspace: path.join(root, "pieces", `${part}.default`), files, allowedValidatorWarnings: VALIDATOR_WARNINGS,
      spec: createBakedRockSpec(kit, { part, recipeSha256, inputSha256, blenderVersion: source.blenderVersion }),
    });
    pieces.push({ ...main, part, variant: "default" });
    const sourceBytes = new Uint8Array(await resolveAssetObject(root, main.asset));
    for (const [index, variant] of LOD_VARIANTS.entries()) {
      const level = await buildKitPart(root, {
        workspace: path.join(root, "pieces", `${part}.${variant}`), files: { "nature_lod.py": lodSource.bytes, "source.glb": sourceBytes }, allowedValidatorWarnings: VALIDATOR_WARNINGS,
        spec: blenderScriptSpec({
          assetId: bakedRockKey(kit, part), inputs: { script: { path: "nature_lod.py", sha256: lodSource.sha256 }, source: { path: "source.glb", sha256: sha256Bytes(sourceBytes) } },
          blenderVersion: lodSource.blenderVersion, arguments: { schemaVersion: 1, method: "decimate", ratio: LOD_RATIOS[index]! }, output: `${variant}.glb`,
        }),
      });
      pieces.push({ ...level, part, variant });
    }
  }

  log("pack the baked maps into one atlas");
  const atlasFiles: Record<string, Uint8Array> = { ...recipeFiles };
  const atlasInputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = { script: { path: fileOf(kit.recipe), sha256: source.sha256 } };
  for (const [name, recipe] of Object.entries(kit.recipeInputs)) atlasInputs[name] = { path: fileOf(recipe), sha256: recipeSha256[name]! };
  kit.parts.forEach((part, index) => {
    const material = pieces.find((piece) => piece.part === part && piece.variant === "default")!.document.getRoot().listMaterials()[0]!;
    for (const [kind, texture] of [["colour", material.getBaseColorTexture()], ["normal", material.getNormalTexture()], ["rough", material.getMetallicRoughnessTexture()]] as const) {
      const bytes = texture!.getImage()!;
      atlasFiles[`${kind}${index}.png`] = bytes;
      atlasInputs[`${kind}${index}`] = { path: `${kind}${index}.png`, sha256: sha256Bytes(bytes) };
    }
  });
  const atlas = await buildKitPart(root, {
    workspace: path.join(root, "pieces", "atlas"), files: atlasFiles, allowedValidatorWarnings: VALIDATOR_WARNINGS,
    spec: blenderScriptSpec({ assetId: `${kit.keyPrefix}.atlas`, inputs: atlasInputs, blenderVersion: source.blenderVersion, arguments: { schemaVersion: 1, part: "atlas" }, output: "atlas.glb" }),
  });
  const atlasMaterial = atlas.document.getRoot().listMaterials()[0]!;
  const { edge: atlasEdge, rects } = atlas.observations as { edge: number; rects: Record<string, { x: number; y: number; edge: number }> };
  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const atlased: AssetRef[] = [];
  for (const piece of pieces) {
    // Every level moves onto its piece's rectangle of the shared maps and takes the one material name.
    const rect = rects[piece.part]!;
    const point = [0, 0];
    for (const mesh of piece.document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const uv = primitive.getAttribute("TEXCOORD_0")!;
      for (let i = 0; i < uv.getCount(); i += 1) {
        uv.getElement(i, point);
        uv.setElement(i, [(rect.x + point[0]! * rect.edge) / atlasEdge, (rect.y + point[1]! * rect.edge) / atlasEdge]);
      }
    }
    for (const material of piece.document.getRoot().listMaterials()) {
      material.setName(kit.material);
      material.getBaseColorTexture()!.setImage(atlasMaterial.getBaseColorTexture()!.getImage()!);
      material.getNormalTexture()!.setImage(atlasMaterial.getNormalTexture()!.getImage()!);
      material.getMetallicRoughnessTexture()!.setImage(atlasMaterial.getMetallicRoughnessTexture()!.getImage()!);
    }
    await withLightingAttributes(piece.document);
    atlased.push((await storeAssetObject(root, { bytes: await io.writeBinary(piece.document), kind: "scene", mediaType: "model/gltf-binary" })).asset);
  }

  log("measure the descriptor");
  const tan = Math.tan((LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = kit.parts.map((part) => {
    const levels = pieces.filter((piece) => piece.part === part);
    const bounds = documentBounds(levels[0]!.document);
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    const { fit, bury, collisionMesh } = levels[0]!.observations;
    return {
      key: bakedRockKey(kit, part), role: part, kind: bakedRockKind(part), triangles: triangles(levels[0]!.document), bounds, fit, bury,
      footprint: { width: round(bounds.max[0] - bounds.min[0]), depth: round(bounds.max[2] - bounds.min[2]), height: round(bounds.max[1]) },
      ...(collisionMesh ? { collisionMesh } : { collision: "none" }),
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: levels.map((level, index) => {
          const distance = kit.lodDistances[index];
          return { variant: level.variant, triangles: triangles(level.document), minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: kit.descriptorSchema, units: "metre", up: "+Y", handedness: "right", origin: "footprint-base-center", placement: kit.placement,
    lodSelection: {
      metric: "projected-bounding-sphere-height-fraction", referenceFovYDegrees: LOD_REFERENCE_FOV_Y,
      rule: "Use the first level whose minScreenSize is at most the asset's projected bounding-sphere diameter divided by the viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: kit.descriptorAttachment, mediaType: "application/json" })).asset;

  log("encode every texture as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, kit.release, atlased);
  const selections = pieces.map((piece, index) => ({ key: bakedRockKey(kit, piece.part), variant: piece.variant, ...(index === 0 ? { attachments: [{ name: kit.descriptorAttachment }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: kit.tarName, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(pieces.filter((piece) => piece.variant === "default").map((piece) => [piece.part, piece.document])) as Record<Part, Document>,
    lineage: {
      recipe: { script: kit.recipe, sha256: source.sha256, ...recipeLineage, lod: { script: "adapters/blender/nature_lod.py", sha256: lodSource.sha256 }, blenderVersion: source.blenderVersion },
      release: kit.release, descriptor: descriptorAsset,
      sources: Object.fromEntries(Object.entries(kit.sources).map(([name, sourceId]) => [name, { sourceId, license: "CC0-1.0", asset: inputAssets[name] }])),
    },
  };
}

export function runBakedRockKitCli<Part extends string>(script: string, kit: BakedRockKit<Part>) {
  return runKitCli(script, kit.release, (options) => buildBakedRockKit(kit, options), { descriptorFile: true });
}
