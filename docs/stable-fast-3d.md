# Stable Fast 3D image-to-3D generation

Stable Fast 3D is exposed as `model.stable-fast-3d@1` and the runtime-neutral operation `mesh.stable-fast-3d.generate@1`. The model remains authoritative for reconstruction, UV unwrapping, texture baking, delighting, and material prediction. `asset-tooling` owns only explicit invocation, dependency identity, offline execution, output hashing, and replay evidence.

This is the preferred local image-to-3D path for game-ready textured assets. The existing TripoSR operation remains a lighter fallback when Stable Fast 3D's runtime or memory requirements are unsuitable.

## Explicit dependency boundary

Generation has no hidden network/model resolution. One invocation consumes four content-addressed inputs:

- `image`: one prepared 512×512 RGBA PNG/JPEG image whose alpha channel is the intended foreground mask;
- `source`: a ZIP containing the exact Stable Fast 3D `sf3d/` source tree;
- `model`: a ZIP containing `config.yaml` and `model.safetensors`;
- `imageTokenizer`: a ZIP containing the complete local DINOv2 model referenced by the Stable Fast 3D configuration.

The official Stable Fast 3D configuration references a DINOv2 image tokenizer. The adapter patches only a temporary copy of `config.yaml` so that tokenizer resolves to the declared local DINO bundle. Hugging Face and Transformers offline mode is forced. Missing bytes fail closed instead of falling back to a user cache or network download.

Stable Fast 3D also relies on compiled `texture_baker` and `uv_unwrapper` runtime modules. Those are execution-environment dependencies rather than model bytes. Their native module fingerprints, Python package versions, selected accelerator, CUDA/cuDNN and driver identity are recorded in the environment fingerprint.

## Prepared-image boundary

Version 1 deliberately does not run `rembg`, resize the foreground, invent an alpha mask, or perform prompt/image generation. The input must already be RGBA and exactly 512×512. Background removal, concept-image generation, cropping, and framing belong to separately traceable asset operations.

That keeps the useful end-to-end recipe composable:

1. generate or import a concept image;
2. explicitly prepare a 512×512 RGBA reconstruction input;
3. run `mesh.stable-fast-3d.generate@1`;
4. normalize/export through the 3D production profile;
5. derive simplification/LOD variants through the existing pinned 3D processors.

## Parameters

Version 1 normalizes:

- `sourceBundleId`, `modelBundleId`, `imageTokenizerBundleId`: human-readable identities paired with the exact input hashes;
- `preprocessMode`: `prepared-rgba` only;
- `device`: `cpu` or `cuda`, with no silent fallback;
- `textureResolution`: 512, 768, 1024, 1280, 1536, 1792, or 2048;
- `remesh`: `none`, `triangle`, or `quad`;
- `targetVertexCount`: `-1` for the model result or 1000..20000 when remeshing/reduction is requested;
- `deterministicAlgorithms`: asks PyTorch to fail closed on nondeterministic operations where supported.

The backend uses `randomness.mode: none` because this adapter exposes no user seed. That is not a claim of deterministic output. Exact reproducibility is still established only by replayed byte identity.

## Licensing and acquisition

The Stable Fast 3D model is gated on Hugging Face and currently uses Stability AI's Community License. Acquisition remains separate from generation. The existing verified Hugging Face acquisition path can be used after the user has accepted the upstream terms and supplied authorized access; the generation backend itself never logs in or downloads.

Source/model/tokenizer bundles remain explicit inputs so license evidence and immutable revisions can be reviewed independently. Do not promote upstream bytes into shared canonical storage until the relevant provider/license policy is accepted.

## Output and downstream processing

The operation emits the model's raw textured GLB as a content-addressed `mesh` asset. Coordinate normalization, production-profile export normalization, mesh simplification, LOD chains, collision proxies, compression, and game-specific packaging remain separate operations with their own evidence.
