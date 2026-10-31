# Battle Royale fortress kit

The fortress kit (#445) is the authored art for the shared Battle Royale fortress ([battle-royale #31](https://github.com/moenarch-games/battle-royale/issues/31)), which MMORPG draws as graybox today ([mmorpg #552](https://github.com/moenarch-games/mmorpg/issues/552)). `battle_royale_core::arena` stays the only definition of the geometry. Every piece of this kit is dressing over one of its collider boxes, ramp wedges or lift pillars: it is built at exactly that box's size and never reaches outside it, so the art never changes traversal.

- Recipe: [`adapters/blender/fortress.py`](../adapters/blender/fortress.py), one run per piece and level of detail.
- Build: `ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-fortress-kit.ts --out <directory>` (snap Blender: `TMPDIR` under `$HOME`). It reads the hydrated CC0 textures from `assets/canonical/`.
- Release: the rolling `fortress-kit` GitHub release (`fortress.kit.tar` and `export.ref.json`), published by CI when the recipe or build changes.
- Fitted to: `moenarch-games/battle-royale` at `d633da2`. The build's layout table is a transcription of `arena.rs`; `bun scripts/build-fortress-kit.ts --pieces` prints it, and it matched all 97 bodies of the real `arena::content()` (ids, centres, half extents and ramp rises) when the kit was made.

## Pieces

Each piece's frame is metres, glTF right-handed +Y up. Its origin is the base centre of the box it fits (`fits.size` = [width X, height Y, depth Z]). Outward (away from the arena centre, for the south side) is −Z. Ramps rise towards +Z.

| Key `fortress.kit.<part>` | Fits (m) | Dresses | Look |
| --- | --- | --- | --- |
| `curtain-wall` | 83 × 8 × 4 | the 8 curtain-wall runs beside the gates | coursed rubble, ashlar plinth, string course and coping, quoins at both ends, a pilaster per 8 m module on the courtyard face, arrow slits and a corbel table on the outer face, flagstone wall walk |
| `gate-lintel` | 6 × 2 × 4 | the 4 gate lintels | flat arch of voussoirs with a raised keystone on both faces, the raised portcullis in its slot and two murder holes in the underside |
| `parapet` | 172 × 1 × 0.6 | the 4 outer parapets | ashlar with 1.5 m merlons and 0.9 m crenels, cross slits in every other merlon |
| `corner-tower` | 7.2 × 16 × 7.2 | the 4 corner towers | quoins, string courses at the wall walk and at 12 m, corbel table, slits on three levels, two Marshal-blue banners on each outward face, a plank hatch in the flagstone top |
| `central-tower` | 11.2 × 8 × 11.2 | the central tower on the keep roof | as the corner tower, with banners on all four faces |
| `keep-wall-long` | 15.1 × 7.5 × 1.2 | the keep's outer walls west of each door | rubble with ashlar dressings, blind windows with shutters on both faces, a banner beside the door |
| `keep-wall-short` | 6.1 × 7.5 × 1.2 | the keep's outer walls east of each door | as above |
| `hall-wall` | 2.6 × 7.5 × 1.2 | the central hall's walls beside its doors | as above, plain |
| `door-lintel` | 4 × 1.5 × 1.2 | the keep and hall door lintels | flat arch of voussoirs on both faces |
| `keep-roof` | 25.2 × 0.5 × 25.2 | all 15 keep-roof slabs, as one item | flagstone top, the four ramp openings, a joisted plank ceiling underneath, edge drains, and plank hatches over the four tower-lift shafts |
| `bridge` | 3 × 0.5 × 69.4 | the 4 bridges from the roof to the gate lintels | plank deck on dark stringers and joists, iron straps |
| `lift-column` | 2.7 × 7.5 × 2.7 | the 4 solid shafts under the tower lifts | an ashlar pier |
| `ramp-courtyard`, `ramp-tower`, `ramp-keep` | 4 / 3.4 / 3 × 8 × 12 | the 20 ramps (34°) | ashlar treads with dark nosings flush with the slope, ashlar kerbs along both edges, rubble side faces |
| `lift-courtyard`, `lift-tower` | 2.8 / 2.7 × 8 × same | the 8 lift pillars | a timber crib: dark posts and rails, braced plank panels and an iron-edged plank platform on top |

Where the art departs from its box:

- **Crenels.** The parapet's crenels dip 0.28 m below the collider's top (9 m). It is the only visible step, and a character rarely stands on a parapet.
- **Lift hatches.** The keep roof's hatches over the tower-lift shafts are 5 cm below the roof top, so the lift's platform at its low stop (flush with the roof at 8 m) never z-fights the roof.
- **Buried corners.** `keep-wall-long` and `hall-wall` leave the 1.2 m corner square at their −X end to the perpendicular wall that shares it, and `lift-column` stands 10 cm inside its box, clear of the lift pillar that shares its footprint. Nothing draws two coplanar faces in one place.
- **Relief.** The wall faces stand 6 cm inside the box; plinths, string courses, copings, quoins and pilasters are flush with it. Slits, windows, the portcullis slot and the drains are cut into the solid.

## Look and materials

Four tileable CC0 Poly Haven PBR sets at 2K are declared inputs, catalogued in `catalog/sources.json` and stored in `assets/canonical/`. The recipe resizes them to 1024 px; every piece and level uses the same images, so the bundle stores each once.

| Material | Source | Tile |
| --- | --- | --- |
| `wall` (rubble faces) | `castle_wall_slates` | 2.6 m |
| `trim`, `trimDark` (dressings) | `japanese_stone_wall` | 2.2 m |
| `floor` (every walkable top) | `stone_tiles_02` | 3 m |
| `wood`, `woodDark` (bridge, lifts, hatches, shutters) | `old_planks_02` | 2 m |

The UVs are world-scale per face (horizontal faces map X/Z; the others their horizontal tangent and its upward partner). Iron, the Marshal-blue banner cloth, its pale trim and the dark `void` inside openings are plain colours. Every face is backface-culled. As in greyhaven-nature, the normal maps ship without tangents (the import allows `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE`): MikkTSpace gives zero tangents on some long slivers of the boolean-cut faces, so the runtime generates them.

## Levels of detail

Each piece ships `default` (LOD0), `lod1` and `lod2`, built by the same recipe in the same frame, so a consumer swaps them in place. `lod1` drops quoins, corbels, slit surrounds, voussoir joints, braces and banner trims. `lod2` keeps the main masses, walkable tops, the roof openings and the materials. The descriptor uses the greyhaven-nature format (#449, [greyhaven-nature-bundle.md](greyhaven-nature-bundle.md#lod-metadata)): a top-level `lodSelection` and per asset `lods: { boundingSphere, levels[] }`, switching at screen sizes 0.35 and 0.12.

## Descriptor `fortress-kit-descriptor-v1`

The canonical JSON attachment `fortress-descriptor` of `fortress.kit.curtain-wall` (schema [`schemas/fortress-kit-descriptor-v1.schema.json`](../schemas/fortress-kit-descriptor-v1.schema.json)):

- `source`: the battle-royale repository, revision and module the kit is fitted to.
- `assets[]`: `key`, `role`, `fits` (`size`, and `rises: "+Z"` for ramps), `holes`/`hatches` (the keep roof, [x0, z0, x1, z1] m), `leavesToNeighbour`, `triangles`, measured `bounds`, `materials` and `lods`.
- `composition.items[]`: `{ key, part, origin, yawDegrees, bodies[] }` in mmorpg-core units. `bodies` are the arena bodies the item dresses, exactly as the shared zone holds them: `{ kind: collider | ramp | lift, body, part, position, halfExtents, rises? }` (a lift's `position` is its low stop). Every item has one body except the keep roof, which covers all 15 `Floor` slabs. `composition.undressed` lists the ground.

## Adopting it in MMORPG

MMORPG draws the fortress as graybox: `arena_presentation::shared_scenery` turns each collider into `graybox-wall`, `graybox-tower` or `graybox-walkway` and each ramp into a `graybox-ramp` wedge (`Scenery::graybox`), and the unit presenter draws the lifts. To replace it with the kit, the way the Outpost kit (#420) replaced its blockouts:

1. **Fetch.** Add `fetch_rolling fortress-kit fortress.kit scenery/fortress.kit` to `scripts/fetch-bundles.sh`, and embed `web/public/scenery/fortress.kit` in the native build (`build.rs`, as `outpost_bundle.rs`).
2. **Match bodies.** Read the descriptor (`readAssetBundleAttachment(dir, manifest, "fortress.kit.curtain-wall", "default", "fortress-descriptor")`). For each `composition.items[]` entry, use it only if every one of its `bodies` matches a body of `arena::content()` exactly: a collider by `id`, `position` and `half_extents`; a ramp by `body`, `position`, `half_extents` and `rises`; a lift by its platform `body`, `low` and `half_extents`. A body no item matches keeps its graybox, so a later arena change degrades to graybox instead of misplaced art.
3. **Place.** Draw `item.key` at `item.origin` (units → metres) turned by `item.yawDegrees` about +Y; 90° turns +Z to +X, the convention `Scenery::graybox` already uses for `RampRise::PosX` (yaw 16 384). The statics are placed once, like `outpost_kit::parts`.
4. **Hide graybox.** Drop the graybox prop of every matched body once the kit's entries have loaded; keep graybox as the fallback while the bundle loads or if it fails (`Motion::Fallback`, as the Outpost does). Keep the collider ids on the kit draws so camera occlusion still treats them as structures.
5. **Lifts.** Draw `fortress.kit.lift-courtyard` and `fortress.kit.lift-tower` instead of the unit presenter's lift boxes, each at `Platform::centre_at(tick)` minus `half_extents[1]` in y, so the crib's top is the platform's top.
6. **LOD.** Choose `default`, `lod1` or `lod2` per piece from `lodSelection` (three.js `LOD`, or the native client's screen-size test). The long pieces (curtain walls, parapets, bridges) have large spheres and stay at LOD0 across most of the arena.
7. **Ground.** The courtyard lifts' platforms rest flush with the ground (y = 0) at their low stop; leave the terrain out under the four 2.8 m footprints (or draw it 1 cm lower there) so the platform does not z-fight it.

## Review

Reviewed in the live Blender (MCP) with every piece placed by the composition: from the game camera (12 m, 0.42 rad pitch, 50° vertical FOV) in the courtyard, on the wall walk and at the keep door, an overview, and close-ups of the gate, keep door, tower, ramp and lift. A selection is in [`review/fortress-kit/`](../review/fortress-kit/): the wall walk and the keep roof from the game camera, the keep door, a lift crib at its high stop, a courtyard ramp and an overview.

| Piece | Triangles (`default` / `lod1` / `lod2`) |
| --- | --- |
| `curtain-wall` | 5,178 / 860 / 44 |
| `parapet` | 3,012 / 1,716 / 12 |
| `corner-tower` | 4,500 / 460 / 60 |
| `central-tower` | 3,480 / 508 / 60 |
| `keep-roof` | 1,076 / 864 / 156 |
| `bridge` | 1,532 / 980 / 44 |
| `lift-courtyard`, `lift-tower` | about 1,170 / 880 / 100 |
| ramps | 578 / 578 / 8 |
| keep and hall walls, lintels, `lift-column` | 300–1,600 / 76–434 / 44–144 |

The whole fortress (82 items) is about 131,000 triangles at LOD0. The tar is about 5.8 MB: 12 shared 1024 px JPEGs (four sets × colour, normal and metallic-roughness) and the geometry.

## Tests

`test/blender/fortress/fortress-kit.test.ts` (its own `blender-script (fortress)` CI suite, with a 60-minute timeout):

- without Blender: the spec arguments; the composition dresses every arena body but the ground exactly once, each single-body item's turned and moved piece box equals its body's box exactly, and every ramp rises the right way;
- in the hosted `blender-script` job: the tar and bundle verify with 17 pieces × 3 levels; the descriptor conforms to its schema; at most 12 images are stored; no vertex of any piece at any level leaves its fitted box; the levels get cheaper.
