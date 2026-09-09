# Traceable asset generation

`asset-tooling` treats procedural generation and model-backed generation as the same kind of build problem: a versioned asset specification is resolved to output bytes, and the tool records enough evidence to explain and replay that result.

## Ownership boundary

`asset-tooling` owns:

- validated, versioned generation specifications;
- canonical parameter hashing;
- declared input and model identity verification;
- generator adapter invocation;
- environment fingerprints;
- output hashing and idempotent writes;
- replay verification and reproducibility classification;
- portable generation receipts.

The generator owns the generation algorithm. A procedural geometry/noise implementation remains authoritative for its own semantics. Stable Diffusion, TripoSR, or another model runtime remains authoritative for model inference. `asset-tooling` must not reimplement those algorithms merely to make provenance easier to record.

## Generator kinds

Generation receipt v2 classifies the selected backend as one of:

- `procedural` — deterministic or seeded code-defined generation such as geometry, terrain, textures, SVGs, or audio synthesis;
- `model` — local model inference such as Stable Diffusion or TripoSR;
- `utility` — architecture/test helpers such as the built-in copy backend.

The kind is descriptive evidence, not a reproducibility claim. A procedural backend can still be nondeterministic, and a model backend can sometimes reproduce exact bytes under a sufficiently constrained environment.

## Reproducibility rule

A seed is an input, not proof.

The receipt records the declared randomness contract, generator identity, model/input hashes, normalized parameters, environment fingerprint, and output hash. Exact reproducibility is earned only when replay produces the accepted output bytes again. GPU kernels, drivers, numerical libraries, precision, schedulers, model revisions, post-processing libraries, or generator implementation changes can all affect bytes even when the same seed is reused.

Model adapters therefore default to an approximate baseline unless the adapter explicitly declares exact capability. Verification still performs replay and reports whether the bytes actually match.

## Receipt versions

`generation-receipt-v1.schema.json` is published and remains immutable.

`generation-receipt-v2.schema.json` adds:

- explicit generator `kind`;
- normalized `parameters` in addition to their canonical SHA-256;
- deterministic backend `observations` for replay-relevant facts that are not invocation parameters.

Receipts intentionally do not record timestamps, host names, user names, absolute checkout paths, wall-clock timings, or other ambient values that make otherwise equivalent builds appear different.

## Model dependency rule

Model acquisition is separate from generation. A model adapter may consume only dependencies already declared by the asset spec and present locally. Hidden downloads during generation or verification are a contract failure.

For model-backed generation, every output-affecting model/checkpoint/config/input file must be represented by a declared portable path and SHA-256 before inference starts. Runtime packages, accelerators, drivers, precision modes, and numerical backends belong in the environment fingerprint or deterministic observations as appropriate.

## Pipeline

The intended lifecycle is:

1. validate the asset spec;
2. verify all declared inputs and model bytes;
3. invoke the authoritative generator;
4. hash and reconcile the generated output;
5. write the generation receipt;
6. optionally feed the generated artifact into versioned processing operations;
7. replay later to prove or disprove exact reproduction.

Generation and processing stay separate so a Stable Diffusion image, a TripoSR mesh, or a procedural mesh can all pass through the same later normalization, simplification, LOD, compression, packaging, and catalog stages without losing provenance.
