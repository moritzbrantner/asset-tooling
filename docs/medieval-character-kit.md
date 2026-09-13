# Medieval character kit dogfood

This slice uses `asset-tooling` itself to assemble a small set of recognizable low-poly game characters from the existing deterministic procedural OBJ primitives.

## Initial assets

The first recipe version generates three static archetypes:

- `soldier` — humanoid body, shield, and spear;
- `archer` — humanoid body, bow/string proxy, and quiver;
- `knight` — heavier body, helmet, pauldrons, shield, and sword.

The output is intentionally simple. These are gameplay-readable placeholder meshes for exercising the asset pipeline, not final art.

All models are right-handed Y-up OBJ meshes expressed in millimeter units with the existing procedural mesh fixed-point precision. Consumers that work in meters should apply the declared `0.001` scale. Named OBJ groups retain semantic part names so later processing can identify equipment/body regions without making those names authoritative for gameplay behavior.

## Build

Run:

```text
bun examples/medieval-character-kit/build.mjs
```

The build writes disposable outputs to `build/medieval-character-kit/`:

- `soldier.obj`
- `archer.obj`
- `knight.obj`
- `manifest.json`

The manifest binds each model to its SHA-256, byte length, topology counts, bounds, part names, coordinate system, unit, and recipe version. Re-running the build with the same `asset-tooling` revision must reproduce identical bytes.

Generated files remain build artifacts rather than committed canonical assets. A downstream game may intentionally package them, but doing so is a consumer/distribution decision rather than a reason for `asset-tooling` to redefine its storage boundary.

## Ownership boundary

`asset-tooling` owns the versioned recipe, deterministic composition, evidence, and export bytes. It does not own medieval unit statistics, combat state, animation state machines, equipment legality, or renderer behavior.

The current recipe composes the already-authoritative box, cylinder, and UV-sphere procedural generators rather than introducing duplicate primitive geometry implementations.

## Follow-up slices

The useful next steps are:

1. generalize the composition layer into a reusable typed `mesh.compose` operation instead of keeping the first dogfood recipe specialized;
2. add deterministic material bundles and palette variants for factions/classes;
3. export processed GLB packages after the mesh/LOD pipeline rather than teaching the recipe a second mesh format;
4. add a small humanoid rig contract and externally-owned animation processing for idle/walk/attack/shoot/block clips;
5. add LOD0/LOD1/LOD2 evidence and preview renders to the Pages asset browser;
6. pin an accepted `asset-tooling` revision in `medieval` and generate/package these assets through the existing consumer workflow before replacing renderer placeholders.

Mounted cavalry, horses, siege crews, facial detail, cloth simulation, and high-detail AI/model-backed generation are deliberately outside this first slice.
