# TypeScript migration

`asset-tooling` authors application, library, test, build, and repository-validation code in TypeScript. Plain JavaScript is retained only where JavaScript itself is part of an interoperability fixture or external runtime contract.

## Migration boundary

The initial conversion preserves behavior by moving the existing authored JavaScript modules to `.ts` without rewriting their algorithms. Package exports, the CLI, workflows, tests, and repository checks point at the TypeScript files, while the existing behavioral and stability suites remain the regression authority.

TypeScript semantic validation starts at `scripts/check-package-shape.ts`, the package/public-wiring authority. It is compiled under the full strict configuration in `tsconfig.json`, including unchecked-index and exact-optional-property diagnostics. This makes the conversion type-aware without masking the existing codebase behind `@ts-nocheck` directives or coupling a language migration to unrelated algorithmic rewrites.

The mechanically migrated implementation still contains JavaScript-era inferred shapes such as accumulator arrays, incrementally constructed objects, and option bags whose intended contracts are not yet explicit. Expanding semantic compiler coverage is therefore follow-up convergence work: add explicit domain types at stable module boundaries, then add those modules to the strict TypeScript project. New or substantively changed TypeScript code should not introduce new untyped migration debt.

## Current strict coverage

The strict project now covers the package/public-wiring authority, deterministic identity foundation, and the core asset-operation contract:

- `scripts/check-package-shape.ts`;
- `src/canonical.ts` and `src/hash.ts`;
- `src/environment.ts` and its ordering regression;
- `src/tool.ts` and its source-tree fingerprint regression;
- `src/operations.ts`, including asset refs, ports, operation descriptors, registries, normalized inputs/results, build identities, and cache keys.

The tool identity hashes the authored `src/**/*.ts` tree. Its focused regression independently reconstructs that tree hash, so a future extension or runtime migration cannot silently leave `sha256-tree-v1` bound to obsolete JavaScript paths or an empty source set.

The operation boundary now treats externally supplied descriptors, asset refs, JSON metadata, parameters, and operation results as `unknown` until runtime validation has narrowed them into explicit domain contracts. That keeps existing fail-closed validation authoritative while giving storage, cache, processor, and operation-specific modules stable types to build on.

Later typing slices should expand outward from these typed deterministic and operation primitives into cohesive domain boundaries rather than adding isolated files solely to increase compiler coverage. The content-addressed asset store and cache layer are the next natural consumers.

## Completion criteria for later typing slices

A module is ready to join the strict project when its public parameters and return values have explicit stable types, mutable accumulators do not rely on empty-literal inference, runtime-validated external data is narrowed before domain use, and its existing behavioral tests remain unchanged or become stricter. Add modules to `tsconfig.json` only with their transitive dependencies so the compiler gate remains deterministic and actionable.
