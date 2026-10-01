import path from "node:path";
import { canonicalJson } from "./canonical.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { lumaRgba8 } from "./image-color.js";
import { RGBA8_IMAGE_MEDIA_TYPE, parseRgba8Image, type Rgba8Image } from "./image-rgba8.js";
import {
  LINEAR_RGBA8_IMAGE_MEDIA_TYPE,
  encodeLinearRgba8Image,
  parseLinearRgba8Image,
} from "./image-linear-rgba8.js";
import {
  createAssetOperationBuildIdentity,
  createAssetRef,
  type AssetRef,
  type ReadonlyAssetOperationDescriptor,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

type Invocation = {parameters?:unknown;inputs?:unknown};
export type TextureEntry = {sha256:string;byteLength:number;mediaType:string;width:number;height:number};
export type MaterialTextureKey = "baseColor"|"normal"|"orm";
const VERSION = "1";
export const PBR_MATERIAL_MEDIA_TYPE = "application/vnd.asset-tooling.pbr-material+json";
const ORM_PORTS = ["ambient-occlusion", "roughness", "metallic"];
const MATERIAL_TEXTURE_KEYS:Record<string,MaterialTextureKey> = {
  "base-color": "baseColor",
  normal: "normal",
  orm: "orm",
};

const srgbImagePort = (id:string,label:string,required=true) => ({
  id,
  label,
  required,
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
});

const linearImagePort = (id:string,label:string,required=true) => ({
  id,
  label,
  required,
  assetKinds: ["image"],
  mediaTypes: [LINEAR_RGBA8_IMAGE_MEDIA_TYPE],
});

const REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: "texture.orm.pack",
    version: VERSION,
    label: "Pack ORM texture",
    description:
      "Pack ambient-occlusion, roughness, and metallic grayscale values into linear RGBA8 R/G/B channels with opaque alpha.",
    category: "texture.material",
    inputs: [
      srgbImagePort("ambient-occlusion", "Ambient occlusion"),
      srgbImagePort("roughness", "Roughness"),
      srgbImagePort("metallic", "Metallic"),
    ],
    outputs: [linearImagePort("output", "Packed ORM texture")],
    parameterSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    schemaVersion: 1,
    id: "material.pbr.bundle",
    version: VERSION,
    label: "Assemble PBR material bundle",
    description:
      "Assemble typed base-color, tangent-space normal, and packed ORM texture references into one canonical content-addressed PBR material asset.",
    category: "material.composition",
    inputs: [
      srgbImagePort("base-color", "Base color", false),
      srgbImagePort("normal", "Normal", false),
      linearImagePort("orm", "ORM", false),
    ],
    outputs: [
      {
        id: "output",
        label: "PBR material",
        assetKinds: ["material"],
        mediaTypes: [PBR_MATERIAL_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        normalYAxis: { type: "string", enum: ["positive", "negative"] },
      },
    },
  },
]);

export const TEXTURE_ORM_PACK_OPERATION = REGISTRY.get("texture.orm.pack", VERSION)!;
export const PBR_MATERIAL_BUNDLE_OPERATION = REGISTRY.get("material.pbr.bundle", VERSION)!;
export const MATERIAL_OPERATIONS = REGISTRY.list();

function assertRoot(root:string) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("material operation root must be an absolute path");
  }
  return root;
}

function plainObject(value:unknown,location:string):Record<string,unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  return value as Record<string,unknown>;
}

function normalizeParameters(operation:ReadonlyAssetOperationDescriptor,value:unknown,inputs:unknown) {
  const parameters = plainObject(value, `${operation.id} parameters`);
  if (operation.id === "texture.orm.pack") {
    if (Object.keys(parameters).length !== 0) {
      throw new Error("texture.orm.pack parameters must be empty");
    }
    return {};
  }

  for (const key of Object.keys(parameters)) {
    if (key !== "normalYAxis") {
      throw new Error(`material.pbr.bundle parameters contains unknown field '${key}'`);
    }
  }
  const hasNormal = Object.hasOwn(plainObject(inputs,"material inputs"), "normal");
  if (hasNormal) {
    if (parameters.normalYAxis!=="positive" && parameters.normalYAxis!=="negative") {
      throw new Error("material.pbr.bundle normalYAxis must be positive or negative when normal is present");
    }
    return { normalYAxis: parameters.normalYAxis };
  }
  if (parameters.normalYAxis !== undefined) {
    throw new Error("material.pbr.bundle normalYAxis is only valid when normal is present");
  }
  return {};
}

async function implementationIdentity(operation:ReadonlyAssetOperationDescriptor) {
  if(operation.id!=="texture.orm.pack" && operation.id!=="material.pbr.bundle") throw new Error("unsupported material operation identity");
  return {
    id: `builtin.${operation.id}`,
    version: VERSION,
    algorithm:
      operation.id === "texture.orm.pack"
        ? "q8-rec709-orm-linear-pack-v1"
        : "canonical-pbr-material-reference-bundle-v1",
    tool: await captureToolIdentity(),
  };
}

async function readSrgb(root:string,asset:AssetRef) {
  return parseRgba8Image(await resolveAssetObject(root, asset));
}

async function readLinear(root:string,asset:AssetRef) {
  return parseLinearRgba8Image(await resolveAssetObject(root, asset));
}

function assertSameDimensions(images:readonly Rgba8Image[]) {
  const [first, ...rest] = images;
  if (!first) throw new Error("ORM requires image inputs");
  if (rest.some((image) => image.width !== first.width || image.height !== first.height)) {
    throw new Error("ORM source dimensions must exactly match");
  }
}

async function createBuildIdentity(root:string,operation:ReadonlyAssetOperationDescriptor,parameters:unknown,inputs:unknown) {
  const assetRoot = assertRoot(root);
  const normalizedParameters = normalizeParameters(operation, parameters, inputs);
  const build = createAssetOperationBuildIdentity({
    operation,
    implementation: await implementationIdentity(operation),
    parameters: normalizedParameters,
    inputs,
  });

  if (operation.id === "texture.orm.pack") {
    const images = await Promise.all(
      ORM_PORTS.map((id) => readSrgb(assetRoot, createAssetRef(build.inputs[id]))),
    );
    assertSameDimensions(images);
  } else {
    const ids = Object.keys(build.inputs);
    if (ids.length === 0) throw new Error("material.pbr.bundle requires at least one texture input");
    await Promise.all(
      ids.map((id) =>
        id === "orm" ? readLinear(assetRoot, createAssetRef(build.inputs[id])) : readSrgb(assetRoot, createAssetRef(build.inputs[id])),
      ),
    );
  }
  return build;
}

function packOrm(ambientOcclusion:Rgba8Image,roughness:Rgba8Image,metallic:Rgba8Image) {
  assertSameDimensions([ambientOcclusion, roughness, metallic]);
  const pixels = Buffer.alloc(ambientOcclusion.width * ambientOcclusion.height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = lumaRgba8(
      ambientOcclusion.pixels[offset]!,
      ambientOcclusion.pixels[offset + 1]!,
      ambientOcclusion.pixels[offset + 2]!,
    );
    pixels[offset + 1] = lumaRgba8(
      roughness.pixels[offset]!,
      roughness.pixels[offset + 1]!,
      roughness.pixels[offset + 2]!,
    );
    pixels[offset + 2] = lumaRgba8(
      metallic.pixels[offset]!,
      metallic.pixels[offset + 1]!,
      metallic.pixels[offset + 2]!,
    );
    pixels[offset + 3] = 255;
  }
  return { width: ambientOcclusion.width, height: ambientOcclusion.height, pixels };
}

function textureEntry(asset:AssetRef,image:Rgba8Image) {
  return {
    sha256: asset.sha256,
    byteLength: asset.byteLength,
    mediaType: asset.mediaType,
    width: image.width,
    height: image.height,
  };
}

export async function createTextureOrmPackOperationBuildIdentity(
  root:string,
  { parameters = {}, inputs = {} }:Invocation = {},
) {
  return createBuildIdentity(root, TEXTURE_ORM_PACK_OPERATION, parameters, inputs);
}

export async function executeTextureOrmPackOperation(root:string,invocation:Invocation={}) {
  const assetRoot = assertRoot(root);
  const build = await createTextureOrmPackOperationBuildIdentity(assetRoot, invocation);
  const [ambientOcclusion, roughness, metallic] = await Promise.all(
    ORM_PORTS.map((id) => readSrgb(assetRoot, createAssetRef(build.inputs[id]))),
  );
  const output = packOrm(ambientOcclusion!, roughness!, metallic!);
  const stored = await storeAssetObject(assetRoot, {
    bytes: encodeLinearRgba8Image(output),
    kind: "image",
    mediaType: LINEAR_RGBA8_IMAGE_MEDIA_TYPE,
    metadata: {
      width: output.width,
      height: output.height,
      pixelFormat: "rgba8",
      colorSpace: "linear-srgb",
      alphaMode: "straight",
      field: "orm",
      scalarEncoding: "unorm8",
      channelSemantics: {
        red: "ambient-occlusion",
        green: "roughness",
        blue: "metallic",
        alpha: "one",
      },
      inputs: ORM_PORTS.map((port) => ({
        port,
        sha256: createAssetRef(build.inputs[port]).sha256,
      })),
    },
  });
  return normalizeAssetOperationResult(TEXTURE_ORM_PACK_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      width: output.width,
      height: output.height,
      algorithm: build.implementation.algorithm,
      channels: { red: "ambient-occlusion", green: "roughness", blue: "metallic", alpha: "one" },
    },
  });
}

export async function createPbrMaterialBundleOperationBuildIdentity(
  root:string,
  { parameters = {}, inputs = {} }:Invocation = {},
) {
  return createBuildIdentity(root, PBR_MATERIAL_BUNDLE_OPERATION, parameters, inputs);
}

export async function executePbrMaterialBundleOperation(root:string,invocation:Invocation={}) {
  const assetRoot = assertRoot(root);
  const build = await createPbrMaterialBundleOperationBuildIdentity(assetRoot, invocation);
  const textures:Partial<Record<MaterialTextureKey,TextureEntry>> = {};
  for (const [port, asset] of Object.entries(build.inputs)) {
    const image = port === "orm" ? await readLinear(assetRoot, createAssetRef(asset)) : await readSrgb(assetRoot, createAssetRef(asset));
    textures[MATERIAL_TEXTURE_KEYS[port]!] = textureEntry(createAssetRef(asset), image);
  }
  const document = {
    schemaVersion: 1,
    model: "pbr-metallic-roughness",
    textures,
    conventions: {
      ...(build.inputs.normal
        ? {
            normal: {
              space: "tangent",
              encoding: "xyz-unorm8",
              yAxis: build.parameters.normalYAxis,
            },
          }
        : {}),
      ...(build.inputs.orm
        ? {
            orm: {
              colorSpace: "linear-srgb",
              red: "ambient-occlusion",
              green: "roughness",
              blue: "metallic",
              alpha: "one",
            },
          }
        : {}),
    },
  };
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
  const stored = await storeAssetObject(assetRoot, {
    bytes,
    kind: "material",
    mediaType: PBR_MATERIAL_MEDIA_TYPE,
    metadata: {
      model: document.model,
      texturePorts: Object.keys(build.inputs).sort(),
      inputs: Object.entries(build.inputs).map(([port, asset]) => ({ port, sha256: createAssetRef(asset).sha256 })),
    },
  });
  return normalizeAssetOperationResult(PBR_MATERIAL_BUNDLE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      algorithm: build.implementation.algorithm,
      texturePorts: Object.keys(build.inputs).sort(),
      conventions: document.conventions,
    },
  });
}


export type PbrMaterialDocument = {
  schemaVersion:1;model:"pbr-metallic-roughness";
  textures:Partial<Record<MaterialTextureKey,TextureEntry>>;
  conventions:{normal?:{space:"tangent";encoding:"xyz-unorm8";yAxis:"positive"|"negative"};
    orm?:{colorSpace:"linear-srgb";red:"ambient-occlusion";green:"roughness";blue:"metallic";alpha:"one"}};
};
/** Admits the existing v1 reference bundle; it does not acquire or decode its textures. */
export function parsePbrMaterialDocument(bytes:Uint8Array):PbrMaterialDocument {
  if(!(bytes instanceof Uint8Array) || bytes.byteLength>8*1024*1024) throw new Error("PBR material document exceeds 8 MiB");
  const exact=(value:unknown,keys:string[],name:string)=>{
    const result=plainObject(value,name);
    if(Object.keys(result).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(result,key))) throw new Error(`${name} requires exactly ${keys.join(", ")}`);
    return result;
  };
  const value:unknown=JSON.parse(Buffer.from(bytes).toString("utf8")),raw=exact(value,["schemaVersion","model","textures","conventions"],"PBR document");
  if(raw.schemaVersion!==1 || raw.model!=="pbr-metallic-roughness") throw new Error("unsupported PBR schema/model");
  const sources=plainObject(raw.textures,"PBR textures"),conventions=plainObject(raw.conventions,"PBR conventions"),textures:PbrMaterialDocument["textures"]={};
  if(!Object.keys(sources).length || Object.keys(sources).some(key=>!["baseColor","normal","orm"].includes(key))) throw new Error("PBR requires known texture references");
  for(const key of ["baseColor","normal","orm"] as const) if(Object.hasOwn(sources,key)) {
    const entry=exact(sources[key],["sha256","byteLength","mediaType","width","height"],"PBR texture reference");
    if(entry.mediaType!==(key==="orm"?LINEAR_RGBA8_IMAGE_MEDIA_TYPE:RGBA8_IMAGE_MEDIA_TYPE)) throw new Error("PBR texture container disagrees with channel semantics");
    const asset=createAssetRef({kind:"image",mediaType:entry.mediaType,sha256:entry.sha256,byteLength:entry.byteLength});
    const dimension=(value:unknown)=>{if(typeof value!=="number" || !Number.isSafeInteger(value) || value<1 || value>8192) throw new Error("PBR dimensions must be in 1..8192");return value;};
    textures[key]={sha256:asset.sha256,byteLength:asset.byteLength,mediaType:asset.mediaType,width:dimension(entry.width),height:dimension(entry.height)};
  }
  const result:PbrMaterialDocument={schemaVersion:1,model:"pbr-metallic-roughness",textures,conventions:{}};
  if(Object.keys(conventions).some(key=>key!=="normal" && key!=="orm") || Object.hasOwn(conventions,"normal")!==Boolean(textures.normal) || Object.hasOwn(conventions,"orm")!==Boolean(textures.orm)) throw new Error("PBR conventions must correspond exactly to texture references");
  if(textures.normal) {
    const normal=exact(conventions.normal,["space","encoding","yAxis"],"normal conventions");
    if(normal.space!=="tangent" || normal.encoding!=="xyz-unorm8" || (normal.yAxis!=="positive" && normal.yAxis!=="negative")) throw new Error("unsupported PBR normal convention");
    result.conventions.normal={space:"tangent",encoding:"xyz-unorm8",yAxis:normal.yAxis};
  }
  if(textures.orm) {
    const orm=exact(conventions.orm,["colorSpace","red","green","blue","alpha"],"ORM conventions");
    if(orm.colorSpace!=="linear-srgb" || orm.red!=="ambient-occlusion" || orm.green!=="roughness" || orm.blue!=="metallic" || orm.alpha!=="one") throw new Error("unsupported PBR ORM channel convention");
    result.conventions.orm={colorSpace:"linear-srgb",red:"ambient-occlusion",green:"roughness",blue:"metallic",alpha:"one"};
  }
  return result;
}
