import path from "node:path";
import { canonicalJson } from "./canonical.js";
import { sha256Text } from "./hash.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, createAssetOperationRegistry, createAssetRef,
  normalizeAssetOperationResult, type AssetRef, type AssetOperationBuildIdentity,
  type CanonicalJsonObject, type DeepReadonly, type AssetOperationDescriptor,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";
import { proceduralTextureMetadata, proceduralTextureObservations } from "./procedural-texture-metadata.js";
import {
  executeTileableHeightOperation, createTileableHeightOperationBuildIdentity,
  executeNormalFromHeightOperation, createNormalFromHeightOperationBuildIdentity,
  NORMAL_FROM_HEIGHT_OPERATION,
} from "./procedural-texture-operations.js";
import {
  composeSurfaceHeightRgba8, normalizeSurfaceTextureRecipe, scalarColorRampParameters as rampParameters,
  scalarColorRampRgba8, surfaceHeightComponentParameters, surfaceHeightParameters as heightParameters,
  surfaceRecipeHeightParameters, surfaceRecipeObject as object, type SurfaceHeightParameters, type SurfaceTextureRecipe,
} from "./surface-texture-kernels.js";

export {
  normalizeSurfaceTextureRecipe, SURFACE_TEXTURE_PRESETS, type FurrowParameters, type RgbBytes,
  type ScalarColorRampParameters, type SurfaceHeightParameters, type SurfaceTextureRecipe,
} from "./surface-texture-kernels.js";
export type SurfaceChannel = "color" | "height" | "normal" | "roughness";
export type SurfaceTextureStep = {
  operation: AssetOperationBuildIdentity["operation"];
  build: AssetOperationBuildIdentity;
  output: AssetRef;
  observations: CanonicalJsonObject;
};
export type SurfaceTexturePreservation = Partial<Record<SurfaceChannel, SurfaceTextureStep>>;
type Invocation = { parameters?: unknown; inputs?: unknown };
const CHANNELS: SurfaceChannel[] = ["color", "height", "normal", "roughness"];
const CHANNEL_SEMANTICS: Record<SurfaceChannel, CanonicalJsonObject> = {
  height: { field: "height", scalarEncoding: "unorm8", sampling: "data", channelColorSpace: "linear", tileable: true },
  color: { field: "base-color", sampling: "color", channelColorSpace: "srgb" },
  normal: { field: "normal", sampling: "data", channelColorSpace: "linear", normalYAxis: "negative" },
  roughness: { field: "roughness", scalarEncoding: "unorm8", sampling: "data", channelColorSpace: "linear" },
};
const imagePort = (id: string) => ({ id, assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE] });
const integerSchema = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const heightProperties = {
  seed: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
  width: integerSchema(1,4096), height: integerSchema(1,4096),
  gridX: integerSchema(1,256), gridY: integerSchema(1,256),
  detailGridX: integerSchema(1,256), detailGridY: integerSchema(1,256),
  detailWeight: integerSchema(0,255), heightMin: integerSchema(0,255), heightMax: integerSchema(0,255),
  furrows: {type:"object",additionalProperties:false,required:["axis","count","depth","softness"],properties:{
    axis:{type:"string",enum:["x","y"]},count:integerSchema(1,64),depth:integerSchema(0,255),softness:integerSchema(0,3)}},
};
const rgbSchema = { type: "array", minItems: 3, maxItems: 3, items: integerSchema(0,255) };
const SURFACE_HEIGHT_DESCRIPTOR = createAssetOperationDescriptor({
  schemaVersion: 1, id: "image.procedural.height.surface", version: "1",
  label: "Compose periodic surface height", category: "procedural.height",
  inputs: [], outputs: [imagePort("output")],
  parameterSchema: { type: "object", additionalProperties: false, required: Object.keys(heightProperties).filter(key=>key!=="furrows"), properties: heightProperties },
});
const SCALAR_COLOR_RAMP_DESCRIPTOR = createAssetOperationDescriptor({
  schemaVersion: 1, id: "image.scalar.color-ramp", version: "1",
  label: "Color an opaque scalar field", category: "texture.material",
  inputs: [imagePort("source")], outputs: [imagePort("output")],
  parameterSchema: { type: "object", additionalProperties: false, required: ["low","high"], properties: { low: rgbSchema, high: rgbSchema } },
});

const OPERATION_REGISTRY = createAssetOperationRegistry([SURFACE_HEIGHT_DESCRIPTOR, SCALAR_COLOR_RAMP_DESCRIPTOR]);
// Both keys are owned by the literal descriptors registered immediately above.
export const SURFACE_HEIGHT_OPERATION = OPERATION_REGISTRY.get("image.procedural.height.surface", "1")!;
export const SCALAR_COLOR_RAMP_OPERATION = OPERATION_REGISTRY.get("image.scalar.color-ramp", "1")!;
const CHANNEL_OPERATIONS = {height:SURFACE_HEIGHT_OPERATION,normal:NORMAL_FROM_HEIGHT_OPERATION,
  color:SCALAR_COLOR_RAMP_OPERATION,roughness:SCALAR_COLOR_RAMP_OPERATION} satisfies Record<SurfaceChannel,DeepReadonly<AssetOperationDescriptor>>;

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
    implementation: { id: "builtin.image.procedural.height.surface", version: "2", algorithm: "periodic-two-scale-unorm8-mix-stripes-v2", tool: await captureToolIdentity() } });
}
export async function createScalarColorRampOperationBuildIdentity(root: string, { parameters, inputs = {} }: Invocation = {}) {
  assertRoot(root);
  const build = createAssetOperationBuildIdentity({ operation: SCALAR_COLOR_RAMP_OPERATION, parameters: rampParameters(parameters), inputs,
    implementation: { id: "builtin.image.scalar.color-ramp", version: "1", algorithm: "unorm8-rgb-endpoint-ramp-v1", tool: await captureToolIdentity() } });
  await scalarImage(root,createAssetRef(build.inputs.source));
  return build;
}
function surfaceImageMetadata(image: { width:number; height:number }, build: AssetOperationBuildIdentity, metadata: CanonicalJsonObject): CanonicalJsonObject {
  return {width:image.width,height:image.height,generator:`${build.operation.id}@${build.operation.version}`,...metadata};
}
async function storeImage(root: string, image: { width: number; height: number; pixels: Uint8Array }, build: AssetOperationBuildIdentity, metadata: CanonicalJsonObject) {
  return (await storeAssetObject(root, { bytes: encodeRgba8Image(image), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: surfaceImageMetadata(image,build,metadata) })).asset;
}
function heightComponentInvocations(p: SurfaceHeightParameters) {
  return surfaceHeightComponentParameters(p).map((parameters) => ({ parameters }));
}

export async function executeSurfaceHeightOperation(root: string, invocation: Invocation = {}) {
  const build = await createSurfaceHeightOperationBuildIdentity(root,invocation);
  const p = heightParameters(build.parameters);
  const [coarseInvocation,detailInvocation] = heightComponentInvocations(p);
  const coarseBuild = await createTileableHeightOperationBuildIdentity(root,coarseInvocation);
  const coarse = createAssetRef((await executeTileableHeightOperation(root,coarseInvocation)).outputs.output);
  const coarseImage = await scalarImage(root,coarse);
  const components: { build: AssetOperationBuildIdentity; output: AssetRef }[] = [{ build: coarseBuild, output: coarse }];
  let detailImage = coarseImage;
  if (detailInvocation) {
    const detailBuild = await createTileableHeightOperationBuildIdentity(root,detailInvocation);
    const detail = createAssetRef((await executeTileableHeightOperation(root,detailInvocation)).outputs.output);
    detailImage = await scalarImage(root,detail);
    components.push({ build: detailBuild, output: detail });
  }
  const output = await storeImage(root,composeSurfaceHeightRgba8(p,coarseImage,detailImage),build,
    { ...CHANNEL_SEMANTICS.height, sourceSha256s: components.map(c=>c.output.sha256) });
  return normalizeAssetOperationResult(SURFACE_HEIGHT_OPERATION,{ outputs: { output }, observations: { components, parameters: build.parameters } });
}
export async function executeScalarColorRampOperation(root: string, invocation: Invocation = {}) {
  const build = await createScalarColorRampOperationBuildIdentity(root,invocation);
  const source = createAssetRef(build.inputs.source);
  const image = await scalarImage(root,source);
  const output = await storeImage(root,scalarColorRampRgba8(image,rampParameters(build.parameters)),build,{ sourceSha256: source.sha256, colorSpace: "srgb", alphaMode: "straight" });
  return normalizeAssetOperationResult(SCALAR_COLOR_RAMP_OPERATION,{ outputs: { output }, observations: { parameters: build.parameters } });
}

function selectedChannels(channels: SurfaceChannel[]): SurfaceChannel[] {
  if (!Array.isArray(channels) || channels.length === 0 || new Set(channels).size !== channels.length || channels.some(c=>!CHANNELS.includes(c))) throw new Error("channels must be a non-empty unique selection of surface channels");
  return CHANNELS.filter(c=>channels.includes(c));
}

async function preservedStep(root: string, value: SurfaceTextureStep, build: AssetOperationBuildIdentity, channel: SurfaceChannel, recipe: SurfaceTextureRecipe): Promise<SurfaceTextureStep> {
  const p = object(value, ["operation", "build", "output", "observations"], `preserved ${channel} step`);
  if (canonicalJson(p.build) !== canonicalJson(build) || canonicalJson(p.operation) !== canonicalJson(build.operation)) throw new Error(`preserved ${channel} build does not match current dependencies; regenerate it`);
  const output = createAssetRef(p.output);
  if (output.kind !== "image" || output.mediaType !== RGBA8_IMAGE_MEDIA_TYPE) throw new Error(`preserved ${channel} must be a canonical RGBA8 image`);
  const image = channel === "height" || channel === "roughness" ? await scalarImage(root, output) : parseRgba8Image(await resolveAssetObject(root, output));
  if (image.width !== recipe.width || image.height !== recipe.height) throw new Error(`preserved ${channel} dimensions do not match recipe`);
  const expected = await preservedEvidence(root,p.observations,build,channel,recipe);
  if (canonicalJson(output.metadata) !== canonicalJson(expected.metadata)) throw new Error(`preserved ${channel} metadata does not match complete producer contract`);
  for (let offset=3;offset<image.pixels.length;offset+=4) if (image.pixels[offset] !== 255) throw new Error(`preserved ${channel} must be opaque`);
  // Canonical serialization validates and detaches caller-owned observation data.
  const observations = normalizeAssetOperationResult(CHANNEL_OPERATIONS[channel],{outputs:{output},observations:expected.observations}).observations;
  return { operation: build.operation, build, output, observations };
}

async function preservedEvidence(root: string, value: unknown, build: AssetOperationBuildIdentity, channel: SurfaceChannel, recipe: SurfaceTextureRecipe) {
  let metadata: CanonicalJsonObject, observations: unknown;
  if (channel === "height") {
    const recorded = object(value,["components","parameters"],"preserved height observations");
    const invocations = heightComponentInvocations(recipe);
    if (!Array.isArray(recorded.components) || recorded.components.length !== invocations.length) throw new Error("preserved height component evidence does not match recipe");
    const components: {build:AssetOperationBuildIdentity;output:AssetRef}[] = [];
    for (const [index,invocation] of invocations.entries()) {
      const component = object(recorded.components[index],["build","output"],"preserved height component");
      const expectedBuild = await createTileableHeightOperationBuildIdentity(root,invocation);
      if (canonicalJson(component.build) !== canonicalJson(expectedBuild)) throw new Error("preserved height component build does not match current dependencies");
      const output = createAssetRef(component.output);
      if (output.kind !== "image" || output.mediaType !== RGBA8_IMAGE_MEDIA_TYPE || canonicalJson(output.metadata) !== canonicalJson(proceduralTextureMetadata(expectedBuild,recipe))) throw new Error("preserved height component metadata does not match producer contract");
      const image = await scalarImage(root,output);
      if (image.width !== recipe.width || image.height !== recipe.height) throw new Error("preserved height component dimensions do not match recipe");
      components.push({build:expectedBuild,output});
    }
    metadata = surfaceImageMetadata(recipe,build,{...CHANNEL_SEMANTICS.height,sourceSha256s:components.map(c=>c.output.sha256)});
    observations = {components,parameters:build.parameters};
  } else if (channel === "normal") {
    metadata = {...proceduralTextureMetadata(build,recipe),...CHANNEL_SEMANTICS.normal};
    observations = proceduralTextureObservations(build,recipe);
  } else {
    metadata = surfaceImageMetadata(recipe,build,{sourceSha256:createAssetRef(build.inputs.source).sha256,
      colorSpace:"srgb",alphaMode:"straight",...CHANNEL_SEMANTICS[channel]});
    observations = {parameters:build.parameters};
  }
  if (canonicalJson(value) !== canonicalJson(observations)) throw new Error(`preserved ${channel} observations do not match producer contract`);
  return {metadata,observations};
}

async function channelPlan(root: string, recipe: SurfaceTextureRecipe, channel: Exclude<SurfaceChannel, "height">, height: AssetRef) {
  const inputs = { source: height };
  switch (channel) {
    case "normal": {
      const invocation = { inputs, parameters: { strength: recipe.normalStrength, wrap: true } };
      return { build: await createNormalFromHeightOperationBuildIdentity(root,invocation),
        execute: () => executeNormalFromHeightOperation(root,invocation),
        semantics: CHANNEL_SEMANTICS.normal };
    }
    case "color": {
      const invocation = { inputs, parameters: { low: recipe.low, high: recipe.high } };
      return { build: await createScalarColorRampOperationBuildIdentity(root,invocation),
        execute: () => executeScalarColorRampOperation(root,invocation),
        semantics: CHANNEL_SEMANTICS.color };
    }
    case "roughness": {
      const invocation = { inputs, parameters: { low: [recipe.roughnessMin,recipe.roughnessMin,recipe.roughnessMin], high: [recipe.roughnessMax,recipe.roughnessMax,recipe.roughnessMax] } };
      return { build: await createScalarColorRampOperationBuildIdentity(root,invocation),
        execute: () => executeScalarColorRampOperation(root,invocation),
        semantics: CHANNEL_SEMANTICS.roughness };
    }
    default: {
      const unsupported: never = channel;
      throw new Error(`unsupported surface channel '${unsupported}'`);
    }
  }
}

async function executeRecipe(root: string, value: unknown, channels: SurfaceChannel[], preserve: SurfaceTexturePreservation = {}) {
  assertRoot(root);
  const recipe = normalizeSurfaceTextureRecipe(value);
  const selected = selectedChannels(channels);
  if (!preserve || typeof preserve !== "object" || Array.isArray(preserve) || ![Object.prototype, null].includes(Object.getPrototypeOf(preserve))) throw new Error("preserve must be a channel-to-step object");
  for (const channel of Object.keys(preserve)) {
    if (!CHANNELS.includes(channel as SurfaceChannel) || (channel !== "height" && !selected.includes(channel as SurfaceChannel))) throw new Error(`cannot preserve unselected or unknown channel '${channel}'`);
    if (!Object.hasOwn(preserve, "height")) throw new Error("preserved dependent channels require a preserved height step");
  }
  const heightInvocation = { parameters: surfaceRecipeHeightParameters(recipe) };
  const build = await createSurfaceHeightOperationBuildIdentity(root,heightInvocation);
  const reused: SurfaceTexturePreservation = {};
  if (Object.hasOwn(preserve, "height")) reused.height = await preservedStep(root, preserve.height!, build, "height", recipe);
  // Validate every requested lock before any generation, including stale/corrupt dependent outputs.
  if (reused.height) for (const channel of selected) {
    if (channel === "height" || !Object.hasOwn(preserve, channel)) continue;
    const plan = await channelPlan(root, recipe, channel, reused.height.output);
    reused[channel] = await preservedStep(root, preserve[channel]!, plan.build, channel, recipe);
  }
  let heightStep = reused.height;
  if (!heightStep) {
    const heightResult = await executeSurfaceHeightOperation(root,heightInvocation);
    heightStep = { operation: build.operation, build, output: createAssetRef(heightResult.outputs.output), observations: heightResult.observations };
  }
  const height = heightStep.output;
  const outputs: Partial<Record<SurfaceChannel,AssetRef>> = {};
  const steps: SurfaceTextureStep[] = [heightStep];
  const stages: { channel: SurfaceChannel; status: "executed" | "reused"; operationCount: number }[] = [
    { channel: "height", status: reused.height ? "reused" : "executed", operationCount: recipe.detailWeight > 0 ? 3 : 2 },
  ];
  for (const channel of selected) {
    if (channel === "height") { outputs.height=height; continue; }
    let step = reused[channel];
    if (!step) {
      const plan = await channelPlan(root,recipe,channel,height);
      const result = await plan.execute(), rawOutput = createAssetRef(result.outputs.output);
      const output = createAssetRef({ ...rawOutput, metadata: { ...rawOutput.metadata, ...plan.semantics } });
      step = { operation: plan.build.operation, build: plan.build, output, observations: result.observations };
    }
    outputs[channel]=step.output; steps.push(step);
    stages.push({ channel, status: reused[channel] ? "reused" : "executed", operationCount: 1 });
  }
  const result = { schemaVersion: 1, recipe, recipeSha256: sha256Text(canonicalJson(recipe)), outputs, steps,
    conventions: { color: "srgb", height: "linear-unorm8-data", roughness: "linear-unorm8-data",
      normal: { sampling: "linear-unorm8-data", space: "tangent", yAxis: "negative" },
      seamMode: "repeat", sampleDomain: "[0,width) x [0,height)" } };
  const executedOperations = stages.filter(s => s.status === "executed").reduce((sum,s) => sum+s.operationCount,0);
  const reusedOperations = stages.filter(s => s.status === "reused").reduce((sum,s) => sum+s.operationCount,0);
  return { ...result, execution: { stages, executedOperations, reusedOperations, imagePixelsGenerated: executedOperations*recipe.width*recipe.height } };
}

export async function executeSurfaceTextureRecipe(root: string, value: unknown, { channels = CHANNELS }: { channels?: SurfaceChannel[] } = {}) {
  const { execution: _execution, ...result } = await executeRecipe(root,value,channels);
  return result;
}

/** Explicit immutable component locks. Full execution above remains the independent replay path. */
export async function executePreservedSurfaceTextureRecipe(root: string, value: unknown, { channels = CHANNELS, preserve = {} }: {
  channels?: SurfaceChannel[]; preserve?: SurfaceTexturePreservation;
} = {}) {
  return executeRecipe(root,value,channels,preserve);
}
