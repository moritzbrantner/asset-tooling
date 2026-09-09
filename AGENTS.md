# asset-tooling agent contract

## Purpose

`asset-tooling` owns reproducible asset-generation and processing contracts. It does not own game-specific runtime semantics.

## Boundaries

- Asset intent is declared in versioned specs. Generators consume validated specs instead of ad-hoc prompts or ambient state.
- Generation receipts are evidence. They record the declared spec hash, generator/model identity, input hashes, execution fingerprint, and output hash.
- Exact reproducibility is earned by rebuilding and comparing output bytes; it is never inferred from the presence of a seed alone.
- Verification is non-mutating. Generation and receipt creation are explicit mutations and must reconcile existing output instead of rewriting identical files.
- Stable machine-visible paths are portable `/`-separated paths relative to the asset spec directory. Do not make behavior depend on the caller's working directory.
- Generator backends must fail closed when a declared model, input, runtime requirement, or hash does not match.
- Network acquisition is separate from generation. Once declared model/input dependencies are present, deterministic generation and verification must not require hidden downloads.
- Generated artifacts are disposable by default. Commit an output or receipt only when a consumer/distribution contract intentionally requires it.

## Validation

Run `bun test` for the current slice. The test suite covers canonical hashing, schema validation, fail-closed dependency checks, idempotent generation, exact rebuild verification, output tampering, and environment drift reporting.
