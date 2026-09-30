/// <reference path="./gltf-validator.d.ts" />
import { NodeIO, type Document, type GLTF, type JSONDocument } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { resolveAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";
import { createAssetOperationBuildIdentity, type AssetRef, type ReadonlyAssetOperationDescriptor } from "./operations.js";
const GLB_MEDIA_TYPE = "model/gltf-binary";
const PROFILE = "gltf-core-static-v1";

export function portableGltfUri(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
    || value.split("/").some((part) => part === "." || part === "..")
    || ["__proto__", "constructor", "prototype"].includes(value)) {
    throw new Error(`glTF resource URI '${String(value)}' must be a portable relative path`);
  }
  return value;
}

function single(value: AssetRef | AssetRef[] | undefined): AssetRef {
  if (!value || Array.isArray(value)) throw new Error("scene.import.gltf source must be a single AssetRef");
  return value;
}

export async function checkedGltfInputs(root: string, operation: ReadonlyAssetOperationDescriptor, normalizedParameters: { resourceUris: string[] }, inputs: unknown) {
  const identity = createAssetOperationBuildIdentity({
    operation,
    implementation: { id: "gltf-transform-static-import", version: "1" },
    parameters: normalizedParameters,
    inputs,
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

export async function validateGltf(bytes: Uint8Array, format: "gltf" | "glb", resources: Record<string, Uint8Array>, location: string, allowedWarnings: readonly string[] = []) {
  const report = await validateBytes(bytes, {
    format, writeTimestamp: false, maxIssues: 100,
    externalResourceFunction: async (uri) => {
      const bytes = resources[portableGltfUri(uri)];
      if (!bytes) throw new Error(`missing glTF resource '${uri}'`);
      return bytes;
    },
  });
  const failures = report.issues.messages.filter((issue) => issue.severity === 0 || (issue.severity === 1 && !allowedWarnings.includes(issue.code)));
  if (report.issues.numErrors || failures.length || report.issues.truncated) {
    throw new Error(`${location} failed Khronos validation: ${failures.map((issue) => `${issue.pointer ?? "/"}: ${issue.code}: ${issue.message}`).join("; ")}`);
  }
  return report.issues.messages.filter((issue) => issue.severity === 1).map((issue) => ({
    code: issue.code, path: issue.pointer ?? "/", message: issue.message,
  }));
}

function supportedPolicy(json: GLTF.IGLTF, allowRigged: boolean) {
  const profile = allowRigged ? "gltf-core-production-v1" : PROFILE;
  // A capability policy over the authoritative parser's document, not a format decoder.
  if (!allowRigged && (json.skins?.length || json.animations?.length || json.nodes?.some((node) => node.skin !== undefined))) {
    throw new Error(`${PROFILE} does not support skins or animations`);
  }
  if ((json.buffers?.length ?? 0) > 1) throw new Error(`${profile} supports one buffer`);
  if (!json.scenes?.length || !json.nodes?.length || !json.meshes?.length) {
    throw new Error(`${profile} requires a scene with mesh geometry`);
  }
  function inspectExtensions(value: unknown, location: string): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspectExtensions(entry, `${location}/${index}`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if ((key === "extensions" && typeof child === "object" && child !== null && Object.keys(child).length)
          || ((key === "extensionsUsed" || key === "extensionsRequired") && Array.isArray(child) && child.length)) {
          throw new Error(`${profile} contains unsupported extensions at ${location}/${key}`);
        }
        if (key !== "extras") inspectExtensions(child, `${location}/${key}`);
      }
    }
  }
  inspectExtensions(json, "");
  for (const [meshIndex, mesh] of (json.meshes ?? []).entries()) {
    for (const [index, primitive] of mesh.primitives.entries()) {
      if ((primitive.mode ?? 4) !== 4 || primitive.targets?.length) {
        throw new Error(`${profile} requires non-morph triangles at /meshes/${meshIndex}/primitives/${index}`);
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
    portableGltfUri(uri);
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

export function gltfSummary(document: Document) {
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

export async function loadCheckedGltf(
  root: string, operation: ReadonlyAssetOperationDescriptor,
  normalizedParameters: { resourceUris: string[] }, inputs: unknown, allowRigged: boolean,
  allowedWarnings: readonly string[] = [],
) {
  const checked = await checkedGltfInputs(root, operation, normalizedParameters, inputs);
  const { source, sourceBytes, resourceBytes } = checked;
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
            portableGltfUri(entry.uri);
          }
        }
      }
    }
  }
  const validatorWarnings = await validateGltf(sourceBytes, format, resourceBytes, "scene.import.gltf source", allowedWarnings);
  supportedPolicy(jsonDocument.json, allowRigged);
  const inventory = resourceInventory(jsonDocument.json, resourceBytes, format === "glb" ? jsonDocument.resources : Object.create(null));
  const document = await io.readJSON(jsonDocument);
  return { ...checked, document, io, inventory, validatorWarnings };
}
