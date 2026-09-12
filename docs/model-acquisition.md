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

## Hosted acquisition

The manually dispatched **Hugging Face model acquisition evidence** workflow accepts `repo_id`, `revision`, and a required `expected_license`. It produces the same bundle and receipt, immediately runs the offline verifier, and uploads both as a short-lived workflow artifact for review or downstream promotion.

If the repository is gated, configure an `HF_TOKEN` Actions secret with only the access needed to read that model. The workflow has repository `contents: read` permission and does not mutate `main` or promote model bytes automatically.

## Reproducibility boundary

The receipt records the exact acquisition script SHA-256 and `huggingface_hub` version in addition to the provider revision and model bytes. Re-running acquisition should reproduce the same deterministic bundle when the same immutable snapshot bytes are returned, but the final bundle SHA-256 remains the authority. Model generation still proves its own reproducibility by replaying the backend and comparing generated output bytes.
