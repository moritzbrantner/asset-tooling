# asset-tooling

Reproducible, traceable tooling for generating and processing game and application assets.

The repository treats generated assets as build artifacts. Generation intent, generator/model identity, inputs, execution environment, outputs, and verification evidence are recorded so that reproducibility can be tested instead of assumed.

## Direction

The initial slice establishes:

- versioned asset specifications;
- generation receipts with cryptographic hashes;
- environment fingerprints;
- explicit reproducibility states;
- exact artifact verification;
- deterministic test fixtures before any model-specific backend is introduced.

Model adapters, image/3D processing, catalogs, and consumer integrations build on that contract rather than defining their own provenance formats.
