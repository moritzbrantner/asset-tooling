# TypeScript migration

`asset-tooling` authors application, library, test, build, and repository-validation code in TypeScript. Plain JavaScript is retained only where JavaScript itself is part of an interoperability fixture or external runtime contract.

## Migration boundary

The initial conversion preserves behavior by moving the existing authored JavaScript modules to `.ts` without rewriting their algorithms. Package exports, the CLI, workflows, tests, and repository checks point at the TypeScript files, while the existing behavioral and stability suites remain the regression authority.

TypeScript semantic validation starts at `scripts/check-package-shape.ts`, the package/public-wiring authority. It is compiled under the full strict configuration in `tsconfig.json`, including unchecked-index and exact-optional-property diagnostics. This makes the conversion type-aware without masking the existing codebase behind `@ts-nocheck` directives or coupling a language migration to unrelated algorithmic rewrites.

The mechanically migrated implementation still contains JavaScript-era inferred shapes such as accumulator arrays, incrementally constructed objects, and option bags whose intended contracts are not yet explicit. Expanding semantic compiler coverage is therefore follow-up convergence work: add explicit domain types at stable module boundaries, then add those modules to the strict TypeScript project. New or substantively changed TypeScript code should not introduce new untyped migration debt.

## Completion criteria for later typing slices

A module is ready to join the strict project when its public parameters and return values have explicit stable types, mutable accumulators do not rely on empty-literal inference, runtime-validated external data is narrowed before domain use, and its existing behavioral tests remain unchanged or become stricter. Add modules to `tsconfig.json` only with their transitive dependencies so the compiler gate remains deterministic and actionable.
