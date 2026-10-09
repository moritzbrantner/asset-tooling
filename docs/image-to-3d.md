# Provider-neutral image/multi-view to 3D

`mesh.image-to-3d.generate@1`, published through `asset-tooling/operations/generation/image-to-3d`, is the public contract for turning reference images into a 3D asset. Callers select a provider by data; no model is part of the operation's identity. The operation reuses the existing per-model operations (`mesh.trellis2.generate@1`, `mesh.stable-fast-3d.generate@1`, `mesh.triposr.generate@1`) and their backends unchanged — it maps a canonical request onto them, it does not reimplement inference.

## Inputs

| Port | Cardinality | Meaning |
| --- | --- | --- |
| `views` | 1..16, ordered | Prepared reference images (`image/png`, `image/jpeg`). |
| `masks` | optional, one per view | Foreground masks aligned with `views` by index. |
| `provider-assets` | 1..8, ordered | The provider's model bundles in the order named by `parameters.provider.assets`. |

## Parameters

- `provider.id` — `trellis2`, `stable-fast-3d`, or `triposr`.
- `provider.modelId`, `provider.modelRevision` — the model identity and the immutable revision the bundles were acquired from (see `docs/model-acquisition.md`). The revision must be a full 40- or 64-character lowercase commit digest; branches and tags are rejected. Local provider bundles are composite (source, weights, encoders), so the revision is a declared claim recorded beside the exact bundle hashes, which remain the authority.
- `provider.assets` — role names for `provider-assets`, which must equal the provider's role list in order.
- `provider.parameters` — the provider operation's own parameters, passed through and validated by that operation. Fields the canonical request owns (TripoSR `outputFormat`, TRELLIS.2 `seed`) are rejected here.
- `views` — one `{ id, viewpoint }` per view input, in input order. `id` is a unique token; `viewpoint` is `unspecified`, `front`, `back`, `left`, `right`, `top`, `bottom`, `front-left`, `front-right`, `back-left`, or `back-right`. Order and identity are therefore explicit and part of the build identity.
- `description` — optional semantic description, recorded as conditioning.
- `quality` — `draft`, `standard`, or `high` intent, recorded as conditioning.
- `requirements.materials` — `geometry`, `textured`, or `pbr`.
- `seed` — decimal string; required by seeded providers and rejected by unseeded ones.

## Providers

| Provider | Backend | Views | View media | Masks | Materials | Seed | Assets |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `trellis2` | `model.trellis2@1` | 1 | PNG | no | pbr | required | source, model, legacy-decoder, image-encoder |
| `stable-fast-3d` | `model.stable-fast-3d@1` | 1 | PNG | no | textured | none | source, model, tokenizer |
| `triposr` | `model.triposr@1` | 1 | PNG, JPEG | no | geometry | none | model |

`IMAGE_TO_3D_PROVIDERS` exports this table. A request the selected provider cannot honor — too many views, a view format it cannot read (alpha-dependent providers need PNG), masks, a stronger material requirement, a seed mismatch, or reordered assets — fails closed instead of being silently degraded. The local providers take a single prepared view; the multi-view and mask ports exist so future providers (for example a cloud multi-view adapter) share the same contract.

## Output and evidence

The output is one `model/gltf-binary` mesh. The provider's raw bytes are validated before the delegated operation can store them and again before the facade stores or caches its output: they must pass the Khronos glTF validator (`validateGltf`) and deliver the requested material level on the assigned material of every primitive reachable from a rendered scene (unused materials and orphan meshes do not count) — mesh geometry for `geometry`, a base-color texture for `textured`, and base-color plus metallic-roughness textures for `pbr` (`glbMaterialLevel`). The delegated operation's runtime fingerprint and tool identity must equal those in the prepared build identity; a change between preparation and generation fails instead of caching output under the wrong environment. Its metadata records the operation, provider id/model/revision/backend/delegated operation, provider parameters, each provider asset role with its SHA-256, each view's index/id/viewpoint/SHA-256/media type (and mask SHA-256), description, quality, requirements, seed, the reproducibility label, and the validation warning count.

Outputs are labeled `approximate` when the backend declares `exactCapable: false` (every current image-to-3D backend) and `unverified-exact-capable` otherwise. Exactness is earned only by an authoritative replay that reproduces the bytes, so this operation never labels a first output `exact`; a seed or deterministic-algorithm switch never upgrades the label.

## Identity and cache

The build identity binds the canonical request, every input `AssetRef`, the provider/model identity, and the delegated operation's implementation identity, including tool and environment fingerprints. Identical requests produce identical build identities.

Execution verifies every declared input object, then consults the shared generation cache (`docs/cache.md`) keyed by that identity. A hit reuses the blob only after its SHA-256 matches and the GLB re-validates; a tampered blob fails closed. A miss runs the provider and writes the cache only after validation succeeds. `createImageTo3DOperationExecutor({ cache: false })` bypasses the cache. Observations report `cache: "hit" | "miss"`, the build hash, the output hash, and the provider's observations.
