# Verified model acquisition

Model acquisition is intentionally separate from model execution. Generation and verification continue to consume only local model artifacts whose bytes are declared and hash-pinned; they never resolve a model name, branch, tag, or ambient Hugging Face cache entry while generating an asset.

The first acquisition provider is Hugging Face. `scripts/acquire-huggingface-model.py` turns a model repository plus a requested revision into two files:

- `model.zip`: a deterministic, uncompressed ZIP of the complete downloaded repository snapshot;
- `receipt.json`: immutable source identity, license evidence, per-file hashes and lengths, acquisition implementation identity, and the final bundle hash.

## Why resolve first

A branch or tag is a convenient request, but it is mutable. Acquisition first resolves the requested revision to the repository's full 40-character commit SHA and then downloads the snapshot at that commit. The receipt records both the requested revision and the resolved commit.

The acquisition command downloads the complete snapshot rather than silently choosing weight variants. This favors correctness and complete dependency capture. Provider cache metadata under `.cache/huggingface/` is excluded from the model bundle because it is acquisition state rather than model input.

## Local acquisition

Install the acquisition-only dependency:

```sh
python -m pip install --requirement requirements-model-acquisition.txt
```

Acquire a model:

```sh
python scripts/acquire-huggingface-model.py acquire \
  --repo-id owner/model \
  --revision release-tag-or-commit \
  --expected-license apache-2.0 \
  --destination .artifacts/models/example
```

For gated or private repositories, provide `HF_TOKEN` in the environment. The token is used only by the Hugging Face client and is never written into the receipt.

`--expected-license` is optional for the local command. When supplied, acquisition fails closed if revision-specific model metadata omits a license or declares a different value. A matched model-card license is provenance evidence, not a substitute for reviewing the license terms for the intended use.

## Offline verification

Verification does not contact Hugging Face:

```sh
python scripts/acquire-huggingface-model.py verify \
  --bundle .artifacts/models/example/model.zip \
  --receipt .artifacts/models/example/receipt.json
```

It verifies the bundle hash and byte length, the exact file set, every file SHA-256 and byte length, portable paths, duplicate rejection, symlink rejection, the immutable repository revision, license-state consistency, and the `modelArtifact`/bundle identity relationship.

The resulting `modelArtifact` is the bridge into existing generation specs. Its `id` includes the Hugging Face repository and immutable commit; its `sha256` is the exact `model.zip` hash. A Diffusers-compatible snapshot can therefore be used as a Stable Diffusion `models.pipelineBundle` without giving the generation backend network access. Other model adapters may impose additional bundle-layout requirements.

## Single-file acquisition for ComfyUI

ComfyUI loads single `.safetensors` files from `models/<directory>/<name>`, so a whole-repository snapshot is neither needed nor wanted. `acquire-file` acquires exactly one pinned file:

1. resolves the requested revision to its 40-character commit through `model_info`;
2. downloads only that one file with `hf_hub_download(..., revision=<commit>)` into a temporary directory beside the destination (same filesystem), never a snapshot;
3. verifies the byte length and sha256 against the pin;
4. moves the file atomically to `models/<directory>/<name>` (never replacing an existing file), then writes `<name>.receipt.json` beside it atomically.

Any failure leaves nothing behind: no partial file, no temporary directory, no receipt.

```sh
M=.artifacts/toolchain/comfy-workspace/ComfyUI/models

# Every file of an image.generate@1 profile (diffusion model, text encoder, VAE):
python scripts/acquire-huggingface-model.py acquire-file --profile flux2-klein-4b --models-dir "$M"
python scripts/acquire-huggingface-model.py acquire-file --profile z-image-turbo --models-dir "$M"

# One explicit pin:
python scripts/acquire-huggingface-model.py acquire-file \
  --repo-id black-forest-labs/FLUX.2-klein-4b-fp8 \
  --revision 5b4408e59397a4a37ccb46afe426d8ed86379441 \
  --path flux-2-klein-4b-fp8.safetensors \
  --sha256 97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6 \
  --size 4070624520 \
  --models-dir "$M" --directory diffusion_models   # --name defaults to the basename of --path
```

`--profile` reads the pins from `IMAGE_GENERATE_MODEL_PROFILES` in `src/image-generate-operation.ts`, exported with `bun` from the repository root; without `bun`, pass the same JSON shape with `--profiles-file <json>`. An unknown profile fails before anything is downloaded.

**Idempotency.** A destination whose bytes and receipt match the pin is a no-op: nothing is downloaded and neither file is rewritten, so re-running a profile fetches only missing files. A destination with different bytes, or a receipt that records a different pin, fails closed and is left untouched; remove it yourself if it should be replaced. A file whose bytes match the pin but has no receipt gets a receipt (the revision is resolved; nothing is downloaded).

**Licence: record only.** Per the owner decision on [#225](https://github.com/moritzbrantner/asset-tooling/issues/225), the receipt records the licence that the model card declares at the resolved revision (`license.observed`, `null` if none). There is no check and acquisition never fails on it; reviewing the terms stays with the person choosing the model.

### Receipt format (`schemaVersion` 1)

`<name>.receipt.json` sits beside the model file. It is local evidence and is not committed.

```json
{
  "schemaVersion": 1,
  "kind": "huggingface-single-file",
  "provider": "huggingface",
  "repository": { "id": "owner/model", "requestedRevision": "main", "resolvedRevision": "<40-hex commit>" },
  "file": { "path": "<path in repository>", "name": "<file name>", "directory": "diffusion_models", "sha256": "<64-hex>", "byteLength": 123 },
  "license": { "observed": "apache-2.0" },
  "acquirer": { "id": "asset-tooling.huggingface-single-file", "version": "1", "implementationSha256": "<sha256 of the script>", "huggingfaceHub": "<version>" }
}
```

The key sets are exact; a change to them is a new `schemaVersion`. `HF_TOKEN` is used for gated repositories but is never written to the receipt.

### Offline verification of a placed file

```sh
python scripts/acquire-huggingface-model.py verify-file --file "$M/diffusion_models/flux-2-klein-4b-fp8.safetensors"
```

`verify-file` does not contact Hugging Face. It fails when the receipt is missing or malformed, names another file or directory, or when the file's byte length or sha256 differs from the receipt.

## Hosted acquisition

The manually dispatched **Hugging Face model acquisition evidence** workflow accepts `repo_id`, `revision`, and a required `expected_license`. It produces the same bundle and receipt, immediately runs the offline verifier, and uploads both as a short-lived workflow artifact for review or downstream promotion.

If the repository is gated, configure an `HF_TOKEN` Actions secret with only the access needed to read that model. The workflow has repository `contents: read` permission and does not mutate `main` or promote model bytes automatically.

## Reproducibility boundary

The receipt records the exact acquisition script SHA-256 and `huggingface_hub` version in addition to the provider revision and model bytes. Re-running acquisition should reproduce the same deterministic bundle when the same immutable snapshot bytes are returned, but the final bundle SHA-256 remains the authority. Model generation still proves its own reproducibility by replaying the backend and comparing generated output bytes.
