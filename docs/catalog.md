# Canonical asset catalog

The catalog is the acquisition and provenance boundary for reusable third-party media. It does not turn a URL into trusted input and it does not make license claims from provider reputation alone.

## Ownership

`asset-tooling` owns provider policy, source metadata, byte pinning, canonical import, content identity, and provenance metadata. Authoritative image, mesh, animation, audio, and video algorithms stay in their domain repositories. `workflow-editor` and `workflow-runner` remain generic workflow infrastructure.

The shared canonical path is:

```text
provider/source discovery
  -> license evidence
  -> explicit acquisition outside deterministic generation
  -> inspect exact bytes
  -> SHA-256 + byte-length pin
  -> canonical import
  -> content-addressed AssetRef
  -> normalization/processing operations
  -> consumer reuse
```

Network acquisition stays outside generation and verification. A catalog source without `source.sha256` and `source.byteLength` is a candidate only. `importAssetCatalogSource(...)` fails closed until both are present and then verifies the supplied bytes again before writing them to the existing content-addressed object store.

## Provider policy

`catalog/providers.json` records the reusable-source policy rather than scattering licensing assumptions across consumers.

- Kenney, Poly Haven, and Quaternius are shared-catalog sources only under their accepted CC0 policy.
- Khronos glTF Sample Assets and Freesound are per-asset sources; each catalog entry carries its own license evidence. Their collections must never be treated as having one blanket license.
- Blender Studio content may enter the shared catalog when the concrete source is CC BY 4.0 and explicit attribution text is retained.
- Mixamo is deliberately `project-local`: it can be used by a consumer under its applicable terms but raw Mixamo assets must not be redistributed through the shared canonical catalog.

CC0 is the preferred default. A non-CC0 source requires explicit attribution text in the source record. Provider policy is an allowlist, not proof that a particular asset has that license.

## Source records

A source record contains:

- stable catalog id and provider id;
- title, asset kind, and concrete media type;
- upstream URL and, where available, immutable revision/path/upstream id;
- license SPDX id plus an evidence URL;
- tags and non-authoritative discovery metadata;
- after inspection, exact SHA-256 and byte length.

Repository commit SHAs, Git blob SHAs, API ids, download URLs, and provider versions are useful acquisition evidence, but they do not substitute for the SHA-256 of the bytes that `asset-tooling` actually accepts.

## Explicit acquisition evidence

Catalog acquisition is intentionally separate from normal tests, generation, and verification.

For a local file that has already been obtained from its recorded source, run:

```text
bun run catalog:pin -- <catalog-source-id> <local-file>
```

For an explicit network acquisition, run:

```text
bun run catalog:acquire -- <catalog-source-id> [destination-root]
```

`catalog:acquire` only accepts registered shared providers whose source license is allowed by provider policy. It follows the recorded HTTPS source URL, writes the received bytes to an evidence directory, measures the exact SHA-256 and byte length through the same catalog pin verifier, and writes a canonical `.pin.json` record beside the downloaded file. It does not modify `catalog/sources.json` and does not import the object into the canonical store.

The manually dispatched `Catalog acquisition evidence` GitHub workflow performs the same operation on a hosted runner and retains the bytes plus pin evidence as a short-lived workflow artifact. This provides a reproducible place to acquire sources that cannot be retrieved from the current development environment without turning external availability into a required CI dependency.

Promotion remains an explicit reviewed change: copy the measured `sha256` and `byteLength` into the matching source record, run the deterministic catalog gate, and only then allow canonical import or consumer vendoring. Re-running acquisition for an already pinned source fails if upstream bytes drift.

Project-local providers such as Mixamo are refused by this shared acquisition workflow so their raw assets cannot accidentally enter shared artifacts.

## Canonical formats

Prefer these normalized delivery boundaries where the owning processor supports them:

| Domain | Canonical/runtime direction |
| --- | --- |
| 3D scene/model | glTF 2 / GLB |
| 3D authoring source | `.blend` only when source-level editing is intentionally preserved |
| Texture | PNG/WebP source; KTX2 for optimized runtime delivery |
| Vector | SVG |
| Raster image | PNG/WebP |
| Audio master | WAV/FLAC |
| Audio delivery | Opus/Ogg where appropriate |
| Video | MP4/WebM according to the consumer contract |
| Animation | glTF animation clips where practical |

The catalog stores provenance and exact bytes; format conversion belongs to typed asset operations so derived outputs receive their own content identities.

## Fleet rollout

The rollout is deliberately vertical:

1. **3D asset consumers:** `3d-lab`, `layout-lab`, and asset/rendering surfaces in `maps`. Reuse pinned glTF/GLB reference objects for importer, renderer, material, animation, picking, and optimization scenarios instead of cloning opaque fixtures.
2. **Simulation demos, not kernels:** `ecs-lab` and `physics-engine` may use canonical assets only in Pages/demo adapters. ECS storage and physics simulation contracts must not acquire rendering or media ownership merely because their demos need models or textures.
3. **Application/game consumers:** `example-apps`, Expo/template demos, card/game repositories. Prefer Kenney/Quaternius CC0 packs for generic UI, sprites, props, characters, and environment material; keep app-specific art local.
4. **Media consumers:** audio/video analysis, playback, similarity, transcription, and conversion repositories. Reuse a small pinned corpus with explicit purpose tags; do not grow giant fixture collections simply because assets are available.
5. **Workbench:** expose catalog browsing, source status, provenance, previews, variants, and approved versions in the asset workbench/GitHub Pages surface. Avoid decorative counters; interaction should answer which asset is appropriate and why.

A consumer should normally depend on a catalog id plus an exact `AssetRef`/materialization result rather than commit another independent copy. If a consumer must vendor bytes for offline/runtime packaging, retain the catalog provenance and exact hash beside the vendored file.

## Seed sources

`khronos.triangle-embedded-gltf` is the first fully pinned canonical source. It is a 1,122-byte, self-contained glTF 2.0 Triangle from an exact Khronos commit, with CC0 evidence and an independently recorded SHA-256. Its upstream Git blob identity is retained as additional acquisition evidence, not as a substitute for the SHA-256.

`khronos.avocado-glb` is a larger PBR reference at the same exact upstream commit. It remains a candidate until its downloaded bytes are SHA-256 pinned; the recorded upstream Git blob SHA and byte length are acquisition evidence only.

The catalog also carries practical CC0 candidates from Kenney, Quaternius, and Poly Haven. They remain candidates until the explicit acquisition path measures their actual bytes; source discovery and license evidence alone do not make them canonical.

Together these give the fleet both a tiny deterministic conformance fixture and realistic candidates for UI, audio, board-game art, 3D models, humanoid animation, PBR material inputs, and HDRI lighting without weakening the rule that canonical bytes must be measured before reuse.
