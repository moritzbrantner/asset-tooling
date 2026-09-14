# Medieval character material package

The medieval character dogfood now carries deterministic visual material intent alongside the generated OBJ geometry.

## Material factors

`asset-tooling/recipes/medieval-character-materials` exposes three visual palettes (`burgundy`, `azure`, and `neutral`) over one shared set of semantic material roles:

- `cloth-primary`
- `cloth-secondary`
- `skin`
- `leather`
- `wood`
- `steel`
- `string`

Each material is represented as renderer-neutral PBR metallic/roughness factors using explicit 8-bit values: sRGB base color, metallic, roughness, and double-sided intent. No shader equation, light model, GPU resource, or faction rule is encoded here.

Every named OBJ group produced by the character recipe has exactly one material-role binding. This makes the current placeholder models visually packageable without making body-part names authoritative for combat or equipment semantics.

## Package manifest

The example build now emits:

- `soldier.obj`
- `archer.obj`
- `knight.obj`
- `manifest.json` — exact geometry hashes/topology/bounds
- `materials.json` — palette factors and part bindings
- `package.json` — the combined geometry/material contract plus downstream processing intent

The processing plan is explicitly marked `intent-only`. It requests `3d-lab` as the authority for source-based LOD derivation and GLB packaging, with 100%, 50%, and 25% triangle-budget levels. Those derived files are not claimed as evidence until a `3d-lab` processor actually produces and verifies them.

This distinction is deliberate: `asset-tooling` owns reproducible asset intent, composition evidence, and orchestration; `3d-lab` owns shared mesh/format semantics; Medieval owns which visual palette is selected for a rendered unit and keeps gameplay state in `medieval-core`.
