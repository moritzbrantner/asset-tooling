# Shooter robot locomotion

The driven wheel and the track module of the [Shooter](https://github.com/moenarch-games/shooter) beta's socket-grid robots ([#634](https://github.com/moritzbrantner/asset-tooling/issues/634)). They are the companion of the [robot part kit](combat-robot-kit.md) (#595) and the [weapon kit](shooter-weapons.md) (#594): the same socket, frame and origin convention, the robot kit's `Part` builder and palette.

It is a reproducible Blender recipe, [`adapters/blender/robot_locomotion.py`](../adapters/blender/robot_locomotion.py), built to the [kit standard](kit-standard.md) and shipped as its own rolling release, `shooter-robot-locomotion` (`shooter-robot-locomotion.kit.tar`). It is original procedural work with no third-party assets (see [Sources](#sources)). No game places it yet; Shooter's renderer draws wheels and tracks as labelled placeholders until it adopts the kit (shooter#58).

**Why its own release.** The robot release is at 1.97 MB of its 2 MB download budget, and the kit standard is one kit, one release. `shooter-robot-locomotion` has its own `releases/shooter-robot-locomotion.json` and budget (1 material, 6 MB texture memory, 2.1 MB download; measured 5.6 MB and 1.96 MB, most of it the track's 25 animated links and the 1024 px atlas).

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-robot-locomotion.ts [--textures full|half] --out <directory>
```

[`scripts/build-robot-locomotion.ts`](../scripts/build-robot-locomotion.ts) runs the recipe once per part, variant and level, drops animation channels that never move, adds tangents and `COLOR_0`, writes the descriptor and encodes the shared atlas to KTX2. The recipe declares `combat_robot.py` and `kit_common.py` as its Python inputs. It needs KTX-Software's `ktx` CLI, but no network, GPU or LFS payloads, and takes about a minute.

## Parts

Each key and cuboid is Shooter's catalog row (`crates/shooter-sim/src/robot.rs`, `parts::WHEEL` and `parts::TRACK`: `Kind::Locomotion`, no sockets).

| Key | Cells | Triangles (LOD0 / lod1 / lod2) | Look |
| --- | --- | --- | --- |
| `robot.wheel` | 2 × 2 × 1 | 1,352 / 420 / 40 | a gunmetal bracket over the mount cell and a pale bearing housing with a hazard ring on the axle; the wheel: a steel axle, a gunmetal rim whose faces carry five spoke windows, five lug nuts and one hazard wedge (so a turn reads), and a chunky tyre with twelve tread lugs |
| `robot.track` | 1 × 4 × 2 | 1,984 / 624 / 148 | a frame plate on the mount face with five axle housings; a toothed steel drive sprocket and a gunmetal idler on Shooter's two axles and three rubber-tyred road wheels between, each two discs with a gap for the guide horns; a belt of 25 steel-shod links with rubber inserts, a grouser bar and a centre guide horn each |

Both have a `damaged` variant with the same nodes, clip and outline: the wheel's tread is torn over a sector, its face scorched and cracked, a lug nut gone and the rim's lip dented; the track's frame is scorched and its end bent, the middle road wheel has lost its outer disc, the idler is cracked and the pads are worn and burnt. Every part has `default`, `lod1` and `lod2` (and `damaged`, `damaged-lod1`, `damaged-lod2`); levels end at 60 m and 180 m (`scaledLodDistances`, both parts are under 1 m across), in the descriptor's `lodSelection`, per-part `lods` and `variants.damaged.lods`. At lod1 the wheel has a smooth tyre and the track one disc per wheel and a plain shoe per link; at lod2 the wheel is a disc and the belt one closed band on the frame (the link nodes stay, without geometry).

**Materials and textures:** one opaque material, `locomotion-metal`, on a 1024 px KTX2 atlas of colour, normal, ORM and emissive (no glow is used) in the robot kit's palette: paint, gunmetal, steel, hazard, panel and vent, plus rubber, the tread block, the track pad, the wheel face, the sprocket face and their damaged versions. Each part draws in one call.

## Axles: matching Shooter's mechanics

Shooter's mechanics (`crates/shooter-sim/src/mechanics.rs`) make each locomotion part its own body on revolute joints about the part's **mount normal** (its +z), with nothing corrected for the mount's direction. The kit puts its turning nodes on exactly those axles, so a renderer can turn them by Shooter's joint angles and the visuals roll where the physics does:

| Part | Shooter (corner frame, cm) | Joint (`kind`) | Node | `origin` (glTF, m) | `axis` | Rolling radius |
| --- | --- | --- | --- | --- | --- | --- |
| `robot.wheel` | one sphere of radius 40 / 2 − 2 = 18 at (20, 20, 10) | `wheel` (`wheel`) | `wheel` | (0.1, 0.1, −0.1) | (0, 1, 0) | 0.18 m: the tyre's tread |
| `robot.track` | two spheres of radius min(20, 40) / 2 = 10 at (10, 10, 20) and (10, 70, 20), the same drive | `sprocket`, `idler` (`track-wheel`) | `sprocket`, `idler` | (0, 0.2, 0), (0, 0.2, −0.6) | (0, 1, 0) | 0.1 m: the belt round them (0.0985 m at the grousers) |

The asset origin is the base cell's centre, 10 cm in from Shooter's corner on x and y. Joints are continuous (no `range`). Zero is the pose as modelled and a positive angle turns right-handed about `axis`; on a robot's two sides the same angle turns the wheels opposite ways, as in Shooter (its bindings invert one side, shooter#74). Shooter's spheres stand in for discs: they also reach past the part along the axle, which the visuals do not. A wheel's 2 × 2 footprint has its axle at the corner of four cells, so Shooter's fixtures turn wheels on their sockets to hang them over a chassis' edge (`wheeler`, `strafer` below). A track's belt bottom is flush with the bottom of the cell row it mounts on, so a hull carrying tracks on its lowest side row also reaches the ground (`mini-tank`); that is Shooter's catalog geometry, not a choice of this kit.

## Roll clip and the belt

Each part has one looping glTF animation, `roll` (1 s, 30 frames a second): every wheel node turns one full turn about +Y. On the track the belt moves the matching 2π × 0.1 m: its 25 links (`link-01` … `link-25`, each a node at its pad's middle on the pitch line) run round a stadium path in the part's x-y plane, two straights between the axles and a half circle of radius 0.0868 m round each, and each link turns with the path's tangent. A wheel turn is exactly nine links (pitch 2π × 0.1 / 9 = 0.0698 m), so the clip loops without a jump. A positive wheel angle moves the belt anticlockwise seen from the axis (along the part's +y on its +x side), as a belt driven by the wheels does.

A renderer follows Shooter in either of two ways: set the clip's time to `(angle mod 2π) / 2π × 1 s`, with `angle` the joint's angle (the track's two joints share one drive); or turn the wheel nodes by the angle directly and place the links from `tread` (the same arithmetic the clip bakes). The descriptor's `locomotion.roll.rule` and `locomotion.tread.rule` say the same.

## Attach, damage and detach

- Every level of both parts and both variants is a closed surface (tested) with a finished mount face: the wheel's bracket and the track's frame plate. A part is its own glTF scene that stays inside its cuboid at rest and in every frame of its clip (the belt included), so wheels and tracks on neighbouring sockets never clip, and hiding, moving or dropping one changes nothing else.
- `damaged` is a separate bundle variant with the same nodes, clip, bounds and hit proxy, so a renderer swaps it in place (Shooter's client already looks for a part's `damaged` variant).
- A lost part is the same entry falling free; Shooter's physics moves it. The parent's bare socket shows the coupling every free socket shows.

## Descriptor `socket-grid-kit-descriptor-v3`

The descriptor is canonical JSON, the `socket-grid-descriptor` attachment of `robot.wheel` (`default`), and also written as `descriptor.json` next to the tar. Its schema is [`schemas/socket-grid-kit-descriptor-v3.schema.json`](../schemas/socket-grid-kit-descriptor-v3.schema.json): the published v2 (unchanged; v1 and v2 stay immutable) plus what locomotion needs:

| Field | Meaning |
| --- | --- |
| `parts[]` | As in v2 (`cells`, `cuboid`, `bounds`, `mount`, no sockets, `joints` (above), `hitProxies`, `lods`, `variants.damaged.lods`, `states` with `roll`), plus `locomotion`. |
| `parts[].locomotion` | `type` (`wheel` or `track`), `axis`, `rollingRadius`, `bodies` (each Shooter body: `joint`, `node`, `centre`, `radius`), `wheels` (every node the clip turns), `tread` for the track (`links`, `pitch`, `pitchRadius`, `outerRadius`, `length`, `centres` of the two end axles, `metresPerRadian`, `linksPerTurn`, `rule`), `roll` (`animation`, `seconds`, `radiansPerCycle`, `rule`) and `shooter`, how Shooter models it. |
| `locomotionRule`, `sources` | The axle rule and the damaged/detached states, and the provenance, as text. |
| `compositions[]` | The review builds; an item from another kit names it (`kit: "shooter-combat-robot"` or `"shooter-weapons"`). |

**Authority.** Shooter owns the part IDs and footprints, which wheels and tracks drive, their torque, rates and energy, contacts, collision, motion, damage, detachment and assembly. The joints and bodies repeat where Shooter's mechanics put its axles so the visuals line up; when Shooter changes them, update `LOCOMOTION_JOINTS`/`locomotionOf` in the build script and the recipe's constants, then rebuild. The hit proxy (one box round the full-detail bounds) is non-authoritative.

## Compositions

- **`biped`**: for comparison, Shooter's humanoid frame on the small chassis on the robot kit's legs, with the rifle and the grapple.
- **`wheeler`**: Shooter's `car` fixture exactly (`mechanics/fixtures.rs`: the large chassis on end, a sensor on top where the retired core sat, four wheels on its sides, each turned on its socket to hang over a bottom corner), plus the grapple on its front.
- **`strafer`**: Shooter's `strafer` fixture exactly: the same wheels on the chassis' front and back, so the same drive moves it sideways. The unusual wheel mounting.
- **`mini-tank`**: the large chassis lying along +X as a 40 cm hull with a track on each side over its lower cell row (axles across the hull), a rotor, riser and hinge carrying the rail gun, a sensor and the grapple in front. The robot and weapon kits' `mini-tank` builds keep their tracks as placeholders on the hull's underside, where Shooter's mechanics would turn them about a vertical axis; this kit's mini-tank mounts them where they roll.
- **`crab`**: the same hull with its tracks on its front and back ends, overhanging by a cell, so it crawls sideways. The unusual track mounting.

`test/robot-locomotion.test.ts` checks that they assemble flush without overlaps, every child touching its parent, and that every Shooter body of every wheel and track touches the ground with a horizontal axle.

## Edit

The tables at the top of the recipe set the axles (`WHEEL_AXLE`, `TRACK_WHEELS`, `TRACK_Z`), the belt (`LINKS`, `PITCHES_PER_TURN`, which fix the pitch and pitch radius, `BELT_Z`) and the atlas (`CELLS`, 128 px units on 1024 px). Each part is one function. To see a change in a live Blender, in its own scene:

```python
import bpy, runpy
kit = runpy.run_path("adapters/blender/robot_locomotion.py")
kit["use_sources"](runpy.run_path("adapters/blender/combat_robot.py"), runpy.run_path("adapters/blender/kit_common.py"))
kit["build"]("robot.track", bpy.context.scene.collection, level=0, variant="damaged")
```

The part comes back parented to its armature, with `roll` as an NLA track (play the timeline to see it). Delete the `locomotion-metal` material and its `locomotion-metal-*` images first when you change the atlas.

## Sources

No catalogued CC0 source has a socket-grid wheel or track: the Quaternius *Sci-Fi Essentials Kit* (the only catalogued sci-fi set) has no vehicles, and Kenney's and Poly Haven's CC0 vehicle and prop models are stylised whole vehicles, not 20 cm-grid modules on a stated axle. Every part is therefore original geometry built by the recipe on the robot kit's `Part` builder, with procedurally painted textures; the kit uses no third-party files and no paid sources or generators. It was shaped and checked in a live Blender through the Blender MCP and is built headless with the pinned 5.2.2.

## Review

Review images are in [`review/shooter-robot-locomotion/`](../review/shooter-robot-locomotion/), rendered by [`scripts/review-robot-locomotion.py`](../scripts/review-robot-locomotion.py) in EEVEE from the three kits' recipes and a build's `descriptor.json`:

```sh
<blender 5.2.2> -b --factory-startup -P scripts/review-robot-locomotion.py -- --descriptor <build>/descriptor.json --out review/shooter-robot-locomotion
```

Unless noted, at third-person gameplay scale: 3.6 m from the build, the eye 1.7 m up, a 60° vertical field of view.

- `compare.jpg`, `compare-views.jpg`: biped, wheeler and mini-tank side by side, then each front and back three-quarter;
- `motion-wheeler.jpg`, `motion-mini-tank.jpg`: six frames each from a fixed camera: the wheeler drives and turns on an arc; the mini-tank drives, pivots on the spot (its tracks counter-rotating) and drives off, its turret turning;
- `motion-close.jpg`: the wheels and a track close (1.6 m) at two moments of a roll: the lugs, the hub wedge and the links moving round the sprocket;
- `unusual.jpg`: the strafer and the crab, three frames each, moving sideways;
- `grapple.jpg`: the wheeler and the mini-tank fire the grapple, hook a post 4 m away and reel themselves towards it, wheels and tracks turning;
- `damage.jpg`: the biped's leg, a wheel and a track shot off and lying where they fell; the damaged wheel and track on their builds, close; a lost wheel and track upside down, showing their closed mount faces;
- `gameplay.jpg`: all five builds about 10 m away;
- `parts.jpg`: both parts, intact and damaged, standing as if on a robot's left side, from outside and from the mount side; `lods.jpg`: each part's three levels.

Motion is kinematic for review: each build is carried along a path and every wheel and track turned by the distance its contact rolls, with the belt placed by the same arithmetic as the clip. Shooter moves robots physically; the cable and the post are review props. Shooter has no approved style capture yet; a passing test is not visual approval.

## Tests

`test/robot-locomotion.test.ts` (no Blender) checks the rows against Shooter's catalog and the robot kit's placeholders, that the bodies and joints sit exactly where Shooter's mechanics put its spheres (recomputed from the cells with mechanics.rs's formulas) and turn about the mount normal, the belt's arithmetic (whole links per turn, the loop closing round the two axles, the grousers inside the rolling circle), and that the review builds assemble flush without overlaps with every body on the ground.

`test/blender/kits/robot-locomotion.test.ts` builds the kit (with `ASSET_TOOLING_BLENDER`) and checks that the tar and bundle verify with both parts, both variants and all levels; one material and four KTX2 textures within the release budget; tangents and `COLOR_0`; that every level is closed, rests on its mount face and stays inside its cuboid; that each part is skinned rigidly with every node unrotated, its wheel and link nodes present and its joint nodes on Shooter's axles; that `roll` lasts one second, turns every wheel a whole turn about +Y and keeps every link's pivot on the belt's path; the descriptor against the v3 schema; LODs that at least halve, with their switch distances; and that composition items name bundle entries or another kit's parts.
