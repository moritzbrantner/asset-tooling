# TRELLIS.2

`model.trellis2@1` / `mesh.trellis2.generate@1` is the high-fidelity PBR image-to-3D path in asset-tooling. It complements Stable Fast 3D and TripoSR rather than replacing their lower-resource runtime niches.

## Ownership and provenance boundary

The operation consumes five independently content-addressed inputs:

- a prepared RGBA PNG;
- an exact TRELLIS.2 source bundle;
- an exact `microsoft/TRELLIS.2-4B` model snapshot;
- the legacy sparse-structure decoder referenced by the upstream TRELLIS.2 pipeline;
- the exact DINOv3 image-encoder snapshot referenced by the upstream pipeline.

Generation does not acquire any of these dependencies. Use the existing acquisition tooling to resolve provider refs to immutable revisions and create hash-pinned offline bundles before execution.

The upstream TRELLIS.2 source and TRELLIS.2-4B model are MIT licensed. The DINOv3 encoder is separately licensed and gated by its provider. Its terms must be accepted before acquisition; its bytes are never inferred to be redistributable merely because TRELLIS.2 references them.

## No hidden preprocessing

`preprocessMode` is fixed to `prepared-rgba-premultiplied`.

The input PNG must already encode the intended foreground mask in alpha. The adapter only performs deterministic integer alpha premultiplication before the upstream DINOv3 resize/normalization path. It does not invoke TRELLIS.2's BiRefNet background-removal model, crop the foreground, or download a segmentation model.

This keeps segmentation/background-removal provenance separate from reconstruction.

## Offline model loading

TRELLIS.2's upstream `pipeline.json` currently references one checkpoint from the older `microsoft/TRELLIS-image-large` repository. The v1 operation therefore declares that sparse-structure decoder as its own `legacy-decoder` input rather than allowing the upstream loader to fetch it.

All other checkpoint references must remain local `ckpts/*` entries inside the declared TRELLIS.2 model bundle. A changed remote checkpoint reference fails closed until the asset-tooling contract is deliberately updated.

The DINOv3 encoder is also supplied as a local bundle and passed to Transformers by filesystem path. Hugging Face/Transformers caches are redirected to a fresh temporary directory and offline mode is forced during generation.

## Runtime boundary

TRELLIS.2 v1 supports `device: "cuda"` only. The upstream image-conditioning and sparse runtime is currently CUDA-oriented, and the official project documents a Linux/NVIDIA setup with substantial GPU-memory requirements.

Platform-specific compiled dependencies such as O-Voxel, CuMesh, FlexGEMM, FlashAttention, and nvdiffrast remain runtime dependencies rather than model artifacts. The adapter fingerprints their loaded modules together with Python, PyTorch, CUDA/cuDNN, the NVIDIA driver, and the selected GPU. Changing this environment therefore changes operation build identity.

The source/model hashes remain independent of the runtime fingerprint; a matching environment fingerprint is not substituted for model provenance.

## PBR GLB output

TRELLIS.2 generates a mesh carrying:

- base color;
- metallic;
- roughness;
- opacity.

The adapter exports those attributes through the upstream O-Voxel GLB postprocessor and stores the resulting GLB as a normal content-addressed mesh `AssetRef`.

`decimationTarget`, `textureSize`, remeshing, WebP extension use, pipeline type, token cap, and seed are explicit operation parameters and therefore part of build identity.

## Reproducibility

The backend is `exactCapable: false`. A seed and deterministic PyTorch switches are inputs, not proof of byte reproducibility. Exact reproducibility is established only when verification replays the backend against the same declared dependencies/environment and reproduces the output bytes.

## Downstream production processing

TRELLIS.2 output is still a generated source asset. Coordinate/scene normalization, LOD generation, collision proxies, final compression, and game-specific packaging remain later operations with their own evidence. Render geometry is never silently promoted to collision authority.
