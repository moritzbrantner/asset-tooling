# asset-tooling

Reproducible, traceable tooling for generating and processing game and application assets.

The repository treats generated and processed assets as build artifacts. Generation intent, generator/model identity, processing implementation, inputs, execution environment, outputs, and verification evidence are recorded so that reproducibility can be tested instead of assumed.

## Direction

The initial slice establishes:

- versioned asset specifications;
- generation and processing receipts with cryptographic hashes;
- environment fingerprints;
- explicit reproducibility states;
- exact artifact verification;
- deterministic test fixtures before any model-specific backend is introduced;
- a 3D-processing provenance contract for mesh simplification/LOD and animation baking/reduction without duplicating the domain algorithms.

Model adapters, image/3D processing, catalogs, and consumer integrations build on that contract rather than defining their own provenance formats.

See `docs/3d-processing.md` for the 3D processing boundary and `schemas/processing-receipt-v1.schema.json` for the first versioned receipt envelope.
