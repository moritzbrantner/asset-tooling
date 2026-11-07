// Build the crag kit (#480, docs/crag-kit.md) from the scripted Blender recipe adapters/blender/crag.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-crag-kit.ts --out <directory>
// Rock-face slabs, edge corners, top caps and a macro-variation texture that dress Greyhaven's box-shaped crags and
// cliffs (mmorpg highlands::CRAGS, the Redbrand Hollow), sheer and climbable. Each part and level of detail is one
// external.blender.script@1 run, imported through scene.import.gltf@2; scene.textures.resize.gltf@1 brings the CC0
// Poly Haven rock_face_03 maps to the greyhaven-terrain sizes and every texture ships as KTX2 encoded exactly as the
// terrain's (encodeKtx2, TERRAIN_KTX2). Every module shares the same three textures, so the bundle stores them once.
// The crag-kit-descriptor-v1 attachment carries each module's climbing surface, box collision proxies and LOD chain
// (the greyhaven-nature #449 format), the layout rule and the macro texture's use.
// <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/crag.kit.tar.
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document, type Texture } from "@gltf-transform/core";
import { KHRTextureBasisu } from "@gltf-transform/extensions";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec, type BlenderSpecInput } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { executeGltfTextureResizeOperation } from "../src/gltf-texture-resize-operations.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, round, runKitCli, single, triangles, type KitPart } from "../src/kit-bundle.js";
import type { AssetRef } from "../src/operations.js";
import { TERRAIN_KTX2, TERRAIN_TEXTURE_POLICY, encodeKtx2 } from "./build-greyhaven-terrain.ts";
import type { TextureEncoding } from "./pack-downloads.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const CRAG_RELEASE = "crag-kit";
export const CRAG_TAR_NAME = "crag.kit.tar";
export const CRAG_KEY_PREFIX = "crag.kit";
export const CRAG_DESCRIPTOR_SCHEMA = "crag-kit-descriptor-v1";
export const CRAG_DESCRIPTOR_ATTACHMENT = "crag-descriptor";
export const CRAG_FACES = { sheer: ["face-sheer-1", "face-sheer-2", "face-sheer-3"], climb: ["face-climb-1", "face-climb-2", "face-climb-3"] } as const;
export const CRAG_CORNERS = { sheer: ["corner-sheer-1", "corner-sheer-2"], climb: ["corner-climb-1", "corner-climb-2"] } as const;
export const CRAG_CAPS = ["cap-1", "cap-2"] as const;
export const CRAG_MODULES = [...CRAG_FACES.sheer, ...CRAG_FACES.climb, ...CRAG_CORNERS.sheer, ...CRAG_CORNERS.climb, ...CRAG_CAPS, "cap-corner"] as const;
export const CRAG_MACRO = "rock-macro";
export const CRAG_PARTS = [...CRAG_MODULES, CRAG_MACRO] as const;
export type CragModule = (typeof CRAG_MODULES)[number];
export type CragPart = (typeof CRAG_PARTS)[number];
export type CragFamily = "sheer" | "climb";
export const cragKey = (part: CragPart) => `${CRAG_KEY_PREFIX}.${part}`;
/** The cell every face, corner and cap module covers, in metres. */
export const CRAG_PITCH = 3;
/** The CC0 Poly Haven scans: rock_face_03 (Greyhaven's terrain rock layer) and the two scans that tint it. */
export const CRAG_SOURCES = {
  diff: "poly-haven.rock-face-03-diff-2k-jpg",
  normal: "poly-haven.rock-face-03-nor-gl-2k-jpg",
  arm: "poly-haven.rock-face-03-arm-2k-jpg",
  boulder: "poly-haven.rock-boulder-dry-diff-2k-jpg",
  moss: "poly-haven.mossy-rock-diff-2k-jpg",
} as const;
const INPUT_FILES = { diff: "diff.jpg", normal: "normal.jpg", arm: "arm.jpg", boulder: "boulder.jpg", moss: "moss.jpg" } as const;
/** The macro texture covers this many world metres per repeat. */
export const CRAG_MACRO_METRES = 32;

/** Levels of detail: LOD0 is variant `default`; `lod1` and `lod2` come from the same recipe in the same frame. */
export const CRAG_LOD_VARIANTS = ["lod1", "lod2"] as const;
export const CRAG_LOD_METRIC = "projected-bounding-sphere-height-fraction";
export const CRAG_LOD_REFERENCE_FOV_Y = 60;
/** Where LOD0 and lod1 end, in metres at the reference FOV, for every module. */
export const CRAG_LOD_DISTANCES = [40, 120] as const;

export function createCragAssetSpec({ part, lod, scriptSha256, commonSha256, inputSha256, blenderVersion }: {
  part: CragPart; lod: 0 | 1 | 2; scriptSha256: string; commonSha256: string; inputSha256: Record<keyof typeof CRAG_SOURCES, string>; blenderVersion: string;
}) {
  const inputs: Record<string, BlenderSpecInput> = { common: { path: "kit_common.py", sha256: commonSha256 } };
  for (const name of Object.keys(CRAG_SOURCES) as (keyof typeof CRAG_SOURCES)[]) inputs[name] = { path: INPUT_FILES[name], sha256: inputSha256[name] };
  return blenderScriptSpec({
    assetId: cragKey(part), inputs: { script: { path: "crag.py", sha256: scriptSha256 }, ...inputs },
    blenderVersion, arguments: { schemaVersion: 1, part, lod }, output: "crag.glb",
  });
}

export type CragPlacement = { key: string; variant: "default"; translation: [number, number, number]; rotationY: number; scale: [number, number, number] };

const hash32 = (...keys: (string | number)[]) => Number.parseInt(sha256Bytes(new TextEncoder().encode(keys.join("/"))).slice(0, 8), 16);

/**
 * The layout rule (docs/crag-kit.md#layout): the module placements that dress an axis-aligned box `width` (x) by
 * `depth` (z) by `height` (y) whose base centre is the origin. Each vertical face of length L is split into
 * n = max(1, round(L / 3)) columns and m = max(1, round(H / 3)) rows of cells, each face module scaled by
 * (L / 3n, H / 3m, 1); no cell takes the variant of its left or lower neighbour, and every other cell is mirrored
 * (x scale negative). A corner column (m stacked corners, scaled H / 3m in y) stands on each vertical edge, a cap on
 * every top cell (scaled L / 3n in x) and a cap-corner on each top corner. `seed` names the crag, so two crags differ.
 * Rotation is about +Y in radians; a module's +Z (or, for corners, its +X+Z bisector) faces out of the box.
 */
export function cragLayout({ width, depth, height, family, seed }: { width: number; depth: number; height: number; family: CragFamily; seed: string }): CragPlacement[] {
  const out: CragPlacement[] = [];
  const faces = [
    { centre: [0, depth / 2], rotation: 0, length: width },
    { centre: [width / 2, 0], rotation: Math.PI / 2, length: depth },
    { centre: [0, -depth / 2], rotation: Math.PI, length: width },
    { centre: [-width / 2, 0], rotation: -Math.PI / 2, length: depth },
  ];
  const rows = Math.max(1, Math.round(height / CRAG_PITCH));
  const sy = round(height / (CRAG_PITCH * rows));
  // A point (along, up, out) in a face's frame, in the box's frame.
  const at = (face: (typeof faces)[number], along: number, up: number, out: number): [number, number, number] => {
    const c = Math.cos(face.rotation), s = Math.sin(face.rotation);
    return [round(face.centre[0]! + along * c + out * s), round(up), round(face.centre[1]! - along * s + out * c)];
  };
  const variants = CRAG_FACES[family];
  faces.forEach((face, f) => {
    const columns = Math.max(1, Math.round(face.length / CRAG_PITCH));
    const sx = round(face.length / (CRAG_PITCH * columns));
    const below: string[] = [];
    for (let j = 0; j < rows; j += 1) {
      let left = "";
      for (let i = 0; i < columns; i += 1) {
        const options = variants.filter((v) => v !== left && v !== below[i]);
        const pick = options[hash32(seed, f, i, j) % options.length]!;
        left = pick; below[i] = pick;
        const mirror = hash32(seed, "mirror", f, i, j) % 2 === 1 ? -1 : 1;
        out.push({ key: cragKey(pick), variant: "default", translation: at(face, -face.length / 2 + CRAG_PITCH * sx * (i + 0.5), CRAG_PITCH * sy * j, 0),
          rotationY: round(face.rotation), scale: [round(mirror * sx), sy, 1] });
      }
      // The corner on this face's right-hand end (looking at the face from outside).
      const corner = CRAG_CORNERS[family][hash32(seed, "corner", f, j) % 2]!;
      out.push({ key: cragKey(corner), variant: "default", translation: at(face, face.length / 2, CRAG_PITCH * sy * j, 0), rotationY: round(face.rotation), scale: [1, sy, 1] });
    }
    for (let i = 0; i < columns; i += 1) {
      const cap = CRAG_CAPS[hash32(seed, "cap", f, i) % CRAG_CAPS.length]!;
      out.push({ key: cragKey(cap), variant: "default", translation: at(face, -face.length / 2 + CRAG_PITCH * sx * (i + 0.5), height, 0), rotationY: round(face.rotation), scale: [sx, 1, 1] });
    }
    out.push({ key: cragKey("cap-corner"), variant: "default", translation: at(face, face.length / 2, height, 0), rotationY: round(face.rotation), scale: [1, 1, 1] });
  });
  return out;
}

type Built = KitPart & { part: CragPart; variant: string };

/** Each distinct texture of the document's materials with its KTX2 encoding, in material and slot order. */
function textureSlots(document: Document): [Texture, TextureEncoding][] {
  const out: [Texture, TextureEncoding][] = [];
  for (const material of document.getRoot().listMaterials()) {
    for (const [texture, encoding] of [
      [material.getBaseColorTexture(), TERRAIN_KTX2.baseColor], [material.getNormalTexture(), TERRAIN_KTX2.normal],
      [material.getMetallicRoughnessTexture() ?? material.getOcclusionTexture(), TERRAIN_KTX2.metallicRoughness],
    ] as const) if (texture && !out.some(([seen]) => seen === texture)) out.push([texture, encoding]);
  }
  return out;
}

export async function buildCragKit({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("crag.py");
  const common = await readBlenderRecipeSource("kit_common.py");
  const sources = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
  const providers = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
  const storage = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const files: Record<string, Uint8Array> = { "crag.py": source.bytes, "kit_common.py": common.bytes };
  const inputSha256 = {} as Record<keyof typeof CRAG_SOURCES, string>;
  const inputAssets = {} as Record<keyof typeof CRAG_SOURCES, AssetRef>;
  for (const name of Object.keys(CRAG_SOURCES) as (keyof typeof CRAG_SOURCES)[]) {
    const asset = (await importAssetCatalogStorageSource({ catalog, storage, sourceId: CRAG_SOURCES[name], storageRoot: ROOT, objectStoreRoot: root })).asset as AssetRef;
    const bytes = new Uint8Array(await resolveAssetObject(root, asset));
    files[INPUT_FILES[name]] = bytes;
    inputSha256[name] = sha256Bytes(bytes);
    inputAssets[name] = asset;
  }

  const io = new NodeIO().registerExtensions([KHRTextureBasisu]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "crag-kit-"));
  // One KTX2 encoding per distinct PNG and encoding: every module shares the rock textures.
  const encoded = new Map<string, Uint8Array>();
  const built: Built[] = [];
  try {
    for (const part of CRAG_PARTS) {
      const levels = part === CRAG_MACRO ? [[0, "default"]] as const : [[0, "default"], [1, "lod1"], [2, "lod2"]] as const;
      for (const [lod, variant] of levels) {
        log(`generate ${part} ${variant} (external.blender.script@1 crag recipe, scene.import.gltf@2)`);
        const kit = await buildKitPart(root, {
          workspace: path.join(root, "crag", `${part}.${variant}`), files,
          spec: createCragAssetSpec({ part, lod, scriptSha256: source.sha256, commonSha256: common.sha256, inputSha256, blenderVersion: source.blenderVersion }),
        });
        // The terrain's texture sizes (scene.textures.resize.gltf@1), then KTX2 exactly as the terrain encodes them.
        // Every module embeds the same scan bytes, so a texture is resized and encoded the first time its source
        // bytes appear and later modules take the same KTX2 bytes.
        const sourceKeys = textureSlots(kit.document).map(([texture, encoding]) => `${sha256Bytes(texture.getImage()!)}:${encoding}`);
        let document = kit.document;
        if (sourceKeys.some((id) => !encoded.has(id))) {
          const resized = single(await executeGltfTextureResizeOperation(root, { inputs: { source: kit.asset }, parameters: { ...TERRAIN_TEXTURE_POLICY, policy: { allowedValidatorWarnings: [] } } }));
          document = await io.readBinary(new Uint8Array(await resolveAssetObject(root, resized)));
          const slots = textureSlots(document);
          if (slots.length !== sourceKeys.length) throw new Error(`${part} ${variant}: texture resize changed the material's slots`);
          for (const [index, [texture, encoding]] of slots.entries()) {
            if (encoded.has(sourceKeys[index]!)) continue;
            await encodeKtx2(scratch, texture, encoding);
            encoded.set(sourceKeys[index]!, texture.getImage()!);
          }
        }
        for (const [index, [texture]] of textureSlots(document).entries()) texture.setImage(encoded.get(sourceKeys[index]!)!).setMimeType("image/ktx2");
        for (const material of document.getRoot().listMaterials()) {
          const occlusion = material.getOcclusionTexture();
          if (occlusion && occlusion !== material.getMetallicRoughnessTexture()) throw new Error(`${part} ${variant}: occlusion is not the metallic-roughness texture`);
        }
        document.createExtension(KHRTextureBasisu).setRequired(true);
        const asset = (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: "scene", mediaType: "model/gltf-binary" })).asset;
        built.push({ part, variant, asset, document, observations: kit.observations });
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  log("measure the crag-kit descriptor");
  const tan = Math.tan((CRAG_LOD_REFERENCE_FOV_Y / 2) * Math.PI / 180);
  const assets = CRAG_PARTS.map((part) => {
    const [main, ...lods] = built.filter((b) => b.part === part);
    const bounds = documentBounds(main!.document);
    const o = main!.observations;
    const entry: Record<string, unknown> = { key: cragKey(part), role: part, family: o.family, kind: o.kind, triangles: triangles(main!.document), cell: o.cell, bounds };
    if (part === CRAG_MACRO) return { ...entry, macro: o.macro };
    const radius = round(Math.hypot(...[0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!)) / 2);
    return {
      ...entry, collisionProxies: o.collisionProxies, climb: o.climb,
      lods: {
        boundingSphere: { center: [0, 1, 2].map((k) => round((bounds.min[k]! + bounds.max[k]!) / 2)), radius },
        levels: [main!, ...lods].map((level, index) => {
          const distance = CRAG_LOD_DISTANCES[index];
          return { variant: level.variant, triangles: triangles(level.document),
            minScreenSize: distance ? round(Number((radius / (distance * tan)).toFixed(4))) : 0, referenceMaxDistance: distance ?? null };
        }),
      },
    };
  });
  const descriptor = {
    schema: CRAG_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", pitch: CRAG_PITCH,
    frames: {
      face: "The cell's back (z = 0) lies on the box face, its origin at the bottom centre of the 3 x 3 m cell; the relief stands proud towards +Z. The slab overhangs its cell by climb.tile.overlap on every side and sinks into the face along its ragged border.",
      corner: "The vertical box edge runs along +Y through the origin; the box fills x < 0, z < 0. The arms lie along the faces z = 0 and x = 0.",
      cap: "The top edge runs along +X through the origin; the box fills y < 0, z < 0. The cap curls down the face (z = 0) and back over the top (y = 0).",
      "cap-corner": "The top corner of the box is the origin; the box fills x < 0, y < 0, z < 0.",
      macro: "A 1 m quad on the XZ plane facing +Y, u along +X, v along +Z, as the greyhaven-terrain layers.",
    },
    layout: {
      rule: "For an axis-aligned box W (x) by D (z) by H (y): split each vertical face of length L into n = max(1, round(L / 3)) columns "
        + "and m = max(1, round(H / 3)) rows; place a face module of the crag's family (sheer or climb) on every cell, scaled "
        + "(L / 3n, H / 3m, 1), never the variant of its left or lower neighbour, mirrored (x scale -1) on about half the cells; "
        + "stack m corners of the same family on every vertical edge, scaled H / 3m in y; put a cap on every top cell, scaled "
        + "L / 3n in x, and a cap-corner on every top corner. The slabs overlap their neighbours by design: their borders sink "
        + "into the box, so the overlaps read as the joints of the rock. scripts/build-crag-kit.ts cragLayout() is the reference.",
      scaleRange: { min: 0.75, max: 1.25, note: "L / 3n and H / 3m for 6-16 m boxes" },
      families: { sheer: { faces: [...CRAG_FACES.sheer], corners: [...CRAG_CORNERS.sheer] }, climb: { faces: [...CRAG_FACES.climb], corners: [...CRAG_CORNERS.climb] }, caps: [...CRAG_CAPS, "cap-corner"] },
    },
    climbing: "climb follows the climbing kit (climbing-kit-descriptor-v1): grip is \"rock\" on climbable faces and corners and null on sheer ones "
      + "and on caps; approach is the side the climber faces the rock from; standOff is the Climb_* clips' distance from the grip "
      + "plane to the pelvis; face (or faces) is that plane: its normal and offset (the mean relief over the cell); relief gives how "
      + "far the rock stands proud of the box face (min, mean, max over the cell). Gameplay owns the collision: the modules are "
      + "presentation over the box collider, and collisionProxies are boxes for consumers without one.",
    textures: {
      material: "One material, crag-rock, on every module: base colour, normal and occlusion/roughness/metal maps of the CC0 Poly Haven rock_face_03 (Greyhaven's terrain rock layer), one repeat per 3 m, offset and mirrored per module; COLOR_0 multiplies the base colour (cavities, moss, streaks, drift).",
      ktx2: TERRAIN_KTX2, texturePolicy: TERRAIN_TEXTURE_POLICY,
    },
    macro: {
      key: cragKey(CRAG_MACRO), worldMetres: CRAG_MACRO_METRES,
      rule: "Sample the macro texture's base colour (sRGB-decoded, so linear) at world position / worldMetres (xz for the terrain, "
        + "the face-plane axes or triplanar for the crag modules) and multiply the linear base colour by 2 x its RGB: 0.5 leaves "
        + "the colour unchanged. It tiles, and breaks the 2.7-3 m repeat of the rock texture on the crags and on the terrain's rock layer alike.",
    },
    lodSelection: {
      metric: CRAG_LOD_METRIC,
      rule: "Use the first level whose minScreenSize is at most the part's projected bounding-sphere diameter divided by the "
        + "viewport height (radius / (distance * tan(fovY / 2)), scaled by the instance scale). referenceMaxDistance is the "
        + "distance in metres at which that level ends for an unscaled instance at referenceFovYDegrees.",
      referenceFovYDegrees: CRAG_LOD_REFERENCE_FOV_Y,
    },
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: "crag-descriptor", mediaType: "application/json" })).asset;
  const selections = built.map((b) => ({
    key: cragKey(b.part), variant: b.variant,
    ...(b.part === CRAG_PARTS[0] && b.variant === "default" ? { attachments: [{ name: CRAG_DESCRIPTOR_ATTACHMENT }] } : {}),
  }));
  const packed = await exportKitBundle(root, {
    tarName: CRAG_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: built.map((b) => b.asset), attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((b) => [`${b.part}.${b.variant}`, b.document])) as Record<string, Document>,
    lineage: {
      recipe: { script: "adapters/blender/crag.py", sha256: source.sha256, common: { script: "adapters/blender/kit_common.py", sha256: common.sha256 }, blenderVersion: source.blenderVersion },
      release: CRAG_RELEASE,
      sources: Object.fromEntries((Object.keys(CRAG_SOURCES) as (keyof typeof CRAG_SOURCES)[]).map((name) => [name, { sourceId: CRAG_SOURCES[name], license: "CC0-1.0", asset: inputAssets[name] }])),
      parts: Object.fromEntries(built.map((b) => [`${b.part}.${b.variant}`, b.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-crag-kit.ts", "crag", buildCragKit, { descriptorFile: true });
