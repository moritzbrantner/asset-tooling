# Battle Royale fortress kit

The fortress kit (#445, pass 2 #459) is the authored art for the shared Battle Royale fortress ([battle-royale #31](https://github.com/moenarch-games/battle-royale/issues/31)), which MMORPG draws as graybox today ([mmorpg #552](https://github.com/moenarch-games/mmorpg/issues/552)). `battle_royale_core::arena` stays the only definition of the geometry. Every piece of this kit dresses one of its collider boxes, ramp wedges or lift pillars, built in that box's frame at its size.

- Recipe: [`adapters/blender/fortress.py`](../adapters/blender/fortress.py), one run per piece and level of detail.
- Build: `ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-fortress-kit.ts --out <directory>` (snap Blender: `TMPDIR` under `$HOME`). It reads the hydrated CC0 textures from `assets/canonical/`.
- Release: the rolling `fortress-kit` GitHub release (`fortress.kit.tar` and `export.ref.json`), published by CI when the recipe or build changes.
- Fitted to: `moenarch-games/battle-royale` at `d633da2`. The build's layout table is a transcription of `arena.rs`; `bun scripts/build-fortress-kit.ts --pieces` prints it, and it matched all 97 bodies of the real `arena::content()` (ids, centres, half extents and ramp rises) when the kit was made.

## Fit rule

What a character stands on or is blocked by matches the collider within 5 cm; decoration may leave the box where it cannot mislead play (#459). `fortressFit` in `scripts/build-fortress-kit.ts` states it per piece and `fortressFitViolations` checks it on every built level:

- **Walks.** Every walkable top (wall walks, tower and gate tops, the keep roof less its ramp openings, bridge decks, lift platforms) and every ramp slope is flush with the box within 5 cm, and nothing stands in the 2.2 m of head room above it. The keep roof's lift hatches sit 5 cm down, the drains 3 cm.
- **Blocking faces.** Seen from outside, each blocking face (both faces of the curtain walls and keep walls, the gate passage's ends, the parapet, the tower sides, the ramp sides) shows its first surface within 5 cm of the box face, or further out where decoration stands in front of it. The rubble face is 4 cm in; plinths, string courses, copings, quoins, pilasters and relieving arches are flush. Openings (arrow slits, windows, putlog holes) are cut deeper on at most 8% of a face.
- **Decoration.** It may leave the box up to the piece's `reach`: full-height merlons above the parapet; battered talus, buttresses, plinth steps and rubble at the wall feet; the gatehouse's flanking towers, segmental arches and machicolated gallery; timber hoardings outside the parapet; machicolated crowns and pavilion roofs on the towers (eaves 2.6 m above their tops, on posts just outside them); a corbelled cornice and four bartizans at the keep roof's corners; deep stringers under the bridges; grime decals.
- **No false barriers.** A drop keeps no drawn barrier the collider lacks: the tower tops and the keep roof stay open at their edges, with their crowns and cornices below the walk.

## Pieces

Each piece's frame is metres, glTF right-handed +Y up. Its origin is the base centre of the box it fits (`fits.size` = [width X, height Y, depth Z]). Outward (away from the arena centre, for the south side) is −Z. Ramps rise towards +Z.

| Key `fortress.kit.<part>` | Fits (m) | Dresses | Look |
| --- | --- | --- | --- |
| `curtain-wall` | 83 × 8 × 4 | the 8 curtain-wall runs beside the gates | grey rubble on an ashlar plinth with string course, coping and quoins; outside, a battered talus, seven buttresses, two rows of deep arrow slits, putlog holes, a drip course and two timber hoardings (covered galleries on putlogs and struts, under lean-to shingle roofs); inside, pilasters every 8 m with relieving arches between them and a plinth step; rubble along both feet; flagstone wall walk |
| `gate-lintel` | 6 × 2 × 4 | the 4 gate lintels | the gatehouse: segmental arches of voussoirs on both faces, two chamfered flanking towers to 12.4 m with battered feet, slits and merlons, a machicolated gallery between them on corbels with murder holes, the raised portcullis in its slot |
| `parapet` | 172 × 1 × 0.6 | the 4 outer parapets | the 1 m parapet with 1.6 m merlons and 1 m crenels above it, coped, a slit in every other merlon; none inside the corner towers |
| `corner-tower` | 7.2 × 16 × 7.2 | the 4 corner towers | battered foot, quoins, string courses, deep slits on two levels, a machicolated crown (two-step corbels under a band 15 cm below the top) open where the wall walks' ramps arrive, a pyramidal shingle roof on corner posts and knee braces, banners on the outward faces, rubble |
| `central-tower` | 11.2 × 8 × 11.2 | the central tower on the keep roof | as the corner tower without the battered foot, its crown open where the four tower lifts arrive, banners on all faces |
| `keep-wall-long` | 15.1 × 7.5 × 1.2 | the keep's outer walls west of each door | rubble with ashlar dressings, deep windows with shutters and sills on both faces, a plinth step, a banner beside the door, rubble |
| `keep-wall-short` | 6.1 × 7.5 × 1.2 | the keep's outer walls east of each door | as above |
| `hall-wall` | 2.6 × 7.5 × 1.2 | the central hall's walls beside its doors | as above, plain |
| `door-lintel` | 4 × 1.5 × 1.2 | the keep and hall door lintels | segmental arches of voussoirs on both faces |
| `keep-roof` | 25.2 × 0.5 × 25.2 | all 15 keep-roof slabs, as one item | flagstone top, the four ramp openings, a joisted plank ceiling underneath, edge drains, plank hatches over the four tower-lift shafts, a corbelled cornice below the edge (clear of the bridges) and a bartizan with a conical roof hung on each corner |
| `bridge` | 3 × 0.5 × 69.4 | the 4 bridges from the roof to the gate lintels | plank deck on deep stringers (to 0.75 m below the deck), joists, cross bracing, iron straps |
| `lift-column` | 2.7 × 7.5 × 2.7 | the 4 solid shafts under the tower lifts | an ashlar pier |
| `ramp-courtyard`, `ramp-tower`, `ramp-keep` | 4 / 3.4 / 3 × 8 × 12 | the 20 ramps (34°) | ashlar treads with dark nosings flush with the slope, ashlar kerbs along both edges, rubble side faces |
| `lift-courtyard`, `lift-tower` | 2.8 / 2.7 × 8 × same | the 8 lift pillars | a timber crib: dark posts and rails, braced plank panels and an iron-edged plank platform on top |

`keep-wall-long` and `hall-wall` leave the 1.2 m corner square at their −X end to the perpendicular wall that shares it, and `lift-column` stands 10 cm inside its box, clear of the lift pillar that shares its footprint (`leavesToNeighbour`). Nothing draws two coplanar faces in one place.

## Look and materials

Four tileable CC0 Poly Haven PBR sets at 2K are declared inputs, catalogued in `catalog/sources.json` and stored in `assets/canonical/`. The recipe resizes them to 1024 px; every piece and level uses the same images, so the bundle stores each once.

| Material | Source | Tile |
| --- | --- | --- |
| `wall` (rubble faces) | `broken_wall` | 3.4 m |
| `trim`, `trimDark` (dressings) | `japanese_stone_wall` | 2.6 m |
| `floor` (every walkable top) | `stone_tiles_02` | 3 m |
| `wood`, `woodDark` (timber), `roof` (shingles, the planks turned across the slope) | `old_planks_02` | 2 m, roofs 1 m |

Against tiled, flat-looking stone:

- **Darker mortar, worn edges.** The rubble and ashlar colour maps are darkened in their joints and lifted on their proudest stones from the sets' displacement maps (`broken_wall` and `japanese_stone_wall` disp, inputs `wallHeight` and `trimHeight`, used at build time only).
- **Block-scale breakup.** COLOR_0 (glTF multiplies it into the base colour) carries each material's tint, a random tint per block (quoins, merlons, corbels, voussoirs, rubble), soft value-noise patches a few metres across, damp darkening and moss at the wall feet, moss on upward ledges (not on walks) and faint vertical rain streaks. LOD0 cuts large faces on a 2 m × 1 m grid so the colour has the resolution for it. Every shell also gets its own UV offset, so neighbouring blocks never repeat the texture exactly.
- **Bevels.** Dressed blocks, merlon copings, corbels and large rubble stones are chamfered at LOD0, so their edges catch the light.
- **Decals.** `grime` is one generated 512 px RGBA atlas (two rain streaks, two moss patches), alpha blended, on quads 1.5 cm off the faces: streaks under the drip course, the slits, the windows, the tower crowns and the gate gallery, moss along the wall feet and on the parapet's sills.

The UVs are world-scale per face (horizontal faces map X/Z; the others their horizontal tangent and its upward partner). Iron, the Marshal-blue banner cloth, its pale trim and the dark `void` inside openings are plain colours. Every face is backface-culled. As in greyhaven-nature, the normal maps ship without tangents (the import allows `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE`): MikkTSpace gives zero tangents on some long slivers of the boolean-cut faces, so the runtime generates them.

## Levels of detail

Each piece ships `default` (LOD0), `lod1` and `lod2`, built by the same recipe in the same frame, so a consumer swaps them in place. `lod1` drops rubble, decals, bevels, quoins, corbels, slit surrounds, voussoir joints, braces, banner trims and the colour grid, and keeps the silhouette: merlons, buttresses, hoardings, the gatehouse, crowns, roofs and bartizans. `lod2` keeps the main masses, walkable tops, the roof openings, the roofs and the materials. The descriptor uses the greyhaven-nature format (#449, [greyhaven-nature-bundle.md](greyhaven-nature-bundle.md#lod-metadata)): a top-level `lodSelection` and per asset `lods: { boundingSphere, levels[] }`, switching at screen sizes 0.35 and 0.12.

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
4. **Hide graybox.** Drop the graybox prop of every matched body once the kit's entries have loaded; keep graybox as the fallback while the bundle loads or if it fails (`Motion::Fallback`, as the Outpost does). Keep the collider ids on the kit draws so camera occlusion still treats them as structures; the decoration (roofs, hoardings, the gatehouse's towers) reaches outside the bodies, so cull and fade by each asset's measured `bounds`, not its body.
5. **Lifts.** Draw `fortress.kit.lift-courtyard` and `fortress.kit.lift-tower` instead of the unit presenter's lift boxes, each at `Platform::centre_at(tick)` minus `half_extents[1]` in y, so the crib's top is the platform's top.
6. **LOD.** Choose `default`, `lod1` or `lod2` per piece from `lodSelection` (three.js `LOD`, or the native client's screen-size test). The long pieces (curtain walls, parapets, bridges) have large spheres and stay at LOD0 across most of the arena.
7. **Ground.** The courtyard lifts' platforms rest flush with the ground (y = 0) at their low stop; leave the terrain out under the four 2.8 m footprints (or draw it 1 cm lower there) so the platform does not z-fight it.

## Review

Reviewed in the live Blender (MCP) with every piece placed by the composition, before and after pass 2 (#459): from the game camera (12 m, 0.42 rad pitch, 50° vertical FOV) in the courtyard, on the wall walk and outside the gate, an overview, and closer views of the outer wall, the gatehouse, a corner tower and the keep. A selection is in [`review/fortress-kit/`](../review/fortress-kit/) (`game-*.jpg` from the game camera, `overview.jpg`, `outside-wall.jpg`, `outside-gate.jpg`, `corner-tower.jpg`, `keep.jpg`, and `close-lift.jpg` from #445).

| Piece | Triangles (`default` / `lod1` / `lod2`) |
| --- | --- |
| `curtain-wall` | 18,500 / 1,750 / 56 |
| `parapet` | 6,356 / 1,500 / 12 |
| `gate-lintel` (the gatehouse) | 6,306 / 1,472 / 560 |
| `corner-tower` | 12,394 / 758 / 78 |
| `central-tower` | 10,294 / 754 / 78 |
| `keep-roof` | 11,822 / 1,408 / 156 |
| `bridge` | 3,226 / 980 / 44 |
| `lift-courtyard`, `lift-tower` | 1,172 / 884 / 100 |
| ramps | 578 / 578 / 8 |
| keep and hall walls, lintels, `lift-column` | 300–3,200 / 76–308 / 44–124 |

The whole fortress (82 items) is about 352,000 triangles at LOD0 and 58,000 at LOD1. The tar is about 11.5 MB: 13 shared images (four sets × colour, normal and metallic-roughness as 1024 px JPEGs, and the 512 px grime PNG) and the geometry, which now carries COLOR_0.

## Tests

`test/blender/fortress/fortress-kit.test.ts` (its own `blender-script (fortress)` CI suite, with a 60-minute timeout):

- without Blender: the spec arguments; the composition dresses every arena body but the ground exactly once, each single-body item's turned and moved piece box equals its body's box exactly, and every ramp rises the right way; every piece's fit rule reaches at least its box;
- in the hosted `blender-script` job: the tar and bundle verify with 17 pieces × 3 levels; the descriptor conforms to its schema; at most 13 images are stored; every piece at every level passes the fit rule (`fortressFitViolations`: no vertex outside its reach, walks flush with 2.2 m of head room sampled every 0.37 m, blocking faces within 5 cm sampled every 0.5 m with at most 8% openings); the levels get cheaper.
