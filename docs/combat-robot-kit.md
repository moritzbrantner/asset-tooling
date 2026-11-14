# Shooter combat robot parts

Modular robot parts for the [Shooter](https://github.com/moenarch-games/shooter) beta's socket-grid robots ([#595](https://github.com/moritzbrantner/asset-tooling/issues/595), Shooter Atlas D2.i70.\*, shooter#71). A robot is a free-form tree of parts on a 20 cm surface-cell grid; this kit draws the parts and defines the socket, frame and origin convention that the weapon kit ([#594](https://github.com/moritzbrantner/asset-tooling/issues/594)) and the wheels and tracks kit ([#634](https://github.com/moritzbrantner/asset-tooling/issues/634)) share.

It is a reproducible Blender recipe, [`adapters/blender/combat_robot.py`](../adapters/blender/combat_robot.py), built to the [kit standard](kit-standard.md) and shipped as one rolling release, `shooter-combat-robot` (`shooter-combat-robot.kit.tar`). It is original procedural work with no third-party assets (see [Sources](#sources)). No game places it yet.

**Status.** The release has every part of #595: the nine static parts, the hinge and rotor joints with their axis frames, and the leg with its joint chain and reference walk clips. Every part is a closed surface, so it renders attached or detached on its own. Wheels and tracks come with #634 and weapons with #594.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-combat-robot.ts [--textures full|half] --out <directory>
```

[`scripts/build-combat-robot.ts`](../scripts/build-combat-robot.ts) runs the recipe once per part, variant and level, adds tangents and `COLOR_0`, writes the descriptor and encodes the shared atlas to KTX2. It needs KTX-Software's `ktx` CLI, but no network, GPU or LFS payloads, and takes a few minutes.

## Parts

Each part's key, cells and socket faces are Shooter's catalog row (`crates/shooter-sim/src/robot.rs`, `parts`; `robot.battery` from shooter#79). Cells are the part's x × y × z (width × depth × height) in 20 cm units.

| Key | Cells | Sockets | Triangles (LOD0 / lod1 / lod2) | Look |
| --- | --- | --- | --- | --- |
| `robot.chassis.20x40x80` | 1 × 2 × 4 | 28 | 568 / 120 / 12 | pale grey painted section, a recessed coupling on every cell |
| `robot.chassis.40x40x80` | 2 × 2 × 4 | 40 | 792 / 152 / 12 | |
| `robot.chassis.40x60x80` | 2 × 3 × 4 | 52 | 1,016 / 184 / 12 | |
| `robot.beam.20x20x40` | 1 × 1 × 2 | 10 | 220 / 60 / 12 | dark graphite structural beam, couplings on every cell |
| `robot.beam.20x20x80` | 1 × 1 × 4 | 18 | 380 / 92 / 12 | |
| `robot.core` | 1 × 1 × 1 | – | 1,156 / 208 / 24 | the kill target: a glowing orange reactor sphere in an open black cage on a hazard-striped base |
| `robot.sensor` | 1 × 1 × 1 | – | 220 / 84 / 36 | a housing with a large lens looking along the part's +x, side vents |
| `robot.battery` | 1 × 2 × 1 | – | 524 / 132 / 24 | one large cell along y in a cradle, a lit green charge window on top |
| `robot.armor.plate` | 2 × 2 × 1 | – | 262 / 44 / 12 | an olive faceted plate on two brackets; `damaged`: holed, dented, scorched, a corner shot away |
| `robot.joint.hinge` | 1 × 1 × 1 | 1 (top) | 520 / 200 / 24 | a hinge servo: a pale clevis bracket with drive caps holds a gunmetal knuckle on the part's x; the knuckle carries the moving plate with the coupling on top |
| `robot.joint.rotor` | 1 × 1 × 1 | 1 (top) | 492 / 188 / 24 | a continuous rotor: a square flange and drum, a steel bearing ring, and a turntable with hazard stripes round its rim (so a turn reads) and the coupling on top |
| `robot.leg` | 1 × 1 × 4 | – | 1,172 / 444 / 48 | a self-contained 80 cm leg from a hip bracket on the mount face to the sole: pale thigh with an actuator and vent, graphite shin with an olive guard, a foot whose hazard toe points along the part's +y |

The triangle counts are from the build of 2026-11-14; the descriptor carries each build's own. The core, sensor, battery, plate and leg have no sockets (Shooter's `Faces::NONE`), so nothing mounts on them; the hinge and rotor have one, on their moving top (Shooter's `Faces::TOP`, socket 0).

**Bundle entries.** Every part has `default`, `lod1` and `lod2`; the plate also has `damaged`, `damaged-lod1` and `damaged-lod2`, with the same outline and hit proxy. The hinge, rotor and leg have the same skin and joint nodes at every level (lod2 is one box per moving piece), and every leg level carries the walk clips. Levels end at 60 m and 180 m for a piece up to 1 m across, scaled with its widest side (`scaledLodDistances`), in the descriptor's `lodSelection` and per-part `lods` (variant `lods` under `variants`). On chassis and beams, lod1 draws each coupling flat in the texture and lod2 is the bare cuboid with one flat coupling drawn over each face, which keeps lod1's average tone.

**Materials and textures:** one opaque material, `robot-metal`, on a 2048 px KTX2 atlas of colour, normal, ORM (occlusion, roughness, metallic) and emissive. Its 4 × 4 cells hold the couplings (one per palette, plus their flat lod1 versions), paint, gunmetal, steel, hazard stripes, vents, the core's glow, the lens, the charge window, the armor and its damage, and the housings' panels. The glow of the core, lens and charge window is in the emissive map, at glTF emissive strength 1. Every part draws in one call.

## Socket-grid convention

This is the contract every socket-grid kit shares. `src/socket-grid.ts` implements it, and `test/socket-grid.test.ts` checks it against Shooter's numbering.

- **Units and axes:** metres, +Y up, right-handed glTF. A part's own x, y and z (Shooter's part frame, z its height) are glTF **+X, −Z and +Y**. The mount face is the part's −z face (glTF −Y).
- **Origin, the mount anchor:** the centre of the base's first cell (0, 0) on the mount face. The part's cuboid runs from (−0.1, 0, 0.1) to (0.2·x − 0.1, 0.2·z, 0.1 − 0.2·y), and no geometry leaves it (the test checks every level and variant), so parts on neighbouring sockets never clip.
- **Sockets:** one per surface cell on each face the part type declares, at the cell's centre on the face. Each face's grid has the axes of Shooter's `Face::grid` (u × v is the outward normal; cells count from the cuboid's minimum corner):

| Face | Normal | u | v |
| --- | --- | --- | --- |
| PosX | +X | −Z (part y) | +Y (part z) |
| NegX | −X | +Y (part z) | −Z (part y) |
| PosY (part +y) | −Z | +Y (part z) | +X (part x) |
| NegY (part −y) | +Z | +X (part x) | +Y (part z) |
| PosZ (part +z) | +Y | +X (part x) | −Z (part y) |
| NegZ (part −z) | −Y | −Z (part y) | +X (part x) |

- **Numbering:** faces in the order PosX, NegX, PosY, NegY, PosZ, NegZ (only the declared ones), then row by row: `id = (sockets of earlier faces) + v · columns + u`. This is Shooter's `PartType::socket`, so a 20 × 40 × 80 cm chassis has 28.
- **Mounting:** a child sits on one parent socket with its mount anchor on the socket, its +X along the socket's u, its −Z along v and its +Y along the normal. Its base then covers cells (u + i, v + j) of the face, as Shooter's footprint does. Shooter's orientation (binary angles, 65 536 a turn: yaw about the normal, then pitch, then roll, intrinsic Z-Y-X in the socket's (u, v, normal) frame) turns it about the mount anchor, so a quarter-turn yaw turns the footprint exactly as Shooter's does. In matrices: `child = parent · T(socket.position) · [uAxis vAxis normal] · R(yaw, pitch, roll) · C`, where `C` takes glTF +X, +Y and +Z to (1, 0, 0), (0, 0, 1) and (0, −1, 0).
- **Joints and anchors** (`joints[]`, `anchors[]`): a joint is a named motor axis (`kind` such as `hinge`, `rotor`, `wheel` or a leg sub-joint, its `origin`, unit `axis`, optional `node`, `parent`, `movingSockets` and `range` in radians). An anchor is a named point and direction that is not a socket, such as a muzzle, a mod mount or a foot's contact point. Both are in the part's glTF frame; see [Joints](#joints) for their meaning.

## Joints

The hinge, the rotor and the leg turn about axes that Shooter drives physically (shooter#73, physics-engine revolute joints). The kit only describes where the axes are and draws the parts so they turn cleanly; Shooter owns limits, torque, motion and gait.

| Part | Joint (`kind`) | `node` | `origin` | `axis` | Moving side | `range` (visual clearance) |
| --- | --- | --- | --- | --- | --- | --- |
| `robot.joint.hinge` | `hinge` (`hinge`) | `hinge` | (0, 0.1, 0) | (1, 0, 0), the part's x | socket 0 (top) | −π/2 … π/2 |
| `robot.joint.rotor` | `rotor` (`rotor`) | `rotor` | (0, 0.1, 0) | (0, 1, 0), the part's z: the socket normal | socket 0 (top) | continuous |
| `robot.leg` | `hip` (`leg-hip`) | `hip` | (0, 0.08, 0) | (1, 0, 0) | thigh, knee, shin, foot | −1.2 … 1.2 |
| | `knee` (`leg-knee`, parent `hip`) | `knee` | (0, 0.43, 0) | (1, 0, 0) | shin and foot | 0 … 2 |
| | `ankle` (`leg-ankle`, parent `knee`) | `ankle` | (0, 0.73, 0) | (1, 0, 0) | foot | −1 … 1 |

- **Zero and sign.** Zero is the pose as modelled (the leg straight, the hinge plate level). A positive angle turns right-handed about `axis`. On the leg, the part's +y (glTF −Z) is the toe's direction; a positive hip angle swings the leg back, a positive knee angle folds the shin back with the knee forward, and the ankle levels the foot.
- **`range`** is the angle the visual turns through without one piece entering another. It is not a gameplay limit.
- **The leg's anchor** `sole` (`foot-contact`, on node `ankle`) is the sole's centre at (0, 0.8, −0.01): `normal` (0, 1, 0) points out of the sole, along the leg away from the hip, and `up` (0, 0, −1) is the toe.
- **Revolute joints.** For an engine whose revolute joint takes a local anchor and a local axis per body (physics-engine's `RevoluteJoint { anchor_a, anchor_b, axis_a, axis_b }`, Rapier's): body A is the joint part, with `anchor_a = origin` and `axis_a = axis` as they are; body B is the child on the moving socket, with the same point and axis carried into its own frame through its mount. `revoluteFrames(joint, socket, orientation)` in `src/socket-grid.ts` computes both; for a child mounted unturned on a hinge it gives `anchor_b = (0, −0.1, 0)`, `axis_b = (1, 0, 0)`. At rest both bodies agree, so the engine's zero-angle reference can be any vector perpendicular to the axis (`RevoluteJoint::perpendicular(axis)`). The leg's sub-joints are inside one Shooter module (a beta leg is one part), so they matter only for drawing it.

**In the glTF.** An articulated part is one mesh, skinned rigidly to a bone chain (`base`, then the joints); every vertex has weight 1 on one bone, and no vertex is shared between bones. Each joint node rests unrotated at its `origin`, so its local axes are the part's: turning a joint is setting that node's rotation to the angle about `axis`. Children mounted on the moving socket follow the joint node. The skinned mesh is a root node beside its skeleton, as glTF expects.

**Walk clips (reference only).** Every level of `robot.leg` carries two looping glTF animations that turn `hip`, `knee` and `ankle` only (rotation channels, sampled at 30 frames a second), in place (the hip mount does not move). Shooter moves legs physically; these clips are for previews and for comparing gaits.

| Clip | Cycle | Stride | Planted | Body speed | Phase per leg |
| --- | --- | --- | --- | --- | --- |
| `walk-biped` | 1.0 s | 0.36 m | 60 % | 0.6 m/s | left 0, right 0.5 |
| `walk-quadruped` | 0.8 s | 0.28 m | 70 % | 0.5 m/s | rear-left 0, front-left 0.25, rear-right 0.5, front-right 0.75 |

While a foot is planted, its ankle slides back in a straight line 0.6 m from the hip (the sole 0.75 m below the mount face), so a body carried forward at the stated speed with its mount face 0.75 m up keeps planted feet still on the ground. Phase is the fraction of a cycle each leg runs ahead. The same cycle is `leg_pose(clip, phase)` in the recipe.

## Attach and detach

Shooter detaches and destroys parts one by one, so each part draws on its own:

- every level of every part is a closed surface (no open edge, tested), with a finished mount face: a part falling away shows no hole, and the parent's socket it leaves shows the coupling every free socket shows;
- a part is its own glTF scene (one mesh, and a skeleton if it articulates) and nothing leaves its cuboid at rest, so hiding, moving or dropping one part changes nothing else;
- on the hinge, rotor and leg each moving piece turns about a knuckle centred on its axis, held between cheeks on the fixed side, so a turned joint opens no gap and every piece stays whole.

No decals or sparks ship: scorch marks and sparks on a lost part are optional in #595 and belong to Shooter's effects.

## Descriptor `socket-grid-kit-descriptor-v1`

The descriptor is canonical JSON, the `socket-grid-descriptor` attachment of `robot.chassis.20x40x80` (`default`), and also written as `descriptor.json` next to the tar. Its schema is [`schemas/socket-grid-kit-descriptor-v1.schema.json`](../schemas/socket-grid-kit-descriptor-v1.schema.json).

| Field | Meaning |
| --- | --- |
| `schema`, `kit`, `units`, `up`, `handedness`, `cell` | `"socket-grid-kit-descriptor-v1"`, `"shooter-combat-robot"`, `"metre"`, `"+Y"`, `"right"`, `0.2` |
| `frame`, `faces`, `socketNumbering`, `mounting` | The convention above, as data and as rules. |
| `lodSelection` | The kit standard's projected-bounding-sphere rule. |
| `authority` | What Shooter owns (below). |
| `parts[]` | Per part: `key`, `kind`, `cells`, `socketFaces`, `cuboid` (from the cells), measured `bounds`, `triangles`, `mount` (the mount anchor's frame), `socketCount` and `sockets[]` (`id`, `face`, `u`, `v`, `position`, `normal`, `uAxis`, `vAxis`), `joints[]`, `anchors[]`, `hitProxies[]`, `lods` and `variants`. |
| `parts[].hitProxies` | One box (`center`, `size`, tag `hit-proxy`) round the part's full-detail bounds: a non-authoritative visual hit proxy. |
| `parts[].joints`, `parts[].anchors` | The joint axes and anchors of [Joints](#joints); empty for parts that do not articulate. |
| `compositions[]` | The review builds (below), each item with its `key`, `variant` or `placeholder: true` and `cells`, its `parent`, `socket` (id, `face`, `u`, `v`), `orientation`, and the resulting `translation` and `rotation` (quaternion x, y, z, w) in the build's frame, at rest. A root item's `orientation` turns it as if it stood on a socket on the ground (u = +X, v = −Z, normal +Y). |

**Authority.** Shooter owns the part IDs and footprints, hit state, damage, collision, motion, attachment legality and assembly. The kit's sockets, hit proxies and compositions are presentation data derived from Shooter's catalog; when Shooter changes a part's cells or socket faces, update `ROBOT_PARTS` in the build script and rebuild.

## Compositions

- **`humanoid`:** Shooter's `HEAVY` build exactly (the medium chassis as the torso, the core and a battery on its back, the sensor on top, a long beam per arm, two legs below, the rail gun along the left arm, the blade on the right arm's tip, the rocket launcher on top, the grapple on the chest), plus one armor plate on the chest. It faces +X and stands with its legs' feet at y = 0.
- **`robo-dog`:** the medium chassis turned a quarter (pitch) to lie along +X as the body, four legs on its underside at the corners, a sensor head on a hinge at the front that nods, the core and a battery on its back and an armor plate on each flank (one damaged).
- **`mini-tank`:** the large chassis lying along +X on two tracks underneath, a rotor on its deck with a short riser, a hinge on the riser's front and the rail gun on the hinge, so the gun turns and pitches; the core on the back, the sensor and a battery on the deck and an armor plate on the nose.
- **`turret`:** a stationary build: the large chassis as a pedestal with armor plates (one damaged) on its front and side, the core and a battery on its back, a rotor on top, a short riser beam, a hinge on the riser's front and the medium chassis on the hinge as a horizontal gun housing, with the sensor on top, an armor plate on its side and the rail gun on its muzzle end.

Every build faces +X. Parts other kits make (`robot.wheel`, `robot.track` from #634 and the `weapon.*` modules from #594) are listed as placeholders with their catalog cells. `test/socket-grid.test.ts` checks that every build assembles flush, with no two cuboids overlapping and every child touching its parent, that the legs' toes face +X and their joints turn about a sideways axis, that rotors turn about up and that the gun hinges pitch.

## Edit

The tables at the top of the recipe set the recess (`RIM`, `WALL`, `RECESS`), the colours and the atlas layout (`CELLS`). Each part is a short function in its `parts` section. To see a change, run the recipe in a live Blender (for example through the Blender MCP), in its own scene:

```python
import bpy, runpy
kit = runpy.run_path("adapters/blender/combat_robot.py")
kit["use_common"](runpy.run_path("adapters/blender/kit_common.py"))
kit["build"]("robot.core", bpy.context.scene.collection, level=0)
```

An articulated part comes back parented to its armature (`obj.parent`, `<key>.rig`): pose it through `rig.pose.bones[...]`, and the leg's walk clips are NLA tracks on the armature. Delete the `robot-metal` material and its `robot-metal-*` images first when you change the atlas: it is painted once per session. Blender's X, Y and Z are the part's own x, y and z, so a part built there is in Shooter's frame (the glTF exporter turns it to +Y up).

## Sources

The catalogued Quaternius *Sci-Fi Essentials Kit* (`quaternius.sci-fi-essentials-standard-models`, CC0) was checked first: it has creatures, guns and props but no modular robot parts, and its stylised low-poly look does not fit the brief. Kenney's and Poly Haven's CC0 libraries have no part on a 20 cm socket grid either. Every part is therefore original geometry and every texture is painted procedurally by the recipe; the kit uses no third-party files.

## Review

Review images are in [`review/shooter-combat-robot/`](../review/shooter-combat-robot/), rendered in EEVEE from the recipe and the descriptor's compositions, with the joints and legs posed by the same `leg_pose` cycle the clips bake:

- `humanoid.jpg`, `robo-dog.jpg`, `mini-tank.jpg` and `turret.jpg`: front (+X), side, back and three-quarter views of each build at rest;
- `motion-humanoid.jpg`, `motion-robo-dog.jpg`: six frames of one walk cycle (biped and quadruped phases, the body carried at the clip's speed); `motion-mini-tank.jpg`, `motion-turret.jpg`: six frames of the rotor turning and the hinge pitching the gun (the tank also driving). All at third-person gameplay scale: 3.6 m away, eye height 1.7 m, 60° vertical field of view;
- `motion-close.jpg`: the humanoid's legs mid-stride and the mini-tank's rotor and hinge close up, in motion;
- `detach.jpg`: the humanoid losing its right arm (with the blade) and its chest plate mid-fall, the robo-dog with a leg shot off, and a close look at the bare sockets and the fallen leg's closed hip mount;
- `gameplay.jpg`: all four builds in motion about 10 m away at a 60° vertical field of view, roughly a third-person opponent's distance;
- `close.jpg`: the turret's back, with the core, the battery, the rotor and the couplings close up;
- `parts.jpg`: every part and the damaged plate at full detail; `lods.jpg`: each part's three levels, front to back.

Placeholder parts are drawn as translucent purple boxes, each labelled with its catalog key, `PLACEHOLDER` and the issue that makes it. Shooter has no approved style capture yet; a passing test is not visual approval.

## Tests

`test/socket-grid.test.ts` (no Blender) checks the catalog rows and socket counts, Shooter's numbering, that every socket sits at a cell centre on its face, that a quarter turn turns a footprint as Shooter's does, the joint frames (unit part axes on the centre line, pivots inside the part, the moving socket on the top beyond the pivot), the revolute frames a child gets, and that the compositions assemble flush without overlaps and articulate as intended.

`test/blender/kits/combat-robot.test.ts` builds the kit (with `ASSET_TOOLING_BLENDER`) and checks that the tar and bundle verify with every part, variant and level; that it has one material and four KTX2 textures within the release budget; tangents and `COLOR_0`; that every level stays inside its cuboid, rests on its mount face and is closed; that exactly the articulated parts are skinned, rigidly, with each joint node unrotated on its descriptor pivot; that the leg's walk clips turn only its joints, loop in one cycle and stay within the joints' ranges; the descriptor against its schema, the socket counts, joints, anchors and hit proxies; LODs that at least halve, with their switch distances; and that the compositions name bundle entries or placeholders.
