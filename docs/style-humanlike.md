# Humanlike style spec

This is the written style spec for the **humanlike family**, the gear and props for mmorpg and arpg ([Atlas Decisions 1.1.1, 1.1.4, 1.1.6 and 1.1.7](decisions/atlas.md)). Scripted Blender recipes such as [`asset-tooling/recipes/weapons`](weapon-recipes.md) follow it. The cartoony My Farm family has its own rules.

## Look

- **Humanlike, WoW-inspired and original.** Pieces read like believable fantasy gear at an intermediate stylization: clear shapes, slightly bold proportions, and no photoreal detail. Recipes never copy or trace an existing game's or artist's design, logo or heraldry. Silhouettes are built from generic historical types, such as an arming sword or a heater shield.
- **Real-world-ish proportions.** Sizes stay close to real objects, in metres. An arming sword is about 0.95 m overall, and a heater shield is about 0.56 × 0.72 m. Any exaggeration should be slight, for example a thicker crossguard or a wider rim, so the piece still fits the Ranger's hands and forearms.
- **Readable at the gameplay camera.** Edges that matter for the silhouette, such as blade edges, guard ends, the pommel, the rim and the shield point, are modelled in the geometry instead of in textures. Small details may disappear at a distance.
- **Bevelled hard edges.** There are no knife-sharp 90° box corners. Hard surfaces get explicit chamfers or bevelled cross-sections. Shading is smooth below 35° and split at sharper angles and at material borders, so the exported normals show crisp edges without faceting curved parts.

## Materials

Materials are PBR metal-roughness, using **factors only**: base colour, metallic and roughness. They have no textures and no UVs. This keeps the recipes small and exactly reproducible (see [blender-script.md](blender-script.md#determinism)). Each piece uses a short shared palette with lowercase names:

| Material | Base colour (linear) | Metallic | Roughness | Use |
| --- | --- | --- | --- | --- |
| `steel` | 0.62, 0.64, 0.66 | 1 | 0.32 | blades |
| `iron` | 0.29, 0.28, 0.27 | 1 | 0.48 | guards, pommels, rims, bosses |
| `leather` | 0.20, 0.10, 0.05 | 0 | 0.72 | grips, straps, handles |
| `wood` | 0.34, 0.22, 0.12 | 0 | 0.78 | shield backs and edges |
| `paint` | 0.04, 0.07, 0.18 | 0 | 0.62 | shield faces |

Procedural detail stays in the geometry and stays small: a helical leather wrap on a grip, a fuller in a blade. Textures, decals and heraldry are later work.

## Budgets

| Piece | Triangle ceiling |
| --- | --- |
| one-handed weapon (`sword.arming`) | 2,500 |
| shield (`shield.heater`) | 3,000 |

A recipe's `maxTriangles` may lower the ceiling but never raise it. Python and TypeScript both reject a higher value. The presets use about half the budget: 1,304 triangles for the sword and 1,706 for the shield.

## Conventions

- **Units and axes:** metres and glTF right-handed **+Y up**, the same as the Ranger ([humanoid-ranger.md](humanoid-ranger.md#conventions)).
- **Origin = grip.** Every held item's origin is its grip frame, and the GLB contains an empty node named **`grip`** at that origin with an identity transform. Sockets in [humanoid-sockets-v1](humanoid-sockets.md) place this frame. Each piece documents its own frame:
  - **sword:** the centre of the hand's contact on the grip. The blade points along +Y, the cutting edges along ±X, and the flats face ±Z.
  - **shield:** the centre of the hand handle, which runs along X. The face points to +Z, the point to −Y, and the forearm runs from the handle along +Y to the forearm strap. The back of the hand and the forearm rest against the board.
- **Naming:** a piece id is `<category>.<type>`, for example `sword.arming` or `shield.heater`. The mesh node takes the piece id, the geometry is named `<piece>-geometry`, and the materials use the lowercase names in the table above.
- **Determinism:** recipes take no seed and use no randomness. Generation uses `randomness: none` and exact reproducibility, so a rebuild must produce the same bytes.
