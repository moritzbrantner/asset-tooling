# Shooter arena kit

The modular arena environment of the [Shooter](https://github.com/moenarch-games/shooter) beta ([#593](https://github.com/moritzbrantner/asset-tooling/issues/593)): reusable clean-futuristic floor, wall, doorway, cover, platform, ramp, walkway, jump-pad, prop and exterior ship-hull modules that Shooter composes its small, medium and large arenas from (shooter#48, #52, #53, #55), with destructible cover for shooter#60. The style is the owner's choice of 2026-11-14: clean futuristic sci-fi with restrained industrial grit, hard surfaces, credible scale and a clear material hierarchy, light used sparingly.

It is a reproducible Blender recipe, [`adapters/blender/shooter_arena.py`](../adapters/blender/shooter_arena.py), built to the [kit standard](kit-standard.md) and shipped as its own rolling release, `shooter-arena` (`shooter-arena.kit.tar`). It follows the environment kits ([crypt](crypt-kit.md), [outpost](outpost-kit.md)) for modules, origins and collision proxies, and the Shooter kits ([robot parts](combat-robot-kit.md), [weapons](shooter-weapons.md)) for palette and painters: it takes `combat_robot.py` as a declared input and uses its gunmetal, steel, hazard and vent paints. No game places it yet.

**Not here.** Shooter authors the arena layouts, map selection, placement, the shipyard's landmark ship and routes, gameplay collision, jump-pad launches, door opening, grapple targets and when and how anything breaks. The kit has no ship interiors and no separate ship kit: the hull modules are part of this kit (owner decision on Shooter #55, 2026-11-14).

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-shooter-arena.ts [--textures full|half] --out <directory>
```

[`scripts/build-shooter-arena.ts`](../scripts/build-shooter-arena.ts) runs the recipe once per module, variant (`default`, `broken`) and level (full detail, `lod1`), keeps `lod1` only where it at least halves the triangles, adds tangents and `COLOR_0`, writes the descriptor and encodes the shared atlas to KTX2. It needs KTX-Software's `ktx` CLI, but no network, GPU or LFS payloads, and takes about ten minutes (64 Blender runs). Snap Blender can only read and write under `$HOME`, so set `TMPDIR` there.

## Grid and frames

- **Units and axes:** metres, glTF +Y up, a module's front +Z, right-handed. Shooter's arena pieces (`crates/shooter-sim/src/arena.rs`) are the same axes in integer centimetres.
- **Placement box:** each module has a box (`box` in the descriptor), the box Shooter's `Block` or `Ramp` describes. No vertex leaves it, and the tiling modules (surfaces, walls, cover, platforms, ramps, hull, the door and the jump pad) fill it on every side at full detail, so modules placed on the grid meet face to face with no gap and no overlap.
- **Origin:** the centre of the box's base; the floor plate and the jump pad, laid on Shooter's floor plane, have theirs at the centre of their top (their top is y = 0).
- **Grid:** a 1 m cell and 2 m modules (1 m fillers), heights in 1 m steps, walls 60 cm thick (Shooter's inner walls), wall heights 4 and 5 m, cover at 0.8, 1.2 and 2 m, ramps at Shooter's 1:4 (14.04°), and 4 m hull modules with a 45° shoulder.
- **Placement:** a translation and a yaw of 0, 90, 180 or 270° about +Y, counter-clockwise seen from above (+90° turns +Z to +X). Every proxy edge is a whole centimetre, so a module placed on whole centimetres gives integer Shooter pieces.

## Modules

| Key | Box W × H × D (m) | Triangles (full / lod1) | Proxies | Use |
| --- | --- | --- | --- | --- |
| `arena.floor` | 2 × 0.1 × 2 | 10 / – | `floor` (walkable) | A 2 x 2 m floor plate laid on the arena floor: its top is y = 0. |
| `arena.ceiling` | 2 × 0.2 × 2 | 170 / 18 | `ceiling` (blocked) | A 2 x 2 m ceiling panel, 20 cm thick, with light strips underneath; its origin is the centre of its underside. |
| `arena.wall` | 2 × 4 × 0.6 | 306 / – | `wall` (blocked) | A 2 m wall module, 4 m high, 60 cm thick, finished the same on both faces. |
| `arena.wall-half` | 1 × 4 × 0.6 | 244 / – | `wall-half` (blocked) | A 1 m wall filler, 4 m high. |
| `arena.wall-tall` | 2 × 5 × 0.6 | 346 / – | `wall-tall` (blocked) | A 2 m wall module, 5 m high (perimeters and wall lines). |
| `arena.wall-corner` | 0.6 × 4 × 0.6 | 276 / – | `wall-corner` (blocked) | A 60 cm corner, end or junction post for 4 m walls: fills the square where walls meet. |
| `arena.wall-corner-tall` | 0.6 × 5 × 0.6 | 348 / – | `wall-corner-tall` (blocked) | The corner post for 5 m walls. |
| `arena.doorway` | 4 × 4 × 0.6 | 624 / – | `left-jamb` (blocked), `right-jamb` (blocked), `lintel` (blocked) | A 4 m wall module, 4 m high, with a 2 x 3 m opening: nothing reaches into the opening. |
| `arena.door` | 2.1 × 3.05 × 0.14 | 648 / – | `leaf-left` (blocked), `leaf-right` (blocked) | Two sliding leaves (nodes leaf-left and leaf-right) for the doorway's opening, mounted at the doorway's origin. Each laps 5 cm into its jamb and the lintel; the proxies cover the opening only. Broken: a blast hole across the meeting seam. |
| `arena.cover-low` | 2 × 1.2 × 0.6 | 180 / – | `cover-low` (blocked) | Low cover, 1.2 m: a 2 m barrier with a chamfered top. Broken: a 60 cm stub stands at its -x end; the rest is torn down to 56 cm. |
| `arena.barrier` | 2 × 2 × 0.6 | 184 / – | `barrier` (blocked) | High cover, 2 m: a robot cannot see over it. Broken: a 50 cm stub stands at its +x end; the rest is torn down to 1 m. |
| `arena.crate` | 0.8 × 0.8 × 0.8 | 156 / – | `crate` (walkable) | An 80 cm crate; crates stack. Broken: lid gone, sides torn to 46 cm. |
| `arena.platform` | 2 × 2 × 2 | 242 / 98 | `platform` (walkable) | A 2 x 2 x 2 m platform block: blocks side by side make a platform, stacked a tower. |
| `arena.platform-half` | 2 × 1 × 2 | 242 / 98 | `platform-half` (walkable) | A 1 m platform block, for odd heights (3, 5, 7 m). |
| `arena.ramp` | 2 × 2 × 8 | 384 / – | `ramp` (walkable, ramp -Z) | A 2 m wide ramp, 8 m long, rising 2 m toward -Z (1:4, 14 degrees): onto a 2 m platform. |
| `arena.ramp-tall` | 2 × 3 × 12 | 628 / – | `ramp` (walkable, ramp -Z) | A 2 m wide ramp, 12 m long, rising 3 m toward -Z (1:4): onto the 3 m walkway. |
| `arena.walkway` | 2 × 0.4 × 4 | 200 / 72 | `walkway` (walkable) | A 2 m section of a 4 m wide, 40 cm walkway deck (along x), with lit fascias. |
| `arena.support` | 1 × 2.6 × 1 | 134 / 46 | `support` (blocked) | A 1 m walkway support, 2.6 m: the deck sits on it at 2.6 m (top 3 m). |
| `arena.pillar` | 1.2 × 4 × 1.2 | 408 / 200 | `pillar` (blocked) | A 1.2 m pillar, 4 m high. |
| `arena.jump-pad` | 1.6 × 0.07 × 1.6 | 74 / – | `pad` (trigger) | A 1.6 m jump pad flush with the floor (its top 2 cm up): no collider, only its footprint. Its origin is Shooter's JumpPad center; Shooter owns the launch. |
| `arena.container` | 8 × 2 × 3 | 576 / – | `container` (walkable) | An 8 x 3 m cargo container, 2 m high. |
| `arena.generator` | 2 × 1.6 × 1.2 | 350 / 170 | `generator` (blocked) | A power unit on a skid, 1.6 m. |
| `arena.pipes` | 2 × 1.2 × 0.5 | 296 / – | `pipes` (blocked) | A 2 m run of two pipes on brackets; its back (-z) goes against a wall face. |
| `arena.hull-deck` | 4 × 0.5 × 4 | 10 / – | `hull` (walkable) | A 4 x 4 m hull deck plate, 50 cm thick: the walking surface on top of a hull section. |
| `arena.hull-shoulder` | 4 × 2 × 2 | 10 / – | `hull` (walkable, ramp -Z) | The 45 degree chamfer, 4 m long, from a hull deck's edge (its high side, -z, 2 m up) down to the side plating. |
| `arena.hull-side` | 4 × 2 × 0.5 | 176 / 52 | `hull` (blocked) | A 4 x 2 m hull side plate, 50 cm thick; plates stack in 2 m courses and close a section's ends. |
| `arena.hull-rib` | 4 × 0.8 × 0.6 | 176 / 56 | `hull` (blocked) | A 4 m structural frame band across a deck, 80 cm: low cover. |
| `arena.hull-mast` | 1 × 3 × 1 | 232 / – | `foot` (blocked), `mast` (blocked) | A 3 m sensor mast with a grapple ring near its top. |

The numbers are from the build of 2026-11-14; the descriptor carries the measured values of each build. The cost is one material, four 2048 px KTX2 textures (22.4 MB of texture memory) and a 2.1 MB download, against the release budget of 1 material, 24 MB and 2.4 MB (`releases/shooter-arena.json`).

Broken variants (`broken`) keep their module's key, box, origin and placement:

| Key | Broken | Proxies |
| --- | --- | --- |
| `arena.door` | a blast hole across the meeting seam: each leaf keeps a 44 cm outer strip, a lower piece to 0.8 m and an upper piece from 2.4 m, torn edges scorched | `leaf-left.outer`, `.lower`, `.upper` and the same for `leaf-right` |
| `arena.cover-low` | a 60 cm stub stands at −x; the rest is torn down to 56 cm | `stub`, `base` |
| `arena.barrier` | a 50 cm stub stands at +x; the rest is torn down to 1 m | `stub`, `base` |
| `arena.crate` | lid gone, sides torn to 46 cm | `base` |

## Collision proxies and Shooter's pieces

`collisionProxies` (and `variants.broken.collisionProxies`) are axis-aligned in the module's frame, `{ name, tag, shape, center, size, rises? }`:

| Proxy | Shooter piece | In centimetres |
| --- | --- | --- |
| `shape: box`, `tag: walkable` (a top to stand on) or `blocked` (solid) | `Block { center, half }` | center = (translation + turned centre) × 100, half = size × 50, x and z swapped at 90° and 270° |
| `shape: ramp` (`tag: walkable`), `rises` | `Ramp { center, half, rises }`, the wedge filling the lower half of its box | `rises` turns with the yaw: `-Z` is `NegZ` at 0°, `NegX` at 90°, `PosZ` at 180°, `PosX` at 270° |
| `tag: trigger` (the jump pad) | `JumpPad { center, half }`, no collider | center = the pad's origin, half = (80, 80) |

The solid modules' proxies fill their box exactly; the doorway's jambs and lintel keep its 2 × 3 m opening free, and the door's two leaves cover the opening (the leaves lap 5 cm into the jambs and lintel visually, not in their proxies). `shooterPieces` in the build script turns a composition into Shooter's pieces; `test/shooter-arena.test.ts` checks, for example, that eight `arena.wall-tall` modules are the greybox yard's 16 m wall line `block([-1600, 250, -1200], [800, 250, 30])`, two `arena.walkway`, `arena.support` and `arena.ramp-tall` modules its walkway deck, pillar and 12 m ramp, and `arena.jump-pad` its pads. Shooter may use, replace or ignore the proxies; they are metadata.

- **Doorway and door:** `arena.doorway` carries `doorway` (the opening's box) and `mount` (`arena.door` at the doorway's origin). The door's leaves are the nodes `leaf-left` and `leaf-right`; `open` gives each leaf's slide (±0.95 m along x, into its jamb). Shooter owns opening and closing.
- **Mast:** `arena.hull-mast` carries an anchor `grapple` (kind `grapple-point`) at the ring; Shooter decides what a grapple can hit.
- **Jump pad:** a 1.6 m plate whose top is 2 cm above the floor, its body sunk 5 cm; skip the floor plate under it. Shooter owns its launch.

## Shipyard hull

The smallest set that composes a walkable exterior hull section, on 4 m modules: `hull-side` plates (4 × 2 m, stacked in 2 m courses, also closing a section's ends), the 45° `hull-shoulder` from a deck's edge down to the side plating, `hull-deck` plates on top, `hull-rib` frame bands across the deck as low cover, and the `hull-mast` with its grapple ring. The `hull` review composition is a 12 m section, 8 m wide and 6 m high: side plates in two courses at z = ±3.75, shoulders from y = 4 to 6, a deck at y = 5.5 (top 6), end plates at x = ±6.25. Shooter places the sections in its drydock and owns the ship landmark and routes.

## Look and materials

One opaque material, `arena-metal`, on one 2048 px atlas of sixteen 512 px cells (colour, normal, ORM and emissive maps), shared by every module, level and variant. Tiling surfaces repeat per cell size (`TILE` in the recipe) and are cut at the tile lines, which start at the module box's corner, so neighbours continue each other; small parts are fitted.

| Cell | Look | Tile |
| --- | --- | --- |
| `panel` | cool pale grey wall panel, recessed joints at the 2 m edges and a fine one at 1 m, corner fasteners | 2 m |
| `panel-dark` | graphite (the robot kit's beam paint): plinths, sides, undersides | 2 m |
| `deck` | dark floor plate with staggered anti-slip dimples, joints every metre | 2 m |
| `grate` | ribbed steel grip, eight ribs a metre: ramps and the walkway | 1 m |
| `hull`, `hull-dark` | warm off-white and dark hull plating, 2 × 1 m plates breaking joint with rivet lines and faint streaks | 4 m |
| `gunmetal`, `steel`, `hazard`, `vent` | the robot kit's paints: trims, caps, end ribs, rails, frames; brushed steel; hazard stripes; vents | 1 m, 0.5 m (vent) |
| `glow`, `glow-warn`, `pad` | the robot kit's lens cyan light strips, amber status lights, the jump pad's green-cyan rings (emissive) | 0.5 m, fitted |
| `container`, `crate`, `scorch` | corrugated steel blue, a crate face, blast-blackened torn metal on broken edges | 2 m, fitted, 0.5 m |

The surfaces are flat-shaded; hard edges come from geometry: recessed panel fields between proud plinths, caps and end ribs, chamfered cover tops, and flush kerbs on ramps. Light is sparing: one cyan strip under each wall cap, door and frame lights, guide lights along ramps and walkway fascias, amber status lights on props and hull. Every texture is KTX2 (colour ETC1S sRGB, ORM ETC1S linear, normal UASTC); see [outpost-kit.md](outpost-kit.md#textures-on-the-gpu).

**LODs:** `lod1` drops the details (light strips, bands, small trims); it ships only for modules where that at least halves the triangles. Full detail is kept to 60 m, scaled with the module's widest side (`scaledLodDistances`), and `lod1` beyond.

**Determinism:** no randomness: torn edges come from SHA-256 of fixed keys and the textures from numpy's legacy `RandomState`; the mesh is rebuilt canonically (sorted triangles, rounded to 1 µm). Two builds give identical tars.

## Descriptor `arena-kit-descriptor-v1`

Canonical JSON, the `arena-descriptor` attachment of `arena.floor` (`default`), also written as `descriptor.json` next to the tar. Its schema is [`schemas/arena-kit-descriptor-v1.schema.json`](../schemas/arena-kit-descriptor-v1.schema.json).

| Field | Meaning |
| --- | --- |
| `units`, `up`, `facing`, `handedness`, `origin`, `grid`, `placement` | The frames and grid above. |
| `collision`, `destruction`, `authority` | The proxy rules and what Shooter owns, as text. |
| `assets[]` | In module order: `key`, `category`, `kind` (`module` or `prop`), `origin`, `note`, `box`, `size`, measured `bounds`, `triangles`, mesh `nodes`, `collisionProxies`, `lods`, and `variants` (`default` and, for destructible pieces, `broken`, each with its proxies, triangles, bounds and LODs); the doorway's `doorway` and `mount`, the door's `open`, the mast's `anchors`. |
| `compositions[]` | The review configurations: `{ name, note, items: [{ key, variant?, translation, yawDegrees? }] }`. |
| `lodSelection`, `material`, `sources` | As in the other Shooter kits. |

A consumer reads a module with `readAssetBundleGltf(dir, manifest, "arena.<name>", "default" | "lod1" | "broken" | "broken-lod1")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "arena.floor", "default", "arena-descriptor")`. CI publishes the release when a change to the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Compositions

| Composition | Arrangement |
| --- | --- |
| `yard` | Ground level: a 20 × 16 m yard closed by 5 m and 4 m walls with corner posts, a doorway with its door, a long lane broken by low cover, a barrier, a crate stack, a container, a generator, wall pipes, a pillar and a jump pad. |
| `heights` | Height: a 6 × 4 m platform with two ramps, a 3 m walkway on supports with its two 12 m ramps, a 7 m tower of platform blocks with a jump pad at its foot, and a 4 × 4 m shed of walls and a doorway under ceiling panels. |
| `cover` | Destruction: low cover, a barrier, crates and a doorway's door, each intact beside its broken variant at the same placement. |
| `hull` | Shipyard: the 12 m hull section above on a drydock floor. |

`test/shooter-arena.test.ts` checks that they use every module and variant, that their proxies never overlap, that every item rests on the ground or meets another face to face, and that they turn into integer Shooter pieces.

## Edit

The tables at the top of the recipe set the atlas (`CELLS`, `TILE`), the palette and the glows; each module is a short function drawing boxes, prisms and cylinders in its glTF frame. `BOXES` in the recipe and `ARENA_MODULES` in the build script must agree (tested). To see a change in a live Blender, in its own scene:

```python
import bpy, runpy
kit = runpy.run_path("adapters/blender/shooter_arena.py")
kit["use_sources"](runpy.run_path("adapters/blender/combat_robot.py"), runpy.run_path("adapters/blender/kit_common.py"))
kit["build"]("arena.doorway", bpy.context.scene.collection, "default", 0)
```

Delete the `arena-metal` material and its `arena-metal-*` images first when you change the atlas.

## Sources

Original geometry and procedurally painted textures from the recipe; the kit uses no third-party files and no paid sources or generators. The catalogued CC0 sci-fi kits (Quaternius's *Sci-Fi Essentials*, Kenney's space kits) are stylised low-poly sets on their own grids and palettes: none has walls, ramps or cover on Shooter's centimetre pieces with matching collision, and adapting them would mean rebuilding them, so the kit is authored on the robot kit's palette and painters instead.

## Review

Review images are in [`review/shooter-arena/`](../review/shooter-arena/), rendered by [`scripts/review-shooter-arena.py`](../scripts/review-shooter-arena.py) in EEVEE from the recipe and a build's `descriptor.json`:

```sh
<blender 5.2.2> -b --factory-startup -P scripts/review-shooter-arena.py -- --descriptor <build>/descriptor.json --out review/shooter-arena
```

Every panel except the overviews is at Shooter's third-person camera (`camera.rs`: 3.5 m behind the fighter, 0.6 m right of its shoulder, 0.3 m above its 1.65 m eye, a 1.2 rad vertical field of view), behind a 1.8 m capsule stand-in for scale.

- `yard.jpg`: down the lane over low cover; at the doorway; past the container; a three-quarter view of the yard;
- `heights.jpg`: under the walkway toward the tower; from the platform across to the walkway; from the walkway down at the platform and the shed; up the tower from its jump pad;
- `cover.jpg`: the intact and broken lanes, each piece beside its broken twin, and the intact and broken doors;
- `hull.jpg`: on the hull deck between the ribs and the mast; from the drydock floor up at the shoulder; along the deck; an overview;
- `overview.jpg`: every composition from above; `modules.jpg`: every module, variant and `lod1`.

Shooter has no approved style capture yet; a passing test is not visual approval.

## Tests

`test/shooter-arena.test.ts` (no Blender) checks the module table against the recipe's boxes, that every proxy lies in its box on whole centimetres, that the solid modules' proxies fill their box, that the doorway's proxies keep its opening free and the door's leaves cover it, that broken proxies lie inside the intact ones, the yaw and `rises` turns, the compositions (above) and the greybox-yard pieces.

`test/blender/kits/shooter-arena.test.ts` builds the kit (with `ASSET_TOOLING_BLENDER`) and checks that the tar and bundle verify with every module and variant, one material and four KTX2 textures within the release budget, tangents and `COLOR_0`, every level inside its box and the tiling modules filling it, no doorway vertex in the opening, the door's leaf nodes, triangle budgets, LODs that halve, the descriptor against its schema and composition items naming bundle entries.
