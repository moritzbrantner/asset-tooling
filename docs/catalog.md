# Canonical asset catalog

The catalog is the acquisition and provenance boundary for reusable third-party media. It does not turn a URL into trusted input and it does not make license claims from provider reputation alone.

## Ownership

`asset-tooling` owns provider policy, source metadata, byte pinning, durable canonical storage, content identity, and provenance metadata. Authoritative image, mesh, animation, audio, and video algorithms stay in their domain repositories. `workflow-editor` and `workflow-runner` remain generic workflow infrastructure.

The shared canonical path is:

```text
provider/source discovery
  -> license evidence
  -> explicit acquisition outside deterministic generation
  -> inspect exact bytes
  -> SHA-256 + byte-length pin
  -> reviewed Git LFS storage
  -> hydrated-byte verification
  -> AssetRef / normalization operations
  -> consumer reuse
```

Network acquisition stays outside generation and verification. A catalog source without `source.sha256` and `source.byteLength` is a candidate only. A Git LFS pointer is storage metadata, not proof of the payload: canonical verification always checks the hydrated bytes against the catalog pin.

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

Repository commit SHAs, Git blob SHAs, API ids, download URLs, provider versions, and Git LFS object ids are useful storage/acquisition evidence, but none substitutes for verification of the actual accepted bytes.

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

`catalog:acquire` only accepts registered shared providers whose source license is allowed by provider policy. It follows the recorded HTTPS source URL, writes the received bytes to an evidence directory, measures the exact SHA-256 and byte length through the same catalog pin verifier, and writes a canonical `.pin.json` record beside the downloaded file. It does not modify `catalog/sources.json` and does not place anything in durable storage.

The manually dispatched `Catalog acquisition evidence` workflow performs the same operation on a hosted runner and retains the bytes plus pin evidence as a short-lived workflow artifact. This remains useful when the desired outcome is evidence only.

Project-local providers such as Mixamo are refused by the shared acquisition path so their raw assets cannot accidentally enter shared artifacts.

## Durable Git LFS storage

Durable approved payloads live under `assets/canonical/`. `.gitattributes` assigns every file in that tree to Git LFS, while `catalog/providers.json`, `catalog/sources.json`, `catalog/storage.json`, license/provenance metadata, and code remain ordinary reviewable Git text.

`catalog/storage.json` is a closed-world storage manifest. Every entry must:

- reference an existing content-pinned source;
- pass the provider's shared-distribution and accepted-license policy;
- use storage backend `git-lfs`;
- use the deterministic path `assets/canonical/<source-id>/<upstream-filename>`;
- be unique by source id and path.

Conversely, every file present under `assets/canonical/` must have exactly one manifest entry. An orphan LFS file is invalid canonical storage.

Ordinary `bun run check` runs `catalog:storage:check`, which validates this structure without hydrating large payloads. The dedicated `Validate / canonical-storage` job checks out with `lfs: true`, runs `git lfs fsck`, confirms every manifest path is actually marked with the LFS filter, checks that the payload tree exactly matches the manifest, and hashes each hydrated file against `catalog/sources.json`.

For local full verification from an LFS-hydrated checkout:

```text
bun run catalog:storage:verify
```

`.asset-tooling/objects` remains a separate disposable content-addressed operation store. Durable third-party masters must not be moved into that namespace merely because both use content hashes.

## Reviewed LFS promotion

For a direct local promotion of a registered shared source:

```text
bun run catalog:lfs:promote -- <catalog-source-id>
```

This acquires the registered source, measures or re-verifies the exact bytes, updates that source's SHA-256 and byte length, writes the payload at its deterministic canonical path, and updates `catalog/storage.json`. Git LFS itself remains responsible for replacing the staged payload with its pointer and uploading the object during `git push`.

The preferred hosted path is the manually dispatched `Catalog Git LFS promotion` workflow. It performs the same preparation, verifies the LFS/storage boundary, stages the payload through Git LFS, commits it, and pushes a uniquely named review branch. It does **not** push to `main` and does not automatically create a PR; the review branch must be turned into a normal pull request so PR-triggered exact-head validation executes before integration.

Re-running promotion for an already canonical source is idempotent when the bytes and manifests are unchanged. A changed upstream response, corrupted local canonical payload, implicit path move, unaccepted license, or project-local provider fails closed.

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

Git LFS stores accepted source/master payloads. Format conversion still belongs to typed asset operations so every derived output receives its own content identity and source lineage.

## Fleet rollout

The rollout is deliberately vertical:

1. **3D asset consumers:** `3d-lab`, `layout-lab`, and asset/rendering surfaces in `maps`. Reuse pinned glTF/GLB reference objects for importer, renderer, material, animation, picking, and optimization scenarios instead of cloning opaque fixtures.
2. **Simulation demos, not kernels:** `ecs-lab` and `physics-engine` may use canonical assets only in Pages/demo adapters. ECS storage and physics simulation contracts must not acquire rendering or media ownership merely because their demos need models or textures.
3. **Application/game consumers:** `example-apps`, Expo/template demos, card/game repositories. Prefer Kenney/Quaternius CC0 packs for generic UI, sprites, props, characters, and environment material; keep app-specific art local.
4. **Media consumers:** audio/video analysis, playback, similarity, transcription, and conversion repositories. Reuse a small pinned corpus with explicit purpose tags; do not grow giant fixture collections simply because assets are available.
5. **Workbench:** expose catalog browsing, source status, provenance, previews, variants, and approved versions in the asset workbench/GitHub Pages surface. Avoid decorative counters; interaction should answer which asset is appropriate and why.

A consumer should normally depend on a catalog id and exact content identity rather than source an independent copy. If a consumer must vendor bytes for offline/runtime packaging, retain the catalog provenance and exact hash beside the vendored file.

## Seed sources

`khronos.triangle-embedded-gltf` is the first fully pinned canonical source identity. It is a 1,122-byte self-contained glTF 2.0 Triangle from an exact Khronos commit, with CC0 evidence and an independently recorded SHA-256. Its current `3d-lab` use remains an intentionally small repository fixture rather than forcing a 1 KiB text asset into LFS solely for uniformity.

`khronos.avocado-glb` is a larger PBR reference at the same exact upstream commit and is a natural first GLB candidate for the durable LFS path once its downloaded bytes are measured.

The catalog also carries practical CC0 candidates from Kenney, Quaternius, and Poly Haven. The hosted LFS promotion path can turn these into reviewed source pins plus durable payloads without weakening the rule that canonical bytes must be measured before reuse.
