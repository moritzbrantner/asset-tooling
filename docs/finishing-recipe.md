# Asset finishing recipe

The finishing recipe ([#120](https://github.com/moritzbrantner/asset-tooling/issues/120), [Atlas Decisions 5.1.6 and 5.1.7](decisions/atlas.md)) takes one editable source, inspects it, applies only the repairs the caller declares, and exports a separate finished GLB with a lineage report. It is one small public recipe (`asset-tooling/recipes/finishing`, [`src/finishing-recipe.ts`](../src/finishing-recipe.ts)) over Blender, not a mesh-repair framework. Blender does every geometry, normal, UV and bake step. [`adapters/blender/finish.py`](../adapters/blender/finish.py) only selects and orders Blender's operators and records what they changed.

## Use

```sh
git lfs pull --include="assets/authored/outpost-kit.blend,assets/canonical/quaternius.fantasy-props-megakit-standard.*/**"
bun scripts/finish-asset.ts examples/finishing/starter-barrel.finish.json --out <directory>
bun scripts/finish-asset.ts examples/finishing/outpost-door.finish.json --out <directory>
```

`<directory>` is the object store. The Blender workspace (declared inputs, spec, receipt and generation cache) is `<directory>/work/<name>`. The finished asset is promoted to `<directory>/finished/<name>.glb` and `<name>.finish.json`. The build needs the pinned Blender (`ASSET_TOOLING_BLENDER`) and the hydrated LFS source. It needs no network and no GPU, and takes a few seconds per asset.

Two committed recipe files show the same steps on two kinds of source:

| Recipe | Source | Repairs | Placement |
| --- | --- | --- | --- |
| [`starter-barrel`](../examples/finishing/starter-barrel.finish.json) | The #118 starter barrel, a catalog glTF (`quaternius.fantasy-props-megakit-standard.barrel-gltf`) with its buffer and six trim textures, resolved through `catalog/storage.json` | `apply-transforms`, `merge-by-distance`: the importer's 1305 split vertices are welded to 486 and the boundary edges drop from 1306 to 144. The authored normals, UVs, vertex colours and both textured materials are kept. | `greyhaven.barrel` |
| [`outpost-door`](../examples/finishing/outpost-door.finish.json) | The `outpost.door` collection of the first-party [`assets/authored/outpost-kit.blend`](outpost-kit.md) | `apply-transforms`, `merge-by-distance`, `recalculate-normals`, `weighted-normals` | `outpost.door.finished` |

To make a deliberate change, edit the recipe file and rerun into the same `--out`. For example, set `parameters.edits.scale` to `[1, 1.25, 1]` for a taller barrel, or `parameters.edits.materials` to `{ "outpost-wood": { "baseColor": [0.25, 0.12, 0.05, 1], "roughness": 0.7 } }` for the door. Only that asset's Blender step reruns. An unchanged recipe is a generation-cache hit, and nothing under `finished/` is rewritten. To change the shape itself, edit the source `.blend` in Blender 5.2.2 (see [outpost-kit.md](outpost-kit.md#editing-the-geometry)), save it, and rerun. The new source hash invalidates the build.

## Recipe file `finish-recipe-v1`

| Field | Meaning |
| --- | --- |
| `name` | The output basename (lowercase letters, digits, `.` and `-`). |
| `assetId` | The receipt's asset id. |
| `source` | `{ "catalog": <source id> }`, a canonical glTF/GLB read and verified through the storage manifest, or `{ "authored": "assets/authored/<name>.blend" }`. |
| `resources` | Catalog glTF only: every buffer and image URI of the source, mapped to its catalog source id. |
| `place` | Optional `{ "parentName" }`. The finished scene is wrapped by [`scene.place.gltf@1`](gltf-place.md) with the footprint's base centre at the origin. |
| `parameters` | The finishing parameters below. |

## Parameters

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `source` | `{ "format": "gltf" }` or `{ "format": "blend", "collection": <name> }` (the collection is appended, never linked). |
| `edits.scale` | Factors in the glTF frame (X, Y up, Z), applied to the root objects. Default `[1, 1, 1]`. Each factor is in 0.01–100. |
| `edits.materials` | `{ <material>: { baseColor?: linear RGBA, roughness?, metallic? } }`, set on the material's Principled BSDF. Default `{}`. |
| `repairs` | An ordered list of unique repairs from the table below. Default `[]`, which means inspect and export only. |
| `policy.maxTriangles` | The finished triangle budget. |

| Repair | Blender step |
| --- | --- |
| `apply-transforms` | Applies rotation and scale (`object.transform_apply`). Translation is placement, which belongs to `scene.place.gltf@1`. |
| `merge-by-distance` | `bmesh.ops.remove_doubles` at 1e-5 m. Loop UVs and custom normals are kept. |
| `recalculate-normals` | `bmesh.ops.recalc_face_normals`: consistent outward winding. |
| `weighted-normals` | An applied `WEIGHTED_NORMAL` modifier with *keep sharp*. |
| `uv-unwrap` | A new `UVMap`, Smart UV Project, and pack with a 2 % island margin. Only for meshes without UVs. |
| `bake-ao` | A 512 px Cycles AO bake (32 samples, 0.1 m, seed 0) per mesh, bound as the glTF `occlusionTexture` through the `glTF Material Output` group, the same binding the [armour plates](armor-recipes.md) use. |

## Inspection, rejection and the report

`finish.py` inspects the source before and after finishing: per mesh, the vertex and triangle counts, the rotation and scale, the translation and negative scale, the topology (non-manifold and boundary edges, loose vertices, degenerate faces, n-gons), custom normals, the UV layers, colour attributes, vertex groups and shape keys, the material slots and skinning. Per material, it records the base colour, roughness, metallic and images. It also records the scene's dimensions in the glTF frame.

The recipe fails closed, and exports nothing, for:

- a glTF buffer or image URI that is not a declared input, an external image in a `.blend`, or a datablock linked from another library;
- a missing collection, a source without a mesh, or animation data (this recipe does not finish clips);
- an empty material slot or a mesh without a material;
- `apply-transforms` or `bake-ao` on a skinned or shape-keyed mesh, because they would break the binding;
- `uv-unwrap` on a mesh that already has UVs, because it would orphan the authored texture mapping;
- `bake-ao` without exactly one UV layer, or on a material shared between meshes;
- a material edit that names a missing material, or a factor that a texture drives;
- any UV layer, colour attribute, vertex group, shape key or material present before finishing and missing after;
- a triangle count over `policy.maxTriangles`.

The exported GLB then passes the production gate [`scene.import.gltf@2`](gltf-import.md) (`requireNormals`, the same triangle budget, and only the `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` warning, owner decision Q1 on #118), and the optional placement. Only after every step has succeeded is the GLB promoted, and then its report. Each is written through a temporary file and a rename. A failed run leaves an earlier promoted result byte for byte as it was.

`<name>.finish.json` (`finish-report-v1`) holds the lineage: the source path, SHA-256 and byte length with its catalog id or authored path, every resource, the normalised parameters, the Blender version and recipe SHA-256, the before/after inspection, each applied repair with what it changed, `lostAttributes` (always empty in an accepted report), the exported hash, the production gate's result and the placement. The source file is only read. Blender appends or imports from a verified snapshot and never saves, so the source/master bytes stay untouched.

## Reproducibility

The spec declares `exact` replay unless `bake-ao` is used. `verify` replayed the committed barrel and door byte for byte with Blender 5.2.2 on linux-x64. The Cycles AO bake is declared `approximate`. Exactness is demonstrated only for that Blender build and platform. Another Blender release changes the receipt's environment, as in [blender-script.md](blender-script.md#updating-blender).

## Ownership

The recipe prepares and exports. It does not decide art. The barrel keeps its faceted staves: `weighted-normals` would smooth them, which is an art choice left to its owner. The door keeps its placeholder materials, which the [outpost kit](outpost-kit.md) dresses. Kit recipes that already finish their own pieces, such as the armour plates' bevel, weighted normals and AO, keep doing so. Games own placement in the world and gameplay semantics.

Tests: `test/finishing-recipe.test.ts` covers parameter validation and invalidation without Blender. `test/blender/recipes/finishing-recipe.test.ts` covers both real sources, unchanged-output reuse, a dimension edit and a material edit, failed runs that promote nothing, resource closure, and `uv-unwrap` with `bake-ao` on a fixture.
