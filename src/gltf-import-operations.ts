/// <reference path="./gltf-validator.d.ts" />
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { VERSION } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import { storeAssetObject } from "./asset-store.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationDescriptor,
  normalizeAssetOperationResult,
  type AssetOperationBuildIdentity,
  type AssetOperationResult,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const GLB_MEDIA_TYPE = "model/gltf-binary";
const GLTF_MEDIA_TYPE = "model/gltf+json";
const PROFILE = "gltf-core-static-v1";
type Invocation = { parameters?: unknown; inputs?: unknown };

export const GLTF_IMPORT_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1,
  id: "scene.import.gltf",
  version: "1",
  label: "Import static glTF with materials",
  description: "Validate and package core glTF 2.0 static geometry, hierarchy and PBR resources as a self-contained GLB through glTF Transform and the Khronos validator.",
  category: "scene.processing",
  inputs: [
    { id: "source", assetKinds: ["scene", "mesh"], mediaTypes: [GLB_MEDIA_TYPE, GLTF_MEDIA_TYPE] },
    { id: "resources", assetKinds: [], mediaTypes: [], cardinality: { min: 0, max: 1024 }, required: false },
  ],
  outputs: [{ id: "output", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] }],
  parameterSchema: {
    type: "object", additionalProperties: false,
    properties: { resourceUris: { type: "array", maxItems: 1024, uniqueItems: true, items: { type: "string" } } },
  },
});

import { checkedGltfInputs, gltfSummary, loadCheckedGltf, portableGltfUri, validateGltf } from "./gltf-processing.js";

function parameters(value: unknown): { resourceUris: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("scene.import.gltf parameters must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "resourceUris") throw new Error(`scene.import.gltf parameters contains unknown field '${key}'`);
  }
  const uris: unknown = "resourceUris" in value ? value.resourceUris : [];
  if (!Array.isArray(uris) || uris.length > 1024) throw new Error("resourceUris must contain at most 1024 URIs");
  const resourceUris = uris.map(portableGltfUri);
  if (new Set(resourceUris).size !== resourceUris.length) throw new Error("resourceUris contains duplicate URIs");
  return { resourceUris };
}

export async function createGltfImportOperationBuildIdentity(
  root: string, invocation: Invocation = {},
): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedGltfInputs(root, GLTF_IMPORT_OPERATION, parameters(invocation.parameters ?? {}), invocation.inputs ?? {});
  return createAssetOperationBuildIdentity({
    operation: GLTF_IMPORT_OPERATION,
    implementation: {
      id: "gltf-transform-static-import", version: "1",
      gltfTransform: VERSION, validator: validatorVersion(),
      dependencyLockSha256: await readDependencyLockSha256(),
      assetTooling: await captureToolIdentity(),
    },
    parameters: identity.parameters, inputs: identity.inputs,
  });
}

export async function executeGltfImportOperation(
  root: string, invocation: Invocation = {},
): Promise<AssetOperationResult> {
  const { source, resources, io, document, inventory } = await loadCheckedGltf(
    root, GLTF_IMPORT_OPERATION, parameters(invocation.parameters ?? {}), invocation.inputs ?? {}, false,
  );
  const observations = {
    profile: PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
    normalization: "core-gltf-to-self-contained-glb",
    ...gltfSummary(document), resources: inventory,
    gltfTransform: VERSION, validator: validatorVersion(),
  };
  const bytes = await io.writeBinary(document);
  await validateGltf(bytes, "glb", Object.create(null), "scene.import.gltf output");
  const stored = await storeAssetObject(root, {
    bytes, kind: "scene", mediaType: GLB_MEDIA_TYPE,
    metadata: {
      profile: PROFILE, operation: "scene.import.gltf", sourceSha256: source.sha256,
      resourceSha256s: resources.map((resource) => resource.sha256),
      coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  return normalizeAssetOperationResult(GLTF_IMPORT_OPERATION, { outputs: { output: stored.asset }, observations });
}
