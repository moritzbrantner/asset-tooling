import path from "node:path";
import { resolveAssetObject, storeAssetObject, verifyAssetObject } from "./asset-store.js";
import { normalizeGenerationResult } from "./backend-contract.js";
import { getBackend } from "./backends.js";
import { readGenerationCache, writeGenerationCache } from "./cache.js";
import { canonicalJson } from "./canonical.js";
import { captureEnvironment } from "./environment.js";
import { validateGltf } from "./gltf-processing.js";
import { sha256Bytes, sha256Text } from "./hash.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationRegistry,
  normalizeAssetOperationResult,
} from "./operations.js";
import {
  createStableFast3DMeshOperationBuildIdentity,
  createStableFast3DMeshOperationExecutor,
  STABLE_FAST_3D_MESH_OPERATION,
} from "./stable-fast-3d-operation.js";
import {
  createTrellis2MeshOperationBuildIdentity,
  createTrellis2MeshOperationExecutor,
  TRELLIS2_MESH_OPERATION,
} from "./trellis2-operation.js";
import {
  createTripoSRMeshOperationBuildIdentity,
  createTripoSRMeshOperationExecutor,
  TRIPOSR_MESH_OPERATION,
} from "./triposr-operation.js";

const OPERATION_ID = "mesh.image-to-3d.generate";
const OPERATION_VERSION = "1";
const IMPLEMENTATION_VERSION = "1";
const GLB_MEDIA_TYPE = "model/gltf-binary";
const MAX_VIEWS = 16;
const MAX_PROVIDER_ASSETS = 8;
const TOKEN_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEED_PATTERN = /^(0|[1-9][0-9]*)$/;
/** Immutable provider revisions are full commit digests (SHA-1 or SHA-256). */
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VIEWPOINTS = [
  "unspecified",
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
  "front-left",
  "front-right",
  "back-left",
  "back-right",
];
const QUALITIES = ["draft", "standard", "high"];
/** Ordered: a provider delivering `pbr` also satisfies `textured` and `geometry`. */
const MATERIAL_LEVELS = ["geometry", "textured", "pbr"];

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Image/multi-view to 3D",
    description:
      "Generate a validated GLB mesh from one or more ordered reference views through a selected local image-to-3D provider, recording provider/model identity and every conditioning input.",
    category: "model.mesh",
    inputs: [
      {
        id: "views",
        label: "Ordered reference views",
        assetKinds: ["image"],
        mediaTypes: ["image/png", "image/jpeg"],
        cardinality: { min: 1, max: MAX_VIEWS },
      },
      {
        id: "masks",
        label: "Per-view foreground masks",
        assetKinds: ["image"],
        mediaTypes: ["image/png"],
        cardinality: { min: 1, max: MAX_VIEWS },
        required: false,
      },
      {
        id: "provider-assets",
        label: "Provider model bundles in declared role order",
        assetKinds: ["model"],
        mediaTypes: ["application/zip"],
        cardinality: { min: 1, max: MAX_PROVIDER_ASSETS },
      },
    ],
    outputs: [
      {
        id: "output",
        label: "Validated GLB mesh",
        assetKinds: ["mesh"],
        mediaTypes: [GLB_MEDIA_TYPE],
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "views", "quality", "requirements"],
      properties: {
        provider: {
          type: "object",
          additionalProperties: false,
          required: ["id", "modelId", "modelRevision", "assets", "parameters"],
          properties: {
            id: { type: "string", enum: ["triposr", "stable-fast-3d", "trellis2"] },
            modelId: { type: "string", minLength: 1 },
            modelRevision: { type: "string", pattern: REVISION_PATTERN.source },
            assets: { type: "array", items: { type: "string", minLength: 1 } },
            parameters: { type: "object" },
          },
        },
        views: {
          type: "array",
          minItems: 1,
          maxItems: MAX_VIEWS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "viewpoint"],
            properties: {
              id: { type: "string", pattern: TOKEN_PATTERN.source },
              viewpoint: { type: "string", enum: VIEWPOINTS },
            },
          },
        },
        description: { type: "string", minLength: 1 },
        quality: { type: "string", enum: QUALITIES },
        requirements: {
          type: "object",
          additionalProperties: false,
          required: ["materials"],
          properties: {
            materials: { type: "string", enum: MATERIAL_LEVELS },
          },
        },
        seed: { type: "string", pattern: SEED_PATTERN.source },
      },
    },
  },
]);

export const IMAGE_TO_3D_OPERATION = OPERATION_REGISTRY.get(OPERATION_ID, OPERATION_VERSION);

/**
 * Local providers reuse the existing per-model operations unchanged. The
 * provider-neutral operation only maps its canonical request onto them.
 */
const PROVIDERS = Object.freeze({
  triposr: Object.freeze({
    id: "triposr",
    backend: { id: "model.triposr", version: "1" },
    operation: TRIPOSR_MESH_OPERATION,
    viewMediaTypes: ["image/png", "image/jpeg"],
    maxViews: 1,
    masks: false,
    materials: "geometry",
    seed: "none",
    assets: ["model"],
    reservedParameters: ["outputFormat"],
    createBuildIdentity: createTripoSRMeshOperationBuildIdentity,
    createExecutor: createTripoSRMeshOperationExecutor,
    invocation({ view, assets, parameters }) {
      return {
        parameters: { ...parameters, outputFormat: "glb" },
        inputs: { image: view, model: assets.model },
      };
    },
  }),
  "stable-fast-3d": Object.freeze({
    id: "stable-fast-3d",
    backend: { id: "model.stable-fast-3d", version: "1" },
    operation: STABLE_FAST_3D_MESH_OPERATION,
    viewMediaTypes: ["image/png"],
    maxViews: 1,
    masks: false,
    materials: "textured",
    seed: "none",
    assets: ["source", "model", "tokenizer"],
    reservedParameters: [],
    createBuildIdentity: createStableFast3DMeshOperationBuildIdentity,
    createExecutor: createStableFast3DMeshOperationExecutor,
    invocation({ view, assets, parameters }) {
      return {
        parameters,
        inputs: {
          image: view,
          source: assets.source,
          model: assets.model,
          tokenizer: assets.tokenizer,
        },
      };
    },
  }),
  trellis2: Object.freeze({
    id: "trellis2",
    backend: { id: "model.trellis2", version: "1" },
    operation: TRELLIS2_MESH_OPERATION,
    viewMediaTypes: ["image/png"],
    maxViews: 1,
    masks: false,
    materials: "pbr",
    seed: "required",
    assets: ["source", "model", "legacy-decoder", "image-encoder"],
    reservedParameters: ["seed"],
    createBuildIdentity: createTrellis2MeshOperationBuildIdentity,
    createExecutor: createTrellis2MeshOperationExecutor,
    invocation({ view, assets, parameters, seed }) {
      return {
        parameters: { ...parameters, seed },
        inputs: {
          image: view,
          source: assets.source,
          model: assets.model,
          "legacy-decoder": assets["legacy-decoder"],
          "image-encoder": assets["image-encoder"],
        },
      };
    },
  }),
});

/** Provider capabilities, for callers choosing a provider before building a request. */
export const IMAGE_TO_3D_PROVIDERS = Object.freeze(
  Object.values(PROVIDERS).map((provider) =>
    Object.freeze({
      id: provider.id,
      backend: Object.freeze({ ...provider.backend }),
      operation: Object.freeze({ id: provider.operation.id, version: provider.operation.version }),
      maxViews: provider.maxViews,
      viewMediaTypes: Object.freeze([...provider.viewMediaTypes]),
      masks: provider.masks,
      materials: provider.materials,
      seed: provider.seed,
      assets: Object.freeze([...provider.assets]),
    }),
  ),
);

function isObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be a plain object`);
  return value;
}

function assertExactKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${location} contains unknown field '${key}'`);
  }
}

function assertNonEmptyString(value, location) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function assertRevision(value, location) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new Error(
      `${location} must be an immutable 40- or 64-character lowercase commit digest, not a branch or tag`,
    );
  }
  return value;
}

function assertEnum(value, allowed, location) {
  if (!allowed.includes(value)) throw new Error(`${location} must be one of ${allowed.join(", ")}`);
  return value;
}

function normalizeParameters(value) {
  const location = `${OPERATION_ID} parameters`;
  const parameters = assertObject(value, location);
  assertExactKeys(
    parameters,
    ["provider", "views", "description", "quality", "requirements", "seed"],
    location,
  );

  const providerValue = assertObject(parameters.provider, `${location}.provider`);
  assertExactKeys(
    providerValue,
    ["id", "modelId", "modelRevision", "assets", "parameters"],
    `${location}.provider`,
  );
  const providerId = assertEnum(providerValue.id, Object.keys(PROVIDERS), `${location}.provider.id`);
  if (!Array.isArray(providerValue.assets)) {
    throw new Error(`${location}.provider.assets must be an array of role names`);
  }
  const provider = {
    id: providerId,
    modelId: assertNonEmptyString(providerValue.modelId, `${location}.provider.modelId`),
    modelRevision: assertRevision(
      providerValue.modelRevision,
      `${location}.provider.modelRevision`,
    ),
    assets: providerValue.assets.map((role, index) =>
      assertNonEmptyString(role, `${location}.provider.assets[${index}]`),
    ),
    parameters: JSON.parse(canonicalJson(assertObject(
      providerValue.parameters,
      `${location}.provider.parameters`,
    ))),
  };

  if (!Array.isArray(parameters.views) || parameters.views.length === 0) {
    throw new Error(`${location}.views must be a non-empty array`);
  }
  if (parameters.views.length > MAX_VIEWS) {
    throw new Error(`${location}.views must contain at most ${MAX_VIEWS} views`);
  }
  const viewIds = new Set();
  const views = parameters.views.map((entry, index) => {
    const viewLocation = `${location}.views[${index}]`;
    const view = assertObject(entry, viewLocation);
    assertExactKeys(view, ["id", "viewpoint"], viewLocation);
    if (typeof view.id !== "string" || !TOKEN_PATTERN.test(view.id)) {
      throw new Error(`${viewLocation}.id must be a lowercase dotted token`);
    }
    if (viewIds.has(view.id)) throw new Error(`${viewLocation}.id '${view.id}' is not unique`);
    viewIds.add(view.id);
    return {
      id: view.id,
      viewpoint: assertEnum(view.viewpoint, VIEWPOINTS, `${viewLocation}.viewpoint`),
    };
  });

  const requirementsValue = assertObject(parameters.requirements, `${location}.requirements`);
  assertExactKeys(requirementsValue, ["materials"], `${location}.requirements`);

  const result = {
    provider,
    views,
    quality: assertEnum(parameters.quality, QUALITIES, `${location}.quality`),
    requirements: {
      materials: assertEnum(
        requirementsValue.materials,
        MATERIAL_LEVELS,
        `${location}.requirements.materials`,
      ),
    },
  };
  if (parameters.description !== undefined) {
    result.description = assertNonEmptyString(parameters.description, `${location}.description`);
  }
  if (parameters.seed !== undefined) {
    if (typeof parameters.seed !== "string" || !SEED_PATTERN.test(parameters.seed)) {
      throw new Error(`${location}.seed must be a non-negative decimal integer string`);
    }
    result.seed = parameters.seed;
  }
  return result;
}

/** Fail closed on any request the selected provider cannot honor as stated. */
function assertProviderCapabilities(provider, parameters, inputs) {
  const location = `${OPERATION_ID} provider '${provider.id}'`;
  if (parameters.views.length !== inputs.views.length) {
    throw new Error(
      `${OPERATION_ID} parameters.views must describe each of the ${inputs.views.length} view inputs in order`,
    );
  }
  if (inputs.masks !== undefined && inputs.masks.length !== inputs.views.length) {
    throw new Error(`${OPERATION_ID} masks must correspond one-to-one with views`);
  }
  if (inputs.views.length > provider.maxViews) {
    throw new Error(
      `${location} accepts at most ${provider.maxViews} view(s); got ${inputs.views.length}`,
    );
  }
  for (const [index, view] of inputs.views.entries()) {
    if (!provider.viewMediaTypes.includes(view.mediaType)) {
      throw new Error(
        `${location} cannot read view ${index} as ${view.mediaType}; it accepts ${provider.viewMediaTypes.join(", ")}`,
      );
    }
  }
  if (inputs.masks !== undefined && !provider.masks) {
    throw new Error(`${location} does not accept separate masks; prepare the view instead`);
  }
  if (
    MATERIAL_LEVELS.indexOf(parameters.requirements.materials) >
    MATERIAL_LEVELS.indexOf(provider.materials)
  ) {
    throw new Error(
      `${location} delivers ${provider.materials} output, not the required ${parameters.requirements.materials}`,
    );
  }
  if (provider.seed === "none" && parameters.seed !== undefined) {
    throw new Error(`${location} has no user-controlled seed`);
  }
  if (provider.seed === "required" && parameters.seed === undefined) {
    throw new Error(`${location} requires parameters.seed`);
  }
  if (canonicalJson(parameters.provider.assets) !== canonicalJson(provider.assets)) {
    throw new Error(
      `${location} requires provider.assets to be [${provider.assets.join(", ")}] in that order`,
    );
  }
  if (inputs["provider-assets"].length !== provider.assets.length) {
    throw new Error(
      `${location} requires ${provider.assets.length} provider-assets in provider.assets order`,
    );
  }
  for (const key of provider.reservedParameters) {
    if (Object.hasOwn(parameters.provider.parameters, key)) {
      throw new Error(`${location} sets provider parameter '${key}' from the canonical request`);
    }
  }
}

function assertAssetRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(`${OPERATION_ID} root must be an absolute path`);
  }
  return root;
}

function resolveBackend(provider, backends) {
  const backend = backends?.[provider.id] ?? getBackend(provider.backend);
  if (typeof backend?.exactCapable !== "boolean") {
    throw new Error(`${provider.backend.id} backend must declare exactCapable`);
  }
  return backend;
}

async function prepare(root, { parameters = {}, inputs = {} } = {}, backends) {
  assertAssetRoot(root);
  const normalizedParameters = normalizeParameters(parameters);
  const provider = PROVIDERS[normalizedParameters.provider.id];
  const request = createAssetOperationBuildIdentity({
    operation: IMAGE_TO_3D_OPERATION,
    implementation: { id: `image-to-3d.${provider.id}`, version: IMPLEMENTATION_VERSION },
    parameters: normalizedParameters,
    inputs,
  });
  assertProviderCapabilities(provider, normalizedParameters, request.inputs);

  const backend = resolveBackend(provider, backends);
  const assets = Object.fromEntries(
    provider.assets.map((role, index) => [role, request.inputs["provider-assets"][index]]),
  );
  const delegatedInvocation = provider.invocation({
    view: request.inputs.views[0],
    assets,
    parameters: normalizedParameters.provider.parameters,
    seed: normalizedParameters.seed,
  });
  const delegated = await provider.createBuildIdentity(root, delegatedInvocation, backend);
  // Exactness is earned by replay, never by capability: an exact-capable
  // backend's first output is only a candidate for exact verification.
  const reproducibility = backend.exactCapable ? "unverified-exact-capable" : "approximate";
  const identity = createAssetOperationBuildIdentity({
    operation: IMAGE_TO_3D_OPERATION,
    implementation: {
      id: `image-to-3d.${provider.id}`,
      version: IMPLEMENTATION_VERSION,
      reproducibility,
      provider: {
        id: provider.id,
        modelId: normalizedParameters.provider.modelId,
        modelRevision: normalizedParameters.provider.modelRevision,
      },
      delegated: {
        operation: delegated.operation,
        implementation: delegated.implementation,
      },
    },
    parameters: request.parameters,
    inputs: request.inputs,
  });
  return {
    identity,
    provider,
    backend,
    delegatedInvocation,
    reproducibility,
    parameters: normalizedParameters,
  };
}

export async function createImageTo3DOperationBuildIdentity(root, invocation = {}, { backends } = {}) {
  return (await prepare(root, invocation, backends)).identity;
}

function provenanceMetadata(identity, provider, reproducibility, validationWarnings) {
  const { parameters, inputs } = identity;
  return {
    operation: identity.operation,
    provider: {
      id: provider.id,
      modelId: parameters.provider.modelId,
      modelRevision: parameters.provider.modelRevision,
      backend: provider.backend,
      operation: { id: provider.operation.id, version: provider.operation.version },
      parameters: parameters.provider.parameters,
      assets: provider.assets.map((role, index) => ({
        role,
        sha256: inputs["provider-assets"][index].sha256,
      })),
    },
    reproducibility,
    views: parameters.views.map((view, index) => ({
      index,
      id: view.id,
      viewpoint: view.viewpoint,
      sha256: inputs.views[index].sha256,
      mediaType: inputs.views[index].mediaType,
      ...(inputs.masks ? { maskSha256: inputs.masks[index].sha256 } : {}),
    })),
    ...(parameters.description === undefined ? {} : { description: parameters.description }),
    quality: parameters.quality,
    requirements: parameters.requirements,
    ...(parameters.seed === undefined ? {} : { seed: parameters.seed }),
    validation: { profile: "khronos-gltf-validator", warnings: validationWarnings },
  };
}

function glbJson(bytes, location) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(16) !== 0x4e4f534a) {
    throw new Error(`${location} is not a GLB with a leading JSON chunk`);
  }
  const length = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + length).toString("utf8"));
}

/** The material level a GLB actually delivers, from its glTF JSON. */
export function glbMaterialLevel(bytes, location = "GLB") {
  const json = glbJson(bytes, location);
  const hasGeometry = (json.meshes ?? []).some((mesh) =>
    (mesh.primitives ?? []).some((primitive) => primitive.attributes?.POSITION !== undefined),
  );
  if (!hasGeometry) return "none";
  // Only materials assigned to rendered geometry count; unused materials do not.
  const materials = json.materials ?? [];
  const levels = (json.meshes ?? []).flatMap((mesh) =>
    (mesh.primitives ?? [])
      .filter((primitive) => primitive.attributes?.POSITION !== undefined)
      .map((primitive) => {
        const pbr = materials[primitive.material]?.pbrMetallicRoughness;
        if (pbr?.baseColorTexture === undefined) return "geometry";
        return pbr.metallicRoughnessTexture === undefined ? "textured" : "pbr";
      }),
  );
  // Every rendered primitive must meet the level, so report the weakest.
  return levels.reduce((weakest, level) =>
    MATERIAL_LEVELS.indexOf(level) < MATERIAL_LEVELS.indexOf(weakest) ? level : weakest,
  );
}

/** Khronos validation plus the requested material level, before any storage. */
async function validateGeneratedGlb(bytes, location, requiredMaterials) {
  const warnings = await validateGltf(new Uint8Array(bytes), "glb", {}, location);
  const delivered = glbMaterialLevel(bytes, location);
  if (MATERIAL_LEVELS.indexOf(delivered) < MATERIAL_LEVELS.indexOf(requiredMaterials)) {
    throw new Error(`${location} delivers ${delivered} output, not the required ${requiredMaterials}`);
  }
  return warnings;
}

/**
 * The delegated operation re-fingerprints its runtime and stores the raw
 * output. This wrapper fails if that runtime differs from the prepared build
 * identity, and validates generated bytes before the delegate can store them.
 */
function guardedBackend(backend, environmentSha256, location, requiredMaterials) {
  return {
    id: backend.id,
    version: backend.version,
    kind: backend.kind,
    exactCapable: backend.exactCapable,
    validate: (document) => backend.validate(document),
    async environmentComponents(document) {
      const components = await backend.environmentComponents(document);
      const environment = await captureEnvironment(components);
      if (environment.sha256 !== environmentSha256) {
        throw new Error(`${location} runtime changed after the build identity was prepared`);
      }
      return components;
    },
    async generate(document) {
      const generated = normalizeGenerationResult(await backend.generate(document), backend.id);
      await validateGeneratedGlb(generated.bytes, location, requiredMaterials);
      return generated;
    },
  };
}

/**
 * Create the provider-neutral executor. `backends` overrides the registered
 * backend per provider id (for tests or alternate runtimes); `cache: false`
 * bypasses the verified generation cache.
 */
export function createImageTo3DOperationExecutor({ backends, cache = true } = {}) {
  return async function executeImageTo3DOperation(root, invocation = {}) {
    const { identity, provider, backend, delegatedInvocation, reproducibility, parameters } = await prepare(
      root,
      invocation,
      backends,
    );
    // Declared dependencies are verified before any cache lookup.
    for (const value of Object.values(identity.inputs)) {
      for (const asset of Array.isArray(value) ? value : [value]) {
        await verifyAssetObject(root, asset);
      }
    }
    const cacheIdentity = {
      schemaVersion: 1,
      specSha256: sha256Text(canonicalJson(identity)),
      tool: identity.implementation.delegated.implementation.tool,
      generator: { id: backend.id, version: backend.version, kind: backend.kind },
      environmentSha256: identity.implementation.delegated.implementation.environment.sha256,
    };

    const cached = cache ? await readGenerationCache(root, cacheIdentity) : { status: "miss" };
    let bytes;
    let observations;
    if (cached.status === "hit") {
      bytes = cached.bytes;
      observations = cached.observations;
    } else {
      const guarded = guardedBackend(
        backend,
        identity.implementation.delegated.implementation.environment.sha256,
        `${OPERATION_ID} ${provider.id} output`,
        parameters.requirements.materials,
      );
      const delegatedResult = await provider.createExecutor(guarded)(root, delegatedInvocation);
      const output = delegatedResult.outputs.output;
      if (output.mediaType !== GLB_MEDIA_TYPE) {
        throw new Error(`${provider.operation.id} returned ${output.mediaType}, not a GLB`);
      }
      bytes = await resolveAssetObject(root, output);
      observations = delegatedResult.observations;
    }

    const warnings = await validateGeneratedGlb(
      bytes,
      `${OPERATION_ID} ${provider.id} output`,
      parameters.requirements.materials,
    );
    if (cache && cached.status !== "hit") {
      await writeGenerationCache(root, cacheIdentity, { bytes, observations });
    }

    const stored = await storeAssetObject(root, {
      bytes,
      kind: "mesh",
      mediaType: GLB_MEDIA_TYPE,
      metadata: provenanceMetadata(identity, provider, reproducibility, warnings.length),
    });

    return normalizeAssetOperationResult(IMAGE_TO_3D_OPERATION, {
      outputs: { output: stored.asset },
      observations: {
        cache: cached.status,
        buildSha256: cacheIdentity.specSha256,
        outputSha256: sha256Bytes(bytes),
        reproducibility,
        validationWarnings: warnings,
        provider: observations,
      },
    });
  };
}

export const executeImageTo3DOperation = createImageTo3DOperationExecutor();
