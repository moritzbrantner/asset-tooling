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
- `provider.modelId`, `provider.modelRevision` — the model identity and immutable revision the bundles were acquired from (see `docs/model-acquisition.md`).
- `provider.assets` — role names for `provider-assets`, which must equal the provider's role list in order.
- `provider.parameters` — the provider operation's own parameters, passed through and validated by that operation. Fields the canonical request owns (TripoSR `outputFormat`, TRELLIS.2 `seed`) are rejected here.
- `views` — one `{ id, viewpoint }` per view input, in input order. `id` is a unique token; `viewpoint` is `unspecified`, `front`, `back`, `left`, `right`, `top`, `bottom`, `front-left`, `front-right`, `back-left`, or `back-right`. Order and identity are therefore explicit and part of the build identity.
- `description` — optional semantic description, recorded as conditioning.
- `quality` — `draft`, `standard`, or `high` intent, recorded as conditioning.
- `requirements.materials` — `geometry`, `textured`, or `pbr`.
- `seed` — decimal string; required by seeded providers and rejected by unseeded ones.

## Providers

| Provider | Backend | Views | Masks | Materials | Seed | Assets |
| --- | --- | --- | --- | --- | --- | --- |
| `trellis2` | `model.trellis2@1` | 1 | no | pbr | required | source, model, legacy-decoder, image-encoder |
| `stable-fast-3d` | `model.stable-fast-3d@1` | 1 | no | textured | none | source, model, tokenizer |
| `triposr` | `model.triposr@1` | 1 | no | geometry | none | model |

`IMAGE_TO_3D_PROVIDERS` exports this table. A request the selected provider cannot honor — too many views, masks, a stronger material requirement, a seed mismatch, or reordered assets — fails closed instead of being silently degraded. The local providers take a single prepared view; the multi-view and mask ports exist so future providers (for example a cloud multi-view adapter) share the same contract.

## Output and evidence

The output is one `model/gltf-binary` mesh. Before it becomes an asset, the bytes pass the Khronos glTF validator (`validateGltf`). Its metadata records the operation, provider id/model/revision/backend/delegated operation, provider parameters, each provider asset role with its SHA-256, each view's index/id/viewpoint/SHA-256/media type (and mask SHA-256), description, quality, requirements, seed, the reproducibility label, and the validation warning count.

The reproducibility label comes from the backend's declared `exactCapable` capability. Every current image-to-3D backend declares `false`, so outputs are labeled `approximate`; a seed or deterministic-algorithm switch never upgrades the label.

## Identity and cache

The build identity binds the canonical request, every input `AssetRef`, the provider/model identity, and the delegated operation's implementation identity, including tool and environment fingerprints. Identical requests produce identical build identities.

Execution verifies every declared input object, then consults the shared generation cache (`docs/cache.md`) keyed by that identity. A hit reuses the blob only after its SHA-256 matches and the GLB re-validates; a tampered blob fails closed. A miss runs the provider and writes the cache only after validation succeeds. `createImageTo3DOperationExecutor({ cache: false })` bypasses the cache. Observations report `cache: "hit" | "miss"`, the build hash, the output hash, and the provider's observations.
