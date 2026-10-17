/// <reference path="./gltf-validator.d.ts" />
/**
 * `scene.place.gltf@1`: place an imported GLB by wrapping its scene roots in one named parent node
 * with an exact translation; vertices are not baked (#118, owner decision Q3, 2026-10-14). The
 * routine default anchor puts the origin at the base centre of the footprint. See docs/gltf-place.md.
 */
import { VERSION, type Document, type Node } from "@gltf-transform/core";
import { version as validatorVersion } from "gltf-validator";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { readDependencyLockSha256 } from "./dependency-lock.js";
import { PRODUCTION_SUPERSEDED_VALIDATOR_CODES, gltfSummary, parseCheckedGltfBytes, validateGltf } from "./gltf-processing.js";
import { GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS, GLTF_WEIGHT_SUM_POLICY, checkWeightSums } from "./gltf-production-operations.js";
import { sha256Bytes } from "./hash.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationDescriptor, normalizeAssetOperationResult,
  type AssetOperationBuildIdentity, type AssetOperationResult, type AssetRef,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

const GLB_MEDIA_TYPE = "model/gltf-binary";
const PROFILE = "gltf-place-v1";
const IMPLEMENTATION = { id: "gltf-transform-place", version: "1" };
/** The one anchor: translation = −(centre X, min Y, centre Z) of the scene's world-space rest bounds. */
export const GLTF_PLACE_ANCHORS: readonly string[] = Object.freeze(["footprint-base-center"]);
type Vec3 = [number, number, number];
type Invocation = { parameters?: unknown; inputs?: unknown };
type Policy = { allowedValidatorWarnings: string[] };
type Parameters = { parentName: string; translation?: Vec3; anchor?: string; sourcePivot?: { node: string }; policy: Policy };

export const GLTF_PLACE_OPERATION = createAssetOperationDescriptor({
  schemaVersion: 1, id: "scene.place.gltf", version: "1",
  label: "Place glTF under a parent node", category: "scene.processing",
  description: "Wrap every scene root of a GLB in one new named parent node with an exact or footprint-anchored translation; vertex and accessor bytes are unchanged.",
  inputs: [{ id: "source", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] }],
  outputs: [{ id: "output", assetKinds: ["scene"], mediaTypes: [GLB_MEDIA_TYPE] }],
  parameterSchema: {
    type: "object", additionalProperties: false, required: ["parentName"],
    oneOf: [{ required: ["translation"] }, { required: ["anchor"] }],
    properties: {
      parentName: { type: "string", minLength: 1 },
      translation: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } },
      anchor: { enum: [...GLTF_PLACE_ANCHORS] },
      sourcePivot: {
        type: "object", additionalProperties: false, required: ["node"],
        properties: { node: { type: "string", minLength: 1 } },
      },
      policy: {
        type: "object", additionalProperties: false,
        properties: {
          allowedValidatorWarnings: {
            type: "array", uniqueItems: true, maxItems: GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.length,
            items: { enum: [...GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS] },
          },
        },
      },
    },
  },
});

function plainObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${location} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

/** −0 becomes 0 so equal placements have one canonical identity. */
const canonicalZero = (value: number) => value + 0;

function normalizeParameters(value: unknown): Parameters {
  const input = plainObject(value, "glTF place parameters");
  for (const key of Object.keys(input)) {
    if (!["parentName", "translation", "anchor", "sourcePivot", "policy"].includes(key)) throw new Error(`unknown glTF place parameter '${key}'`);
  }
  if (typeof input.parentName !== "string" || !input.parentName) throw new Error("parentName must be a non-empty string");
  const parameters: Parameters = { parentName: input.parentName, policy: { allowedValidatorWarnings: [] } };
  if ((input.translation === undefined) === (input.anchor === undefined)) throw new Error("glTF place needs exactly one of translation or anchor");
  if (input.translation !== undefined) {
    const t = input.translation;
    if (!Array.isArray(t) || t.length !== 3 || t.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
      throw new Error("translation must be three finite numbers [x, y, z]");
    }
    parameters.translation = t.map(canonicalZero) as Vec3;
  } else {
    if (typeof input.anchor !== "string" || !GLTF_PLACE_ANCHORS.includes(input.anchor)) throw new Error(`anchor must be one of ${GLTF_PLACE_ANCHORS.join(", ")}`);
    parameters.anchor = input.anchor;
  }
  if (input.sourcePivot !== undefined) {
    const pivot = plainObject(input.sourcePivot, "sourcePivot");
    for (const key of Object.keys(pivot)) if (key !== "node") throw new Error(`unknown sourcePivot field '${key}'`);
    if (typeof pivot.node !== "string" || !pivot.node) throw new Error("sourcePivot.node must be a non-empty node name");
    parameters.sourcePivot = { node: pivot.node };
  }
  const policy = plainObject(input.policy ?? {}, "glTF place policy");
  for (const key of Object.keys(policy)) if (key !== "allowedValidatorWarnings") throw new Error(`unknown glTF place policy field '${key}'`);
  const warnings = policy.allowedValidatorWarnings ?? [];
  if (!Array.isArray(warnings) || warnings.some((code) => !GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.includes(code))) {
    throw new Error(`allowedValidatorWarnings only supports ${GLTF_PRODUCTION_ALLOWED_VALIDATOR_WARNINGS.join(" and ")}`);
  }
  if (new Set(warnings).size !== warnings.length) throw new Error("duplicate allowedValidatorWarnings");
  parameters.policy = { allowedValidatorWarnings: [...warnings] };
  return parameters;
}

/** Normalized parameters and the source input, its bytes rechecked against the pin. */
async function checkedInputs(root: string, invocation: Invocation) {
  const parameters = normalizeParameters(invocation.parameters ?? {});
  const identity = createAssetOperationBuildIdentity({
    operation: GLTF_PLACE_OPERATION, implementation: IMPLEMENTATION, parameters, inputs: invocation.inputs ?? {},
  });
  const asset = identity.inputs.source as AssetRef;
  const bytes = await resolveAssetObject(root, asset);
  if (bytes.byteLength !== asset.byteLength || sha256Bytes(bytes) !== asset.sha256) throw new Error("glTF bytes do not match the declared input pin");
  return { parameters, identity, source: { asset, bytes } };
}

export async function createGltfPlaceOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  const { identity } = await checkedInputs(root, invocation);
  return createAssetOperationBuildIdentity({
    operation: GLTF_PLACE_OPERATION, parameters: identity.parameters, inputs: identity.inputs,
    implementation: {
      ...IMPLEMENTATION, gltfTransform: VERSION, validator: validatorVersion(),
      policies: { weightSum: GLTF_WEIGHT_SUM_POLICY, supersededValidatorCodes: PRODUCTION_SUPERSEDED_VALIDATOR_CODES, skinnedBounds: "rest-pose-joint-world-times-inverse-bind" },
      dependencyLockSha256: await readDependencyLockSha256(),
      assetTooling: await captureToolIdentity(),
    },
  });
}

type Mat4 = ArrayLike<number>;
/** Column-major 4x4 product a·b. */
function multiply(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

type Bounds = { min: Vec3; max: Vec3 };

/**
 * World-space rest bounds of every mesh instance reachable from the scene, from POSITION accessors.
 * A static mesh uses its node's world matrix. A skinned mesh ignores its node transform (glTF) and
 * uses Σ weight · jointWorld · inverseBind, which is the bind-pose position when the rest pose is the
 * bind pose, and also follows the joints once they are reparented.
 */
function sceneBounds(document: Document): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const include = (x: number, y: number, z: number) => {
    const point = [x, y, z];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  };
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;
  const nodes: Node[] = [];
  scene.traverse((node) => { if (node.getMesh()) nodes.push(node); });
  const position: number[] = [], joint: number[] = [], weight: number[] = [], ibm: number[] = [];
  for (const node of nodes) {
    const skin = node.getSkin();
    let skinMatrices: number[][] | null = null;
    if (skin) {
      const inverseBinds = skin.getInverseBindMatrices();
      skinMatrices = skin.listJoints().map((jointNode, index) => {
        if (inverseBinds) inverseBinds.getElement(index, ibm);
        return multiply(jointNode.getWorldMatrix(), inverseBinds ? ibm : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      });
    }
    const world = node.getWorldMatrix();
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION")!;
      const weightSets = skinMatrices
        ? primitive.listSemantics().filter((semantic) => /^WEIGHTS_\d+$/.test(semantic)).sort()
          .map((semantic) => ({ weights: primitive.getAttribute(semantic)!, joints: primitive.getAttribute(semantic.replace("WEIGHTS_", "JOINTS_"))! }))
        : [];
      for (let vertex = 0; vertex < positions.getCount(); vertex += 1) {
        positions.getElement(vertex, position);
        const [px, py, pz] = position as Vec3;
        if (!skinMatrices || !weightSets.length) {
          include(world[0] * px + world[4] * py + world[8] * pz + world[12],
            world[1] * px + world[5] * py + world[9] * pz + world[13],
            world[2] * px + world[6] * py + world[10] * pz + world[14]);
          continue;
        }
        let x = 0, y = 0, z = 0;
        for (const set of weightSets) {
          set.joints.getElement(vertex, joint);
          set.weights.getElement(vertex, weight);
          for (let k = 0; k < weight.length; k += 1) {
            const w = weight[k]!;
            if (!w) continue;
            const m = skinMatrices[joint[k]!]!;
            x += w * (m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!);
            y += w * (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!);
            z += w * (m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!);
          }
        }
        include(x, y, z);
      }
    }
  }
  if (!Number.isFinite(min[0])) throw new Error("PLACE_SCENE_EMPTY: the scene instances no mesh geometry");
  return { min: min.map(canonicalZero) as Vec3, max: max.map(canonicalZero) as Vec3 };
}

function namedNode(document: Document, name: string): Node {
  const matches = document.getRoot().listNodes().filter((node) => node.getName() === name);
  if (matches.length !== 1) {
    throw new Error(`${matches.length ? "PLACE_PIVOT_NODE_AMBIGUOUS" : "PLACE_PIVOT_NODE_MISSING"}: sourcePivot.node '${name}' names ${matches.length} nodes; exactly one is required`);
  }
  return matches[0]!;
}

const worldPosition = (node: Node): Vec3 => {
  const matrix = node.getWorldMatrix();
  return [canonicalZero(matrix[12]), canonicalZero(matrix[13]), canonicalZero(matrix[14])];
};

function boundsReport({ min, max }: Bounds) {
  const size = [0, 1, 2].map((axis) => max[axis]! - min[axis]!) as Vec3;
  return { min, max, size, center: [0, 1, 2].map((axis) => (min[axis]! + max[axis]!) / 2) as Vec3 };
}

export async function executeGltfPlaceOperation(root: string, invocation: Invocation = {}): Promise<AssetOperationResult> {
  const { parameters, source } = await checkedInputs(root, invocation);
  const allowed = parameters.policy.allowedValidatorWarnings;
  const parsed = await parseCheckedGltfBytes(source.asset, source.bytes, Object.create(null), true, allowed);
  const document = parsed.document;
  const documentRoot = document.getRoot();
  const scenes = documentRoot.listScenes();
  if (scenes.length !== 1) throw new Error(`/scenes: PLACE_SCENE_COUNT_UNSUPPORTED: ${scenes.length} scenes; place one-scene GLBs`);
  const scene = scenes[0]!;
  if (documentRoot.listNodes().some((node) => node.getName() === parameters.parentName)) {
    throw new Error(`PLACE_PARENT_NAME_COLLISION: parentName '${parameters.parentName}' is already a node name of the source`);
  }
  const pivotNode = parameters.sourcePivot ? namedNode(document, parameters.sourcePivot.node) : null;
  const sourceBounds = sceneBounds(document);
  const sourcePivotPosition = pivotNode ? worldPosition(pivotNode) : null;
  const translation: Vec3 = parameters.translation
    ?? [canonicalZero(-(sourceBounds.min[0] + sourceBounds.max[0]) / 2), canonicalZero(-sourceBounds.min[1]), canonicalZero(-(sourceBounds.min[2] + sourceBounds.max[2]) / 2)];
  if (translation.some((component) => !Number.isFinite(component))) throw new Error("PLACE_TRANSLATION_NONFINITE: computed translation is not finite");

  const sourceSummary = gltfSummary(document);
  const roots = scene.listChildren();
  const parent = document.createNode(parameters.parentName).setTranslation(translation);
  for (const child of roots) { scene.removeChild(child); parent.addChild(child); }
  scene.addChild(parent);

  const weightSums = checkWeightSums(document);
  const bytes = await parsed.io.writeBinary(document);
  const outputValidatorWarnings = await validateGltf(bytes, "glb", Object.create(null), "scene.place.gltf@1 output", allowed, PRODUCTION_SUPERSEDED_VALIDATOR_CODES);
  // Placed evidence is measured on the written GLB, not derived from the translation.
  const placed = await parsed.io.readBinary(bytes);
  const placedBounds = sceneBounds(placed);
  const placedPivot = parameters.sourcePivot ? worldPosition(namedNode(placed, parameters.sourcePivot.node)) : null;
  const stored = await storeAssetObject(root, {
    bytes, kind: "scene", mediaType: GLB_MEDIA_TYPE,
    metadata: {
      profile: PROFILE, operation: GLTF_PLACE_OPERATION.id, operationVersion: GLTF_PLACE_OPERATION.version,
      sourceSha256: source.asset.sha256, parentName: parameters.parentName, translation,
      ...(parameters.anchor ? { anchor: parameters.anchor } : {}),
      coordinateSystem: "right-handed-y-up", unit: "meter",
    },
  });
  const placedReport = boundsReport(placedBounds);
  return normalizeAssetOperationResult(GLTF_PLACE_OPERATION, {
    outputs: { output: stored.asset },
    observations: {
      schemaVersion: 1, profile: PROFILE, coordinateSystem: "right-handed-y-up", unit: "meter",
      verticesBaked: false, accessorsChanged: false,
      parentName: parameters.parentName, mode: parameters.anchor ? "anchor" : "translation",
      ...(parameters.anchor ? { anchor: parameters.anchor } : {}),
      translation, reparentedRoots: roots.map((node) => node.getName()),
      bounds: {
        space: "world-rest", skinned: "rest-pose-joint-world-times-inverse-bind",
        source: boundsReport(sourceBounds), placed: placedReport,
      },
      footprint: { width: placedReport.size[0], depth: placedReport.size[2], height: placedReport.size[1] },
      ...(parameters.sourcePivot ? { sourcePivot: { node: parameters.sourcePivot.node, sourceWorldPosition: sourcePivotPosition, placedWorldPosition: placedPivot } } : {}),
      policy: parameters.policy,
      source: { sha256: source.asset.sha256, ...sourceSummary, skinCount: documentRoot.listSkins().length },
      output: { ...gltfSummary(placed), skinCount: placed.getRoot().listSkins().length },
      weightSums, validatorWarnings: parsed.validatorWarnings, outputValidatorWarnings,
      gltfTransform: VERSION, validator: validatorVersion(),
    },
  });
}
