import path from "node:path";
import { canonicalJson } from "./canonical.js";
import { sha256Text } from "./hash.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetRef,
  normalizeAssetOperationResult, type AssetRef, type AssetOperationBuildIdentity,
  type CanonicalJsonObject,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";
import {
  executeTileableHeightOperation, createTileableHeightOperationBuildIdentity,
  executeNormalFromHeightOperation, createNormalFromHeightOperationBuildIdentity,
} from "./procedural-texture-operations.js";

export type SurfaceHeightParameters = {
  seed: string; width: number; height: number; gridX: number; gridY: number;
  detailGridX: number; detailGridY: number; detailWeight: number;
  heightMin: number; heightMax: number;
};
export type RgbBytes = [number, number, number];
export type ScalarColorRampParameters = { low: RgbBytes; high: RgbBytes };
export type SurfaceTextureRecipe = SurfaceHeightParameters & ScalarColorRampParameters & {
  schemaVersion: 1; seamMode: "repeat"; normalStrength: number;
  roughnessMin: number; roughnessMax: number;
};
export type SurfaceChannel = "color" | "height" | "normal" | "roughness";
type Invocation = { parameters?: unknown; inputs?: unknown };
const CHANNELS: SurfaceChannel[] = ["color", "height", "normal", "roughness"];
const imagePort = (id: string) => ({ id, assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE] });
const integerSchema = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const heightProperties = {
  seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  width: integerSchema(1,4096), height: integerSchema(1,4096),
  gridX: integerSchema(1,256), gridY: integerSchema(1,256),
  detailGridX: integerSchema(1,256), detailGridY: integerSchema(1,256),
  detailWeight: integerSchema(0,255), heightMin: integerSchema(0,255), heightMax: integerSchema(0,255),
};
const rgbSchema = { type: "array", minItems: 3, maxItems: 3, items: integerSchema(0,255) };
export const SURFACE_HEIGHT_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "image.procedural.height.surface", version: "1",
  label: "Compose periodic surface height", category: "procedural.height",
  inputs: [], outputs: [imagePort("output")],
  parameterSchema: { type: "object", additionalProperties: false, required: Object.keys(heightProperties), properties: heightProperties },
});
export const SCALAR_COLOR_RAMP_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "image.scalar.color-ramp", version: "1",
  label: "Color an opaque scalar field", category: "texture.material",
  inputs: [imagePort("source")], outputs: [imagePort("output")],
  parameterSchema: { type: "object", additionalProperties: false, required: ["low","high"], properties: { low: rgbSchema, high: rgbSchema } },
});

function object(value: unknown, keys: string[], location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${location} must be a plain object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`${location} contains unknown field '${key}'`);
  for (const key of keys) if (!Object.hasOwn(result, key)) throw new Error(`${location} is missing '${key}'`);
  return result;
}
function integer(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
  return value;
}
function heightParameters(value: unknown): SurfaceHeightParameters {
  const p = object(value, Object.keys(heightProperties), "surface height parameters");
  if (typeof p.seed !== "string" || !/^(0|[1-9][0-9]*)$/.test(p.seed)) throw new Error("seed must be a non-negative decimal integer string");
  const width = integer(p.width, "width",1,4096), height = integer(p.height,"height",1,4096);
  const heightMin = integer(p.heightMin,"heightMin",0,255), heightMax = integer(p.heightMax,"heightMax",0,255);
  if (heightMin > heightMax) throw new Error("heightMin must not exceed heightMax");
  return { seed: p.seed, width, height,
    gridX: integer(p.gridX,"gridX",1,Math.min(256,width)), gridY: integer(p.gridY,"gridY",1,Math.min(256,height)),
    detailGridX: integer(p.detailGridX,"detailGridX",1,Math.min(256,width)), detailGridY: integer(p.detailGridY,"detailGridY",1,Math.min(256,height)),
    detailWeight: integer(p.detailWeight,"detailWeight",0,255), heightMin, heightMax };
}
function rgb(value: unknown, key: string): RgbBytes {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${key} must contain three RGB bytes`);
  return [integer(value[0],`${key}[0]`,0,255), integer(value[1],`${key}[1]`,0,255), integer(value[2],`${key}[2]`,0,255)];
}
function rampParameters(value: unknown): ScalarColorRampParameters {
  const p = object(value,["low","high"],"scalar color ramp parameters");
  return { low: rgb(p.low,"low"), high: rgb(p.high,"high") };
}
function assertRoot(root: string): void {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("surface texture root must be an absolute path");
}
async function scalarImage(root: string, source: AssetRef): Promise<{ width: number; height: number; pixels: Buffer }> {
  const image = parseRgba8Image(await resolveAssetObject(root,source));
  for (let i=0;i<image.pixels.length;i+=4) {
    if (image.pixels[i] !== image.pixels[i+1] || image.pixels[i] !== image.pixels[i+2] || image.pixels[i+3] !== 255) throw new Error("scalar source must be opaque grayscale UNORM8");
  }
  return image;
}
export async function createSurfaceHeightOperationBuildIdentity(root: string, { parameters, inputs = {} }: Invocation = {}) {
  assertRoot(root);
  return createAssetOperationBuildIdentity({ operation: SURFACE_HEIGHT_OPERATION, parameters: heightParameters(parameters), inputs,
    implementation: { id: "builtin.image.procedural.height.surface", version: "1", algorithm: "periodic-two-scale-unorm8-mix-v1", tool: await captureToolIdentity() } });
}
export async function createScalarColorRampOperationBuildIdentity(root: string, { parameters, inputs = {} }: Invocation = {}) {
  assertRoot(root);
  const build = createAssetOperationBuildIdentity({ operation: SCALAR_COLOR_RAMP_OPERATION, parameters: rampParameters(parameters), inputs,
    implementation: { id: "builtin.image.scalar.color-ramp", version: "1", algorithm: "unorm8-rgb-endpoint-ramp-v1", tool: await captureToolIdentity() } });
  await scalarImage(root,createAssetRef(build.inputs.source));
  return build;
}
async function storeImage(root: string, image: { width: number; height: number; pixels: Uint8Array }, build: AssetOperationBuildIdentity, metadata: CanonicalJsonObject) {
  return (await storeAssetObject(root, { bytes: encodeRgba8Image(image), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: { width: image.width, height: image.height, generator: `${build.operation.id}@${build.operation.version}`, ...metadata } })).asset;
}
export async function executeSurfaceHeightOperation(root: string, invocation: Invocation = {}) {
  const build = await createSurfaceHeightOperationBuildIdentity(root,invocation);
  const p = heightParameters(build.parameters);
  const coarseInvocation = { parameters: { seed: p.seed, width: p.width, height: p.height, gridX: p.gridX, gridY: p.gridY } };
  const coarseBuild = await createTileableHeightOperationBuildIdentity(root,coarseInvocation);
  const coarse = createAssetRef((await executeTileableHeightOperation(root,coarseInvocation)).outputs.output);
  const coarseImage = await scalarImage(root,coarse);
  const components: { build: AssetOperationBuildIdentity; output: AssetRef }[] = [{ build: coarseBuild, output: coarse }];
  let detailImage = coarseImage;
  if (p.detailWeight > 0) {
    const detailInvocation = { parameters: { seed: (BigInt(p.seed)+1n).toString(), width: p.width, height: p.height, gridX: p.detailGridX, gridY: p.detailGridY } };
    const detailBuild = await createTileableHeightOperationBuildIdentity(root,detailInvocation);
    const detail = createAssetRef((await executeTileableHeightOperation(root,detailInvocation)).outputs.output);
    detailImage = await scalarImage(root,detail);
    components.push({ build: detailBuild, output: detail });
  }
  const pixels = Buffer.alloc(p.width*p.height*4);
  for (let i=0;i<pixels.length;i+=4) {
    const mixed = Math.round((coarseImage.pixels[i]!*(255-p.detailWeight)+detailImage.pixels[i]!*p.detailWeight)/255);
    const value = p.heightMin + Math.round(mixed*(p.heightMax-p.heightMin)/255);
    pixels[i]=pixels[i+1]=pixels[i+2]=value; pixels[i+3]=255;
  }
  const output = await storeImage(root,{ width: p.width, height: p.height, pixels },build,
    { field: "height", scalarEncoding: "unorm8", sampling: "data", channelColorSpace: "linear", tileable: true, sourceSha256s: components.map(c=>c.output.sha256) });
  return normalizeAssetOperationResult(SURFACE_HEIGHT_OPERATION,{ outputs: { output }, observations: { components, parameters: build.parameters } });
}
export async function executeScalarColorRampOperation(root: string, invocation: Invocation = {}) {
  const build = await createScalarColorRampOperationBuildIdentity(root,invocation);
  const source = createAssetRef(build.inputs.source);
  const image = await scalarImage(root,source);
  const p = rampParameters(build.parameters), pixels = Buffer.alloc(image.pixels.length);
  for (let i=0;i<pixels.length;i+=4) {
    for (let c=0;c<3;c++) pixels[i+c]=Math.round((p.low[c]!*(255-image.pixels[i]!)+p.high[c]!*image.pixels[i]!)/255);
    pixels[i+3]=255;
  }
  const output = await storeImage(root,{ ...image,pixels },build,{ sourceSha256: source.sha256, colorSpace: "srgb", alphaMode: "straight" });
  return normalizeAssetOperationResult(SCALAR_COLOR_RAMP_OPERATION,{ outputs: { output }, observations: { parameters: build.parameters } });
}

export function normalizeSurfaceTextureRecipe(value: unknown): SurfaceTextureRecipe {
  const p = object(value,["schemaVersion","seamMode", ...Object.keys(heightProperties),"low","high","normalStrength","roughnessMin","roughnessMax"],"surface recipe");
  if (p.schemaVersion !== 1 || p.seamMode !== "repeat") throw new Error("surface recipe requires schemaVersion 1 and repeat seamMode");
  const height = heightParameters(Object.fromEntries(Object.keys(heightProperties).map(k=>[k,p[k]])));
  const roughnessMin = integer(p.roughnessMin,"roughnessMin",0,255), roughnessMax = integer(p.roughnessMax,"roughnessMax",0,255);
  if (roughnessMin > roughnessMax) throw new Error("roughnessMin must not exceed roughnessMax");
  return { schemaVersion: 1, seamMode: "repeat", ...height, ...rampParameters({ low: p.low, high: p.high }),
    normalStrength: integer(p.normalStrength,"normalStrength",1,1024), roughnessMin, roughnessMax };
}
export async function executeSurfaceTextureRecipe(root: string, value: unknown, { channels = CHANNELS }: { channels?: SurfaceChannel[] } = {}) {
  assertRoot(root);
  const recipe = normalizeSurfaceTextureRecipe(value);
  if (!Array.isArray(channels) || channels.length === 0 || new Set(channels).size !== channels.length || channels.some(c=>!CHANNELS.includes(c))) throw new Error("channels must be a non-empty unique selection of surface channels");
  const heightInvocation = { parameters: Object.fromEntries(Object.keys(heightProperties).map(k=>[k,recipe[k as keyof SurfaceTextureRecipe]])) };
  const build = await createSurfaceHeightOperationBuildIdentity(root,heightInvocation);
  const heightResult = await executeSurfaceHeightOperation(root,heightInvocation);
  const height = createAssetRef(heightResult.outputs.output);
  const outputs: Partial<Record<SurfaceChannel,AssetRef>> = {};
  const steps = [{ operation: build.operation, build, output: height, observations: heightResult.observations }];
  for (const channel of CHANNELS.filter(c=>channels.includes(c))) {
    if (channel === "height") { outputs.height=height; continue; }
    const inputs = { source: height };
    let channelBuild: AssetOperationBuildIdentity;
    let result: ReturnType<typeof normalizeAssetOperationResult>;
    let semantics: CanonicalJsonObject;
    switch (channel) {
      case "normal": {
        const invocation = { inputs, parameters: { strength: recipe.normalStrength, wrap: true } };
        channelBuild = await createNormalFromHeightOperationBuildIdentity(root,invocation);
        result = await executeNormalFromHeightOperation(root,invocation);
        semantics = { field: "normal", sampling: "data", channelColorSpace: "linear", normalYAxis: "negative" };
        break;
      }
      case "color": {
        const invocation = { inputs, parameters: { low: recipe.low, high: recipe.high } };
        channelBuild = await createScalarColorRampOperationBuildIdentity(root,invocation);
        result = await executeScalarColorRampOperation(root,invocation);
        semantics = { field: "base-color", sampling: "color", channelColorSpace: "srgb" };
        break;
      }
      case "roughness": {
        const invocation = { inputs, parameters: { low: [recipe.roughnessMin,recipe.roughnessMin,recipe.roughnessMin], high: [recipe.roughnessMax,recipe.roughnessMax,recipe.roughnessMax] } };
        channelBuild = await createScalarColorRampOperationBuildIdentity(root,invocation);
        result = await executeScalarColorRampOperation(root,invocation);
        semantics = { field: "roughness", scalarEncoding: "unorm8", sampling: "data", channelColorSpace: "linear" };
        break;
      }
      default: {
        const unsupported: never = channel;
        throw new Error(`unsupported surface channel '${unsupported}'`);
      }
    }
    const rawOutput = createAssetRef(result.outputs.output);
    const output = createAssetRef({ ...rawOutput, metadata: { ...rawOutput.metadata, ...semantics } });
    outputs[channel]=output;
    steps.push({ operation: channelBuild.operation, build: channelBuild, output, observations: result.observations });
  }
  return { schemaVersion: 1, recipe, recipeSha256: sha256Text(canonicalJson(recipe)), outputs, steps,
    conventions: { color: "srgb", height: "linear-unorm8-data", roughness: "linear-unorm8-data",
      normal: { sampling: "linear-unorm8-data", space: "tangent", yAxis: "negative" },
      seamMode: "repeat", sampleDomain: "[0,width) x [0,height)" } };
}

function preset(overrides: Partial<SurfaceTextureRecipe>): SurfaceTextureRecipe {
  return { schemaVersion: 1, seamMode: "repeat", seed: "42", width: 256, height: 256,
    gridX: 8, gridY: 8, detailGridX: 64, detailGridY: 64, detailWeight: 80,
    heightMin: 0, heightMax: 255, low: [38,23,12], high: [145,102,58],
    normalStrength: 2, roughnessMin: 180, roughnessMax: 240, ...overrides };
}
// Content presets, not a core style policy. Clone before editing.
export const SURFACE_TEXTURE_PRESETS = {
  "soil-fine": preset({ gridX: 16, gridY: 16, detailWeight: 100 }),
  "soil-coarse": preset({ gridX: 6, gridY: 6, detailWeight: 130, normalStrength: 4 }),
  "soil-directional": preset({ gridX: 3, gridY: 24, detailWeight: 60, normalStrength: 3 }),
  "rock-smooth": preset({ low: [55,59,62], high: [160,164,166], detailWeight: 30, normalStrength: 1, roughnessMin: 110, roughnessMax: 180 }),
  "rock-grainy": preset({ low: [55,59,62], high: [160,164,166], detailWeight: 160, normalStrength: 4 }),
  "rock-layered": preset({ low: [62,54,44], high: [171,152,126], gridX: 24, gridY: 2, detailWeight: 50, normalStrength: 3 }),
} satisfies Record<string,SurfaceTextureRecipe>;
