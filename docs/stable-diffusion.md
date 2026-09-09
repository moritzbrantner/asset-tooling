# Stable Diffusion generation

The first Stable Diffusion backend is `model.stable-diffusion.diffusers` version `1`. It uses a local Python Diffusers runtime through the generic process-adapter protocol. `asset-tooling` owns the invocation and evidence; Diffusers and the bundled Stable Diffusion pipeline own inference semantics.

## Model bundle

The backend deliberately does not accept a bare checkpoint plus ambient Hugging Face cache entries. A Diffusers pipeline can depend on model configuration, tokenizer vocabulary, text encoders, VAE weights, scheduler configuration, safety components, and other files in addition to the main denoiser weights.

Package the complete local Diffusers pipeline directory as a ZIP and declare it as the single `models.pipelineBundle` artifact with its SHA-256. The ZIP must contain `model_index.json` either at the archive root or inside exactly one top-level directory. Symbolic links and path traversal entries are rejected before extraction.

Inference extracts the hash-pinned bundle into temporary storage and loads it with `local_files_only=true`. Hugging Face and Transformers caches are redirected to a new temporary directory and offline mode is forced, so a missing dependency fails instead of being fetched or satisfied by an ambient user cache.

## Parameters

Version 1 normalizes all output-affecting invocation settings:

- `prompt` and `negativePrompt`;
- `width` and `height`, both divisible by 8;
- inference `steps`;
- `guidanceScale`;
- scheduler: `default`, `ddim`, `euler`, or `euler-a`;
- dtype: `float32`, `float16`, or `bfloat16`;
- device: `cpu`, `cuda`, or `mps`;
- `deterministicAlgorithms`, which enables fail-closed deterministic PyTorch algorithms and disables TF32/benchmark selection where applicable.

Randomness must use the shared seeded contract. The adapter constructs a new CPU `torch.Generator` from that declared seed for every invocation instead of reusing a consumed generator state.

## Evidence

The environment fingerprint records the Python executable hash and versions of PyTorch, Diffusers, Transformers, Hugging Face Hub, safetensors, Pillow, CUDA, and cuDNN where available. Deterministic observations record the concrete pipeline and scheduler classes, generator device, output dimensions/mode/format, and deterministic-algorithm setting.

The backend intentionally declares `exactCapable: false`. A seed plus deterministic settings can reduce variation, but neither is proof of byte identity across different model/runtime/GPU combinations. `asset-tooling verify` still replays the invocation and compares bytes; the receipt records the actual environment so exact matches and drift remain inspectable.
