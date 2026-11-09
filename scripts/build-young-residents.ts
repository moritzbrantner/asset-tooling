// Build the young residents kit (docs/young-residents.md, #556) from the recipe adapters/blender/young_residents.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-young-residents.ts [--textures full|half] --out <directory>
// Each figure is one external.blender.script@1 run on the catalogued Quaternius Peasant outfit, heads and hair, always
// dressed. <directory> becomes the object-store root; the bundle is exported to <directory>/bundle and packed to
// <directory>/young-residents.kit.tar. No game places the kit yet.
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec, type BlenderSpecInput } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { createAssetCatalog } from "../src/catalog.js";
import { importAssetCatalogStorageSource } from "../src/catalog-storage.js";
import { sha256Bytes } from "../src/hash.js";
import { buildKitPart, documentBounds, exportKitBundle, ktx2Assets, round, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";

type Json = Record<string, any>;
type Rgb = readonly [number, number, number];

export const YOUNG_FIGURES = ["teen-boy", "teen-girl", "child-boy", "child-girl"] as const;
export type YoungFigure = (typeof YOUNG_FIGURES)[number];
export const YOUNG_KEY_PREFIX = "young-residents.kit";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const YOUNG_RELEASE = "young-residents";
export const YOUNG_TAR_NAME = "young-residents.kit.tar";
export const YOUNG_DESCRIPTOR_SCHEMA = "young-residents-descriptor-v1";
export const YOUNG_DESCRIPTOR_ATTACHMENT = "young-residents-descriptor";
/** The adults' 65-joint rig (Quaternius Universal Base Characters), and the only source of every joint rotation. */
export const YOUNG_JOINT_COUNT = 65;
/** Full-detail triangle ceiling, just above the largest figure. */
export const YOUNG_TRIANGLE_BUDGET = 21_000;
const ALLOWED_WARNINGS = ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"];
const ARCHIVES = ["quaternius.universal-base-characters-standard", "quaternius.modular-character-outfits-fantasy-standard"];

export const youngKey = (figure: YoungFigure) => `${YOUNG_KEY_PREFIX}.${figure}`;

/** Slider groups in display order: the morph target, its label. Weights run -1..1, and 0 is the unchanged source head. */
export const YOUNG_SLIDER_GROUPS = [
  { id: "face", label: "Face", sliders: [["low_face", "Short lower face"], ["face_w", "Face width"], ["jaw_w", "Jaw width"], ["chin_w", "Chin width"], ["chin_len", "Chin length"], ["cheek", "Full cheeks"], ["cheekbone", "Cheekbones"]] },
  { id: "eyes", label: "Eyes", sliders: [["eye_size", "Size"], ["eye_space", "Spacing"], ["eye_tilt", "Outer corners up"], ["eye_open", "Opening"], ["lid_full", "Upper lid fullness"]] },
  { id: "nose", label: "Nose", sliders: [["nose_size", "Overall size"], ["nose_bridge", "Bridge height"], ["nose_w", "Width"], ["nose_len", "Length"]] },
  { id: "mouth", label: "Mouth", sliders: [["lips", "Lip fullness"], ["mouth_w", "Width"], ["smile", "Smile"]] },
  { id: "brows", label: "Brows", sliders: [["brow_h", "Height"], ["brow_ridge", "Ridge"]] },
] as const;
export const YOUNG_SLIDERS: string[] = YOUNG_SLIDER_GROUPS.flatMap((group) => group.sliders.map(([key]) => key));

/** Linear multipliers for `skin` and `hands`, lightest first. */
export const YOUNG_SKIN_TONES: readonly Rgb[] = [[1, 1, 1], [.92, .78, .66], [.74, .54, .38], [.52, .34, .22], [.34, .2, .12], [.2, .11, .07], [.11, .06, .04]];
export const YOUNG_HAIR_COLOURS: readonly Rgb[] = [[.03, .03, .03], [.1, .06, .04], [.2, .11, .06], [.34, .13, .05], [.72, .52, .26], [.45, .42, .38]];
/** Placeholder peoples: offsets added to a figure's slider defaults, and an index into the skin tones. Moderate on purpose, as anatomy and not caricature. */
export const YOUNG_PEOPLES = [
  { id: "norrmark", label: "Norrmark", skin: 1, offsets: { face_w: -.3, chin_len: .3, cheekbone: .1, nose_bridge: .7, nose_len: .5, nose_w: -.4, lips: -.4, brow_ridge: .2 } },
  { id: "ashplain", label: "Ashplain", skin: 2, offsets: { face_w: .6, cheekbone: .75, nose_bridge: -.6, nose_w: .1, eye_tilt: .5, eye_open: -.35, lid_full: .6 } },
  { id: "sunmarch", label: "Sunmarch", skin: 3, offsets: { face_w: -.25, nose_bridge: .6, nose_len: .6, nose_w: -.1, brow_ridge: .5, lips: .3, eye_open: .1 } },
  { id: "tidewater", label: "Tidewater", skin: 5, offsets: { face_w: .1, nose_w: .8, nose_bridge: -.35, lips: .9, mouth_w: .35 } },
  { id: "saltisle", label: "Saltisle", skin: 4, offsets: { face_w: .5, cheek: .3, nose_w: .5, nose_bridge: -.2, lips: .5, eye_tilt: .15 } },
] as const;
/** The per-figure look a consumer starts from. */
export const YOUNG_LOOKS: Record<YoungFigure, { label: string; ageYears: number; heightM: number; skin: number; hair: Rgb; cloth: Rgb; skirt?: Rgb; sliders: Record<string, number> }> = {
  "teen-boy": { label: "Teen boy", ageYears: 14, heightM: 1.66, skin: 3, hair: [.05, .04, .04], cloth: [.5, .64, .86], sliders: { low_face: 1, jaw_w: -.7, cheek: .5, nose_size: -.5, smile: .4, brow_h: .3, eye_size: .15 } },
  "teen-girl": { label: "Teen girl", ageYears: 14, heightM: 1.55, skin: 1, hair: [.34, .13, .05], cloth: [.82, .92, .66], skirt: [.2, .26, .34], sliders: { low_face: .7, jaw_w: -.4, cheek: .45, nose_size: -.5, smile: .6, brow_h: .4, eye_size: .2 } },
  "child-boy": { label: "Boy", ageYears: 8, heightM: 1.3, skin: 0, hair: [.72, .52, .26], cloth: [.98, .6, .36], sliders: { low_face: 1.1, jaw_w: -.8, cheek: 1, nose_size: -.9, smile: .8, brow_h: .5, eye_size: .35 } },
  "child-girl": { label: "Girl", ageYears: 8, heightM: 1.25, skin: 4, hair: [.06, .05, .05], cloth: [1, .95, .82], skirt: [.4, .14, .1], sliders: { low_face: .8, jaw_w: -.6, cheek: 1, nose_size: -.9, smile: 1, brow_h: .7, eye_size: .35 } },
};
const FILES: Record<YoungFigure, { head: "Male" | "Female"; hair: string }> = {
  "teen-boy": { head: "Male", hair: "Hair_Buzzed" }, "teen-girl": { head: "Female", hair: "Hair_Long" },
  "child-boy": { head: "Male", hair: "Hair_SimpleParted" }, "child-girl": { head: "Female", hair: "Hair_Buns" },
};

export function createYoungSpec({ figure, scriptSha256, faceSha256, blenderVersion, files }: {
  figure: YoungFigure; scriptSha256: string; faceSha256: string; blenderVersion: string; files: Record<string, string>;
}) {
  const inputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput> = {
    script: { path: "young_residents.py", sha256: scriptSha256 }, face: { path: "face_variants.py", sha256: faceSha256 },
  };
  Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).forEach(([name, sha256], index) => { inputs[`source${index}`] = { path: name, sha256 }; });
  return blenderScriptSpec({ assetId: youngKey(figure), inputs, blenderVersion, arguments: { schemaVersion: 1, figure }, output: "figure.glb" });
}

type Built = KitPart & { figure: YoungFigure };

export async function buildYoungResidents({ outDir, log = () => {}, repositoryRoot = path.resolve(import.meta.dir, "..") }: { outDir: string; log?: (line: string) => void; repositoryRoot?: string }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const [recipe, face] = await Promise.all([readBlenderRecipeSource("young_residents.py"), readBlenderRecipeSource("face_variants.py")]);
  const json = async (file: string) => JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8"));
  const [providers, sources, storage] = [await json("catalog/providers.json"), await json("catalog/sources.json"), await json("catalog/storage.json")];
  const rawSources: Json[] = sources.sources;
  const catalog = createAssetCatalog({ providers: providers.providers, sources: sources.sources });
  const named = (name: string) => {
    const matches = rawSources.filter((source) => ARCHIVES.includes(source.archiveMember?.archive) && path.posix.basename(source.archiveMember.path) === name);
    if (matches.length !== 1) throw new Error(`'${name}' must be exactly one catalogued member`);
    return matches[0]!;
  };
  const substitute = (gltfId: string, uri: string) => rawSources.find((source) => source.metadata?.substitutesFor?.some((entry: Json) => entry.member === gltfId && entry.uri === uri));
  const bytesOf = async (sourceId: string) => resolveAssetObject(root, (await importAssetCatalogStorageSource({ catalog, storage, sourceId, storageRoot: repositoryRoot, objectStoreRoot: root })).asset as never);

  const figureFiles = async (figure: YoungFigure) => {
    const { head, hair } = FILES[figure];
    const files: Record<string, Uint8Array> = {};
    for (const gltf of ["Male_Peasant.gltf", `Superhero_${head}_FullBody.gltf`, `${hair}.gltf`]) {
      const source = named(gltf);
      const bytes = await bytesOf(source.id);
      files[gltf] = bytes;
      const document = JSON.parse(Buffer.from(bytes).toString("utf8"));
      for (const { uri } of [...(document.buffers ?? []), ...(document.images ?? [])] as { uri: string }[]) {
        if (!files[uri]) files[uri] = await bytesOf((substitute(source.id, uri) ?? named(uri)).id);
      }
    }
    const light = head === "Female" ? "T_Superhero_Female_Light_BaseColor.png" : "T_Superhero_Male_Ligh.png";
    files[light] = await bytesOf(named(light).id);
    return files;
  };

  const built: Built[] = [];
  for (const figure of YOUNG_FIGURES) {
    log(`generate ${figure}`);
    const files = await figureFiles(figure);
    built.push({ figure, ...await buildKitPart(root, {
      workspace: path.join(root, "figures", figure), files: { "young_residents.py": recipe.bytes, "face_variants.py": face.bytes, ...files },
      spec: createYoungSpec({ figure, scriptSha256: recipe.sha256, faceSha256: face.sha256, blenderVersion: recipe.blenderVersion, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256Bytes(bytes)])) }),
      allowedValidatorWarnings: ALLOWED_WARNINGS,
    }) });
  }

  log("measure the descriptor");
  const figures = built.map(({ figure, document, observations }) => {
    const look = YOUNG_LOOKS[figure];
    const bounds = documentBounds(document);
    if (Math.abs(bounds.max[1] - bounds.min[1] - look.heightM) > .01) throw new Error(`${figure}: height ${bounds.max[1] - bounds.min[1]} is not ${look.heightM}`);
    return { key: youngKey(figure), figure, label: look.label, ageYears: look.ageYears, heightM: look.heightM, triangles: triangles(document), pelvisScale: round(observations.pelvisScale), bounds, look: { skin: look.skin, hair: look.hair, cloth: look.cloth, ...(look.skirt ? { skirt: look.skirt } : {}), sliders: look.sliders } };
  });
  const descriptor = {
    schema: YOUNG_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", origin: "Between the feet on the ground, facing +Z.",
    rig: `The adults' ${YOUNG_JOINT_COUNT}-joint rig: the same joint names and rotations as humanoid.ranger.male, at the figure's own joint offsets.`,
    clips: "Play humanoid.ranger clips by joint name. Use their rotation tracks, and the pelvis translation track multiplied by the figure's pelvisScale; drop any other translation track.",
    collision: "None: a figure uses the game's character capsule, scaled to heightM.",
    materials: { tintedByBaseColor: { skin: "skin tone", hands: "skin tone", hair: "hair colour", brows: "hair colour × 0.75", outfit: "look.cloth", skirt: "look.skirt" } },
    morphs: { nodes: ["head", "eyes", "brows"], range: [-1, 1], groups: YOUNG_SLIDER_GROUPS.map((group) => ({ id: group.id, label: group.label, sliders: group.sliders.map(([target, label]) => ({ target, label })) })) },
    skinTones: YOUNG_SKIN_TONES, hairColours: YOUNG_HAIR_COLOURS, peoples: YOUNG_PEOPLES, figures,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: YOUNG_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  log("encode the textures as KTX2 (ktx create)");
  const delivered = await ktx2Assets(root, YOUNG_RELEASE, built.map((part) => part.asset));
  const selections = built.map((part, index) => ({ key: youngKey(part.figure), variant: "default", ...(index === 0 ? { attachments: [{ name: YOUNG_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: YOUNG_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: delivered, attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [part.figure, part.document])) as Record<YoungFigure, Document>,
    lineage: { recipe: { script: "adapters/blender/young_residents.py", sha256: recipe.sha256, blenderVersion: recipe.blenderVersion }, release: YOUNG_RELEASE, descriptor: descriptorAsset },
  };
}

if (import.meta.main) await runKitCli("scripts/build-young-residents.ts", YOUNG_RELEASE, buildYoungResidents, { descriptorFile: true });
