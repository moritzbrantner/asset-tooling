/// <reference path="./gltf-validator.d.ts" />
import { NodeIO, VERSION, type Document, type GLTF, type JSONDocument } from "@gltf-transform/core";
import { validateBytes, version as validatorVersion } from "gltf-validator";
import { readFile } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationDescriptor,
  normalizeAssetOperationResult,
  type AssetOperationBuildIdentity,
  type AssetOperationResult,
  type AssetRef,
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

function portableUri(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
    || value.split("/").some((part) => part === "." || part === "..")
    || ["__proto__", "constructor", "prototype"].includes(value)) {
    throw new Error(`glTF resource URI '${String(value)}' must be a portable relative path`);
  }
  return value;
}

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
  const resourceUris = uris.map(portableUri);
  if (new Set(resourceUris).size !== resourceUris.length) throw new Error("resourceUris contains duplicate URIs");
  return { resourceUris };
}

function single(value: AssetRef | AssetRef[] | undefined): AssetRef {
  if (!value || Array.isArray(value)) throw new Error("scene.import.gltf source must be a single AssetRef");
  return value;
}

async function checkedInputs(root: string, invocation: Invocation) {
  const normalizedParameters = parameters(invocation.parameters ?? {});
  const identity = createAssetOperationBuildIdentity({
    operation: GLTF_IMPORT_OPERATION,
    implementation: { id: "gltf-transform-static-import", version: "1" },
    parameters: normalizedParameters,
    inputs: invocation.inputs ?? {},
  });
  const source = single(identity.inputs.source);
  const resources = identity.inputs.resources ?? [];
  if (!Array.isArray(resources) || resources.length !== normalizedParameters.resourceUris.length) {
    throw new Error("resourceUris must correspond one-to-one to the resources input");
  }
  const sourceBytes = await resolveAssetObject(root, source);
  const resourceBytes: JSONDocument["resources"] = Object.create(null);
  for (const [index, resource] of resources.entries()) {
    resourceBytes[normalizedParameters.resourceUris[index]!] = new Uint8Array(await resolveAssetObject(root, resource));
  }
  return { identity, source, sourceBytes, resources, resourceBytes };
}

export async function createGltfImportOperationBuildIdentity(
  root: string, invocation: Invocation = {},
): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedInputs(root, invocation);
  return createAssetOperationBuildIdentity({
    operation: GLTF_IMPORT_OPERATION,
    implementation: {
      id: "gltf-transform-static-import", version: "1",
      gltfTransform: VERSION, validator: validatorVersion(),
      dependencyLockSha256: sha256Bytes(await readFile(new URL("../bun.lock", import.meta.url))),
      assetTooling: await captureToolIdentity(),
    },
    parameters: identity.parameters, inputs: identity.inputs,
  });
}

async function validate(bytes: Uint8Array, format: "gltf" | "glb", resources: Record<string, Uint8Array>, location: string) {
  const report = await validateBytes(bytes, {
    format, writeTimestamp: false, maxIssues: 100,
    externalResourceFunction: async (uri) => {
      const bytes = resources[portableUri(uri)];
      if (!bytes) throw new Error(`missing glTF resource '${uri}'`);
      return bytes;
    },
  });
  if (report.issues.numErrors || report.issues.numWarnings || report.issues.truncated) {
    const failures = report.issues.messages.filter((issue) => issue.severity <= 1);
    throw new Error(`${location} failed Khronos validation: ${failures.map((issue) => `${issue.pointer ?? "/"}: ${issue.code}: ${issue.message}`).join("; ")}`);
  }
}

function staticPolicy(json: GLTF.IGLTF) {
  // A capability policy over the authoritative parser's document, not a format decoder.
  if (json.skins?.length || json.animations?.length || json.nodes?.some((node) => node.skin !== undefined)) {
    throw new Error(`${PROFILE} does not support skins or animations`);
  }
  if ((json.buffers?.length ?? 0) > 1) throw new Error(`${PROFILE} supports one buffer`);
  if (!json.scenes?.length || !json.nodes?.length || !json.meshes?.length) {
    throw new Error(`${PROFILE} requires a scene with mesh geometry`);
  }
  function inspectExtensions(value: unknown, location: string): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspectExtensions(entry, `${location}/${index}`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if ((key === "extensions" && typeof child === "object" && child !== null && Object.keys(child).length)
          || ((key === "extensionsUsed" || key === "extensionsRequired") && Array.isArray(child) && child.length)) {
          throw new Error(`${PROFILE} contains unsupported extensions at ${location}/${key}`);
        }
        if (key !== "extras") inspectExtensions(child, `${location}/${key}`);
      }
    }
  }
  inspectExtensions(json, "");
  for (const [meshIndex, mesh] of (json.meshes ?? []).entries()) {
    for (const [index, primitive] of mesh.primitives.entries()) {
      if ((primitive.mode ?? 4) !== 4 || primitive.targets?.length) {
        throw new Error(`${PROFILE} requires static triangles at /meshes/${meshIndex}/primitives/${index}`);
      }
    }
  }
}

function resourceInventory(json: GLTF.IGLTF, supplied: Record<string, Uint8Array>, embedded: Record<string, Uint8Array>) {
  const required = new Set<string>();
  const entries = [
    ...(json.buffers ?? []).map((resource, index) => ({ resource, index, kind: "buffer" })),
    ...(json.images ?? []).map((resource, index) => ({ resource, index, kind: "image" })),
  ];
  const inventory = entries.map(({ resource, index, kind }) => {
    const uri = resource.uri;
    if (uri === undefined || Object.hasOwn(embedded, uri)) return { kind, index, storage: "embedded" };
    if (uri.startsWith("data:")) return { kind, index, storage: "data-uri" };
    portableUri(uri);
    const bytes = supplied[uri];
    if (!bytes) throw new Error(`missing glTF resource '${uri}'`);
    required.add(uri);
    return { kind, index, storage: "external", uri, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
  });
  for (const uri of Object.keys(supplied)) {
    if (!required.has(uri)) throw new Error(`unused glTF resource binding '${uri}'`);
  }
  return inventory;
}

function summary(document: Document) {
  const root = document.getRoot();
  let triangleCount = 0;
  let vertexCount = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      vertexCount += primitive.getAttribute("POSITION")!.getCount();
      triangleCount += (primitive.getIndices() ?? primitive.getAttribute("POSITION"))!.getCount() / 3;
    }
  }
  return {
    nodeCount: root.listNodes().length, meshCount: root.listMeshes().length,
    materialCount: root.listMaterials().length, textureCount: root.listTextures().length,
    vertexCount, triangleCount,
  };
}

export async function executeGltfImportOperation(
  root: string, invocation: Invocation = {},
): Promise<AssetOperationResult> {
  const { source, sourceBytes, resources, resourceBytes } = await checkedInputs(root, invocation);
  const io = new NodeIO().setAllowNetwork(false).setStrictResources(true);
  const format = source.mediaType === GLB_MEDIA_TYPE ? "glb" : "gltf";
  // GLB external resources are deliberately unsupported by the public in-memory decoder.
  const jsonDocument: JSONDocument = format === "glb"
    ? await io.binaryToJSON(sourceBytes)
    : { json: JSON.parse(sourceBytes.toString("utf8")), resources: resourceBytes };
  // Check original URIs before the validator canonicalizes/decodes them for its callback.
  // Raw JSON is still untrusted here; only inspect fields whose shape has been checked.
  const raw: unknown = jsonDocument.json;
  if (typeof raw === "object" && raw !== null) {
    for (const [key, entries] of Object.entries(raw)) {
      if (key !== "buffers" && key !== "images") continue;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry === "object" && entry !== null && "uri" in entry) {
          if (typeof entry.uri !== "string" || (!entry.uri.startsWith("data:") && !Object.hasOwn(jsonDocument.resources, entry.uri))) {
            portableUri(entry.uri);
          }
        }
      }
    }
  }
  await validate(sourceBytes, format, resourceBytes, "scene.import.gltf source");
  staticPolicy(jsonDocument.json);
  const inventory = resourceInventory(jsonDocument.json, resourceBytes, format === "glb" ? jsonDocument.resources : Object.create(null));
  const document = await io.readJSON(jsonDocument);
  const observations = {
    profile: PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
    normalization: "core-gltf-to-self-contained-glb",
    ...summary(document), resources: inventory,
    gltfTransform: VERSION, validator: validatorVersion(),
  };
  const bytes = await io.writeBinary(document);
  await validate(bytes, "glb", Object.create(null), "scene.import.gltf output");
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
