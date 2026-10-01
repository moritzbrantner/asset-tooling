/// <reference path="./gltf-validator.d.ts" />
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { ImageUtils, TextureInfo, VERSION, type Document } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import path from "node:path";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { GLTF_IMPORT_OPERATION } from "./gltf-import-operations.js";
import { gltfSummary, loadCheckedGltf, validateGltf } from "./gltf-processing.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

type Invocation = { parameters?: unknown; inputs?: unknown };
type Filter = "nearest" | "linear";
type Wrap = "repeat" | "mirrored-repeat" | "clamp-to-edge";
export type GltfBaseColorParameters = {
  materialName: string; baseColorFactor: [number, number, number, number]; texCoord: number;
  sampler: { magFilter: Filter; minFilter: Filter; wrapS: Wrap; wrapT: Wrap };
  alpha: { mode: "OPAQUE" | "BLEND" } | { mode: "MASK"; cutoff: number };
};
const GLB = "model/gltf-binary";
const factorSchema = { type: "array", minItems: 4, maxItems: 4, items: { type: "number", minimum: 0, maximum: 1 } };
const filterSchema = { enum: ["nearest", "linear"] };
const wrapSchema = { enum: ["repeat", "mirrored-repeat", "clamp-to-edge"] };
export const GLTF_BASE_COLOR_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.material.base-color", version: "1", label: "Apply glTF base color", category: "material.composition",
  description: "Apply a verified PNG to one existing named material in a static self-contained GLB, preserving geometry and other PBR channels.",
  inputs: [
    { id: "source", assetKinds: ["scene", "mesh"], mediaTypes: [GLB] },
    { id: "base-color", assetKinds: ["image"], mediaTypes: ["image/png"] },
  ],
  outputs: [{ id: "output", assetKinds: ["scene", "mesh"], mediaTypes: [GLB] }],
  parameterSchema: { type: "object", additionalProperties: false, required: ["materialName", "baseColorFactor", "texCoord", "sampler", "alpha"], properties: {
    materialName: { type: "string", minLength: 1, maxLength: 256 }, baseColorFactor: factorSchema,
    texCoord: { type: "integer", minimum: 0, maximum: 7 },
    sampler: { type: "object", additionalProperties: false, required: ["magFilter", "minFilter", "wrapS", "wrapT"],
      properties: { magFilter: filterSchema, minFilter: filterSchema, wrapS: wrapSchema, wrapT: wrapSchema } },
    alpha: { oneOf: [
      { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { enum: ["OPAQUE", "BLEND"] } } },
      { type: "object", additionalProperties: false, required: ["mode", "cutoff"], properties: { mode: { const: "MASK" }, cutoff: { type: "number", minimum: 0, maximum: 1 } } },
    ] },
  } },
});

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) throw new Error(`${label} requires exactly ${keys.join(", ")}`);
  return result;
}
function unit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be finite in 0..1`);
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  for (const candidate of choices) if (candidate === value) return candidate;
  throw new Error(`unsupported ${label}`);
}
export function normalizeGltfBaseColorParameters(value: unknown): GltfBaseColorParameters {
  const p = object(value, ["materialName", "baseColorFactor", "texCoord", "sampler", "alpha"], "glTF base-color parameters");
  if (typeof p.materialName !== "string" || p.materialName.length < 1 || p.materialName.length > 256) throw new Error("materialName must contain 1..256 characters");
  if (!Array.isArray(p.baseColorFactor) || p.baseColorFactor.length !== 4) throw new Error("baseColorFactor needs four coordinates");
  if (typeof p.texCoord !== "number" || !Number.isInteger(p.texCoord) || p.texCoord < 0 || p.texCoord > 7) throw new Error("texCoord must be an integer in 0..7");
  const s = object(p.sampler, ["magFilter", "minFilter", "wrapS", "wrapT"], "sampler");
  const a = object(p.alpha, p.alpha && typeof p.alpha === "object" && "mode" in p.alpha && p.alpha.mode === "MASK" ? ["mode", "cutoff"] : ["mode"], "alpha");
  const mode = choice(a.mode, ["OPAQUE", "MASK", "BLEND"], "alpha mode");
  return { materialName: p.materialName, baseColorFactor: [unit(p.baseColorFactor[0], "factor"), unit(p.baseColorFactor[1], "factor"), unit(p.baseColorFactor[2], "factor"), unit(p.baseColorFactor[3], "factor")],
    texCoord: p.texCoord, sampler: {
      magFilter: choice(s.magFilter, ["nearest", "linear"], "magnification filter"), minFilter: choice(s.minFilter, ["nearest", "linear"], "minification filter"),
      wrapS: choice(s.wrapS, ["repeat", "mirrored-repeat", "clamp-to-edge"], "S wrap"), wrapT: choice(s.wrapT, ["repeat", "mirrored-repeat", "clamp-to-edge"], "T wrap"),
    }, alpha: mode === "MASK" ? { mode, cutoff: unit(a.cutoff, "alpha cutoff") } : { mode } };
}

async function checked(root: string, invocation: Invocation) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("glTF material operation root must be an absolute path");
  const p = normalizeGltfBaseColorParameters(invocation.parameters);
  const build = createAssetOperationBuildIdentity({ operation: GLTF_BASE_COLOR_OPERATION, parameters: p, inputs: invocation.inputs ?? {},
    implementation: { id: "gltf-transform-base-color", version: "1", gltfTransform: VERSION, validator: validatorVersion(),
      dependencyLockSha256: await readDependencyLockSha256(), assetTooling: await captureToolIdentity() } });
  const source = createAssetRef(build.inputs.source), baseColor = createAssetRef(build.inputs["base-color"]);
  const png = await resolveAssetObject(root, baseColor);
  if (png.length > 64 * 1024 * 1024 || ImageUtils.getMimeType(png) !== "image/png") throw new Error("base-color input must be a PNG within 64 MiB");
  const size = ImageUtils.getSize(png, "image/png");
  if (!size || size.some(value => !Number.isSafeInteger(value) || value < 1 || value > 4096)) throw new Error("base-color PNG dimensions must be in 1..4096");
  const imported = await loadCheckedGltf(root, GLTF_IMPORT_OPERATION, { resourceUris: [] }, { source }, false);
  const {material,primitives}=selectNamedGltfMaterial(imported.document,p.materialName,p.texCoord);
  return { build, p, baseColor, png, size, material, primitives, ...imported };
}

export async function createGltfBaseColorOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  return (await checked(root, invocation)).build;
}

export async function executeGltfBaseColorOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { p, source, baseColor, png, size, material, primitives, document, io } = await checked(root, invocation);
  // Reuse a byte-identical embedded image; sampler state belongs to this material's TextureInfo.
  const texture = document.getRoot().listTextures().find(candidate => candidate.getMimeType() === "image/png" &&
    candidate.getImage() && sha256Bytes(candidate.getImage()!) === baseColor.sha256)
    ?? document.createTexture("base-color").setImage(png).setMimeType("image/png");
  material.setBaseColorTexture(texture).setBaseColorFactor(p.baseColorFactor).setAlphaMode(p.alpha.mode)
    .setAlphaCutoff(p.alpha.mode === "MASK" ? p.alpha.cutoff : 0.5);
  const info = material.getBaseColorTextureInfo()!;
  applyGltfTextureInfo(info,p);
  const bytes = await io.writeBinary(document);
  await validateGltf(bytes, "glb", Object.create(null), "scene.material.base-color output");
  const stored = await storeAssetObject(root, { bytes, kind: source.kind, mediaType: GLB, metadata: {
    operation: "scene.material.base-color", sourceSha256: source.sha256, baseColorSha256: baseColor.sha256,
    materialName: p.materialName, colorSpace: "srgb", coordinateSystem: "right-handed-y-up", unit: "meter",
  } });
  return normalizeAssetOperationResult(GLTF_BASE_COLOR_OPERATION, { outputs: { output: stored.asset }, observations: {
    ...gltfSummary(document), materialName: p.materialName, affectedPrimitives: primitives.length, parameters: p,
    texture: { sha256: baseColor.sha256, byteLength: baseColor.byteLength, width: size[0], height: size[1], colorSpace: "srgb" },
  } });
}

export function selectNamedGltfMaterial(document:Document,materialName:string,texCoord:number) {
  const matches = document.getRoot().listMaterials().filter(material => material.getName() === materialName);
  if (matches.length !== 1) throw new Error("materialName must uniquely identify an existing material");
  const material = matches[0]!;
  const primitives = document.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives()).filter(primitive => primitive.getMaterial() === material);
  if (primitives.length === 0 || primitives.some(primitive => !primitive.getAttribute(`TEXCOORD_${texCoord}`))) throw new Error("selected material must be used and covered by the declared UV set");
  return {material,primitives};
}

export function applyGltfTextureInfo(info:TextureInfo,p:GltfBaseColorParameters) {
  const filters = { nearest: TextureInfo.MagFilter.NEAREST!, linear: TextureInfo.MagFilter.LINEAR! };
  const wraps = { repeat: TextureInfo.WrapMode.REPEAT!, "mirrored-repeat": TextureInfo.WrapMode.MIRRORED_REPEAT!, "clamp-to-edge": TextureInfo.WrapMode.CLAMP_TO_EDGE! };
  info.setTexCoord(p.texCoord).setMagFilter(filters[p.sampler.magFilter]).setMinFilter(filters[p.sampler.minFilter])
    .setWrapS(wraps[p.sampler.wrapS]).setWrapT(wraps[p.sampler.wrapT]);
}
