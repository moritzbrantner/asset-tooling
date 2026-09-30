# Static glTF import

`scene.import.gltf@1`, exported by `asset-tooling/operations/processing/gltf`, packages supported glTF 2.0 as a self-contained, content-addressed GLB. This delivers the imported static/material slice of #104. Existing renderer-neutral `scene.normalize@1` and `scene.export.glb@1` contracts remain independent.

glTF Transform 4.5.1 owns parsing and serialization. Khronos glTF Validator 2.0.0-dev.3.10 validates source and output. The operation rejects validation errors and warnings, unsupported extensions (including optional extensions that would otherwise be dropped), skins, animations, morph targets and non-triangle primitives. It currently supports at most one binary buffer. GLB inputs must be self-contained; JSON glTF may use embedded data URIs or explicitly supplied external resources.

Core PBR factors, texture bytes and texture-slot/sampler meaning, UVs, normals, tangents, color attributes, node hierarchy and supported transforms pass through the established processor. Units and axes retain glTF's meter/right-handed Y-up convention; this operation does not reinterpret centimeter inputs or bake transforms. Normal maps retain glTF's positive-Y convention; color textures remain sRGB and normal/metallic-roughness/occlusion textures remain linear data. Textures are embedded without recompression. This profile does not claim a complete production analysis or arbitrary extension support.

```ts
import {
  GLTF_IMPORT_OPERATION,
  createGltfImportOperationBuildIdentity,
  executeGltfImportOperation,
} from "asset-tooling/operations/processing/gltf";

const invocation = {
  parameters: { resourceUris: ["geometry/body.bin", "textures/paint.png"] },
  inputs: { source: sourceAssetRef, resources: [geometryAssetRef, paintAssetRef] },
};
const identity = await createGltfImportOperationBuildIdentity(objectStoreRoot, invocation);
const result = await executeGltfImportOperation(objectStoreRoot, invocation);
```

`resourceUris` corresponds positionally to `inputs.resources`. Omit both for embedded sources. Every binding must be used, with unique portable relative paths; URL schemes, path escapes, percent encoding and backslashes are rejected. Source/resource bytes are rechecked by content hash and length even when creating build identity. Execution never fetches resources or reads files named by a source URI. Failed validation stores no derived output and leaves existing objects intact.

Build identity includes operation version, source and resource AssetRefs, normalized bindings, processor and validator versions, dependency-lock hash, and asset-tooling source fingerprint. Output metadata retains source/resource hashes; observations inventory embedded/data-URI/external resources and report geometry/material/texture counts. Repeated execution compares output identities in tests; build identity alone is not proof of exact replay. The operation uses the existing operation/workflow/store surface and replays its processor on every execution.

Run `bun test test/gltf-import-operations.test.ts` for independent small fixtures covering factors, hierarchy/world-space placement, geometry/attribute retention, malformed references/nonfinite data, deterministic output and resource tampering. Run `bun scripts/check-gltf-import-contract.ts` in a hydrated checkout for the pinned catalog Avocado proof. An optional filename accepts explicitly acquired Avocado bytes; the catalog still validates the source hash/length and license before import. The proof compares source/output attributes, indices, world transforms, material factors and texture hashes, then rebuilds to compare output identity. It does not download assets or mutate canonical storage.

Skins/animations, production policy/analysis, the approved humanoid, and visual/consumer acceptance remain open under #104/#109. The Avocado contract proof establishes material-bearing transport and replay, not art approval.
