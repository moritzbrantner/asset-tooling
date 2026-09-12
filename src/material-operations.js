import path from "node:path";
import { canonicalJson } from "./canonical.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { lumaRgba8 } from "./image-color.js";
import { RGBA8_IMAGE_MEDIA_TYPE, parseRgba8Image } from "./image-rgba8.js";
import {
  LINEAR_RGBA8_IMAGE_MEDIA_TYPE,
  encodeLinearRgba8Image,
  parseLinearRgba8Image,
} from "./image-linear-rgba8.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const VERSION = "1";
export const PBR_MATERIAL_MEDIA_TYPE = "application/vnd.asset-tooling.pbr-material+json";

const srgbImagePort = (id, label, required = true) => ({
  id,
  label,
  required,
  assetKinds: ["image"],
  mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE],
});

const linearImagePort = (id, label, required = true) => ({
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
      srgbImagePort("ambientOcclusion", "Ambient occlusion"),
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
      srgbImagePort("baseColor", "Base color", false),
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

export const TEXTURE_ORM_PACK_OPERATION = REGISTRY.get("texture.orm.pack", VERSION);
export const PBR_MATERIAL_BUNDLE_OPERATION = REGISTRY.get("material.pbr.bundle", VERSION);
export const MATERIAL_OPERATIONS = REGISTRY.list();

function assertRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("material operation root must be an absolute path");
  }
  return root;
}

function plainObject(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must be a plain object`);
  }
  return value;
}

function normalizeParameters(operation, value, inputs) {
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
  const hasNormal = Object.hasOwn(inputs, "normal");
  if (hasNormal) {
    if (!["positive", "negative"].includes(parameters.normalYAxis)) {
      throw new Error("material.pbr.bundle normalYAxis must be positive or negative when normal is present");
    }
    return { normalYAxis: parameters.normalYAxis };
  }
  if (parameters.normalYAxis !== undefined) {
    throw new Error("material.pbr.bundle normalYAxis is only valid when normal is present");
  }
  return {};
}

async function implementationIdentity(operation) {
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

async function readSrgb(root, asset) {
  return parseRgba8Image(await resolveAssetObject(root, asset));
}

async function readLinear(root, asset) {
  return parseLinearRgba8Image(await resolveAssetObject(root, asset));
}

function assertSameDimensions(images) {
  const [first, ...rest] = images;
  if (rest.some((image) => image.width !== first.width || image.height !== first.height)) {
    throw new Error("ORM source dimensions must exactly match");
  }
}

async function createBuildIdentity(root, operation, parameters, inputs) {
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
      ["ambientOcclusion", "roughness", "metallic"].map((id) => readSrgb(assetRoot, build.inputs[id])),
    );
    assertSameDimensions(images);
  } else {
    const ids = Object.keys(build.inputs);
    if (ids.length === 0) throw new Error("material.pbr.bundle requires at least one texture input");
    await Promise.all(
      ids.map((id) =>
        id === "orm" ? readLinear(assetRoot, build.inputs[id]) : readSrgb(assetRoot, build.inputs[id]),
      ),
    );
  }
  return build;
}

function packOrm(ambientOcclusion, roughness, metallic) {
  assertSameDimensions([ambientOcclusion, roughness, metallic]);
  const pixels = Buffer.alloc(ambientOcclusion.width * ambientOcclusion.height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = lumaRgba8(
      ambientOcclusion.pixels[offset],
      ambientOcclusion.pixels[offset + 1],
      ambientOcclusion.pixels[offset + 2],
    );
    pixels[offset + 1] = lumaRgba8(
      roughness.pixels[offset],
      roughness.pixels[offset + 1],
      roughness.pixels[offset + 2],
    );
    pixels[offset + 2] = lumaRgba8(
      metallic.pixels[offset],
      metallic.pixels[offset + 1],
      metallic.pixels[offset + 2],
    );
    pixels[offset + 3] = 255;
  }
  return { width: ambientOcclusion.width, height: ambientOcclusion.height, pixels };
}

function textureEntry(asset, image) {
  return {
    sha256: asset.sha256,
    byteLength: asset.byteLength,
    mediaType: asset.mediaType,
    width: image.width,
    height: image.height,
  };
}

export async function createTextureOrmPackOperationBuildIdentity(
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, TEXTURE_ORM_PACK_OPERATION, parameters, inputs);
}

export async function executeTextureOrmPackOperation(root, invocation = {}) {
  const assetRoot = assertRoot(root);
  const build = await createTextureOrmPackOperationBuildIdentity(assetRoot, invocation);
  const [ambientOcclusion, roughness, metallic] = await Promise.all(
    ["ambientOcclusion", "roughness", "metallic"].map((id) => readSrgb(assetRoot, build.inputs[id])),
  );
  const output = packOrm(ambientOcclusion, roughness, metallic);
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
      inputs: ["ambientOcclusion", "roughness", "metallic"].map((port) => ({
        port,
        sha256: build.inputs[port].sha256,
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
  root,
  { parameters = {}, inputs = {} } = {},
) {
  return createBuildIdentity(root, PBR_MATERIAL_BUNDLE_OPERATION, parameters, inputs);
}

export async function executePbrMaterialBundleOperation(root, invocation = {}) {
  const assetRoot = assertRoot(root);
  const build = await createPbrMaterialBundleOperationBuildIdentity(assetRoot, invocation);
  const textures = {};
  for (const [id, asset] of Object.entries(build.inputs)) {
    const image = id === "orm" ? await readLinear(assetRoot, asset) : await readSrgb(assetRoot, asset);
    textures[id] = textureEntry(asset, image);
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
      texturePorts: Object.keys(textures).sort(),
      inputs: Object.entries(build.inputs).map(([port, asset]) => ({ port, sha256: asset.sha256 })),
    },
  });
  return normalizeAssetOperationResult(PBR_MATERIAL_BUNDLE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      algorithm: build.implementation.algorithm,
      texturePorts: Object.keys(textures).sort(),
      conventions: document.conventions,
    },
  });
}
