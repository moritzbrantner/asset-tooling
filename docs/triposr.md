# TripoSR image-to-3D generation

The first TripoSR backend is `model.triposr` version `1`. It invokes the authoritative TripoSR source through the generic local process-adapter protocol and emits an OBJ or GLB mesh. `asset-tooling` owns invocation, dependency identity, output hashing, replay, and receipts; TripoSR owns image-to-3D inference and mesh extraction semantics.

## Bundle contract

A TripoSR result depends on more than `model.ckpt`. The official implementation constructs its image tokenizer from configuration, and that tokenizer normally references a Hugging Face DINO model. The v1 backend therefore consumes one SHA-256-pinned ZIP containing the complete inference authority:

- `tsr/` — the exact TripoSR Python source tree;
- `config.yaml` — TripoSR configuration;
- `model.ckpt` — TripoSR weights;
- `dino/` — a complete local Hugging Face DINO model directory, including `config.json` and its weights/configuration files.

These entries may be at the ZIP root or inside one top-level directory. Archive path traversal and symbolic links are rejected. At runtime the adapter extracts the bundle into temporary storage, imports `tsr` from that extracted source tree, and patches only a temporary copy of the bundled config so `image_tokenizer.pretrained_model_name_or_path` points at the bundled `dino/` directory.

Hugging Face/Transformers caches are redirected to fresh temporary storage and offline mode is forced. Missing files fail closed instead of falling back to a user cache or network download.

## Prepared input boundary

TripoSR's reference CLI can invoke `rembg` to remove a background before inference. That introduces another model and another acquisition/runtime dependency. Version 1 deliberately does not perform automatic background removal.

`parameters.preprocessMode` must therefore be `prepared`, and `inputs.image` must already be an RGB image prepared for TripoSR, including the intended background and foreground framing. The adapter rejects non-RGB inputs rather than silently transforming them. If background removal, resizing, or other image preparation is required, it should be a separately traceable processing/generation stage with its own declared implementation and model evidence.

## Parameters

Version 1 normalizes:

- `preprocessMode`: `prepared` only;
- `device`: `cpu` or `cuda`, with no silent CUDA-to-CPU fallback;
- `chunkSize`: `0..65536`;
- `mcResolution`: `32..512`;
- `outputFormat`: `obj` or `glb`;
- `deterministicAlgorithms`: enables fail-closed deterministic PyTorch algorithms and disables TF32/benchmark selection where applicable.

The backend uses the shared `randomness.mode: none` contract because the TripoSR forward/extraction invocation has no user-controlled seed in this adapter. That does not imply determinism; GPU/runtime numerical behavior still has to be established through replay evidence.

## Evidence

The environment fingerprint records the Python executable hash and versions/fingerprints of PyTorch, Transformers, Hugging Face Hub, OmegaConf, Pillow, NumPy, einops, trimesh, torchmcubes, and CUDA/cuDNN where available. The TripoSR source, configuration, weights, and DINO model are independently covered by the declared bundle hash.

Deterministic observations record the prepared input mode, model class, chunk size, marching-cubes resolution, vertex-color policy, vertex count, face count, output format, and deterministic-algorithm setting.

The backend declares `exactCapable: false`. If an invocation happens to reproduce identical OBJ/GLB bytes, verification records that fact; a model family, absence of a seed, or deterministic PyTorch switch is never treated as proof by itself.

## Processing boundary

The TripoSR output is the raw generated mesh artifact. Simplification, remeshing, LOD construction, texture generation/baking, compression, coordinate normalization, collision generation, or game-specific optimization belong to later processing stages. Keeping those receipts separate makes it possible to reproduce or replace generation without obscuring what happened afterward.
