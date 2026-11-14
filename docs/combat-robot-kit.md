# Shooter combat robot parts

Modular robot parts for the [Shooter](https://github.com/moenarch-games/shooter) beta's socket-grid robots ([#595](https://github.com/moritzbrantner/asset-tooling/issues/595), Shooter Atlas D2.i70.\*, shooter#71). A robot is a free-form tree of parts on a 20 cm surface-cell grid; this kit draws the parts and defines the socket, frame and origin convention that the weapon kit ([#594](https://github.com/moritzbrantner/asset-tooling/issues/594)) and the wheels and tracks kit ([#634](https://github.com/moritzbrantner/asset-tooling/issues/634)) share.

It is a reproducible Blender recipe, [`adapters/blender/combat_robot.py`](../adapters/blender/combat_robot.py), built to the [kit standard](kit-standard.md) and shipped as one rolling release, `shooter-combat-robot` (`shooter-combat-robot.kit.tar`). It is original procedural work with no third-party assets (see [Sources](#sources)). No game places it yet.

**Status (PR A of 2).** This release has the nine static parts. The hinge and rotor joints with their axis frames, the leg with its rig and reference walk clips, attach and detach rendering, and the in-motion review renders follow in PR B. The descriptor schema already has room for their joint frames.

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
| `robot.core` | 1 × 1 × 1 | – | 1,024 / 208 / 24 | the kill target: a glowing orange reactor sphere in an open black cage on a hazard-striped base |
| `robot.sensor` | 1 × 1 × 1 | – | 220 / 84 / 36 | a housing with a large lens looking along the part's +x, side vents |
| `robot.battery` | 1 × 2 × 1 | – | 524 / 132 / 24 | one large cell along y in a cradle, a lit green charge window on top |
| `robot.armor.plate` | 2 × 2 × 1 | – | 262 / 44 / 12 | an olive faceted plate on two brackets; `damaged`: holed, dented, scorched, a corner shot away |

The triangle counts are from the build of 2026-11-14; the descriptor carries each build's own. The core, sensor, battery and plate have no sockets (Shooter's `Faces::NONE`), so nothing mounts on them.

**Bundle entries.** Every part has `default`, `lod1` and `lod2`; the plate also has `damaged`, `damaged-lod1` and `damaged-lod2`, with the same outline and hit proxy. Levels end at 60 m and 180 m for a piece up to 1 m across, scaled with its widest side (`scaledLodDistances`), in the descriptor's `lodSelection` and per-part `lods` (variant `lods` under `variants`). On chassis and beams, lod1 draws each coupling flat in the texture and lod2 is the bare cuboid with one flat coupling drawn over each face, which keeps lod1's average tone.

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
- **Joints and anchors** (`joints[]`, `anchors[]`, empty in this release): a joint is a named motor axis (`kind` such as `hinge`, `rotor`, `wheel` or a leg sub-joint, its `origin`, unit `axis`, optional `node`, `parent`, `movingSockets` and `range` in radians). An anchor is a named point and direction that is not a socket, such as a muzzle or a mod mount.

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
| `compositions[]` | The review builds (below), each item with its `key`, `variant` or `placeholder: true` and `cells`, its `parent`, `socket` (id, `face`, `u`, `v`), `orientation`, and the resulting `translation` and `rotation` (quaternion x, y, z, w) in the build's frame. |

**Authority.** Shooter owns the part IDs and footprints, hit state, damage, collision, motion, attachment legality and assembly. The kit's sockets, hit proxies and compositions are presentation data derived from Shooter's catalog; when Shooter changes a part's cells or socket faces, update `ROBOT_PARTS` in the build script and rebuild.

## Compositions

- **`humanoid`:** Shooter's `HEAVY` build exactly (the medium chassis as the torso, the core and a battery on its back, the sensor on top, a long beam per arm, two legs below, the rail gun along the left arm, the blade on the right arm's tip, the rocket launcher on top, the grapple on the chest), plus one armor plate on the chest. It faces +X and stands with its legs' feet at y = 0.
- **`turret`:** a stationary build: the large chassis as a pedestal with armor plates (one damaged) on its front and side, the core and a battery on its back, a rotor on top, a short riser beam and the medium chassis on the riser's front as a horizontal gun housing, with the sensor on top, an armor plate on its side and the rail gun on its muzzle end.

Parts not in this release (`robot.joint.rotor`, `robot.leg` and the `weapon.*` modules) are listed as placeholders with their catalog cells. `test/socket-grid.test.ts` checks that both builds assemble flush, with no two cuboids overlapping and every child touching its parent.

## Edit

The tables at the top of the recipe set the recess (`RIM`, `WALL`, `RECESS`), the colours and the atlas layout (`CELLS`). Each part is a short function in its `parts` section. To see a change, run the recipe in a live Blender (for example through the Blender MCP), in its own scene:

```python
import bpy, runpy
kit = runpy.run_path("adapters/blender/combat_robot.py")
kit["use_common"](runpy.run_path("adapters/blender/kit_common.py"))
kit["build"]("robot.core", bpy.context.scene.collection, level=0)
```

Delete the `robot-metal` material and its `robot-metal-*` images first when you change the atlas: it is painted once per session. Blender's X, Y and Z are the part's own x, y and z, so a part built there is in Shooter's frame (the glTF exporter turns it to +Y up).

## Sources

The catalogued Quaternius *Sci-Fi Essentials Kit* (`quaternius.sci-fi-essentials-standard-models`, CC0) was checked first: it has creatures, guns and props but no modular robot parts, and its stylised low-poly look does not fit the brief. Kenney's and Poly Haven's CC0 libraries have no part on a 20 cm socket grid either. Every part is therefore original geometry and every texture is painted procedurally by the recipe; the kit uses no third-party files.

## Review

Review images are in [`review/shooter-combat-robot/`](../review/shooter-combat-robot/), rendered in EEVEE from the recipe and the descriptor's compositions:

- `humanoid.jpg` and `turret.jpg`: front (+X), side, back and three-quarter views of each build;
- `close.jpg`: the turret's back, with the core, the battery and the couplings close up;
- `gameplay.jpg`: both builds about 10 m away at a 60° vertical field of view, roughly a third-person opponent's distance;
- `parts.jpg`: every part and the damaged plate at full detail; `lods.jpg`: each part's three levels, front to back.

Placeholder parts are drawn as translucent purple boxes, each labelled with its catalog key and `PLACEHOLDER`. Shooter has no approved style capture yet; a passing test is not visual approval.

## Tests

`test/socket-grid.test.ts` (no Blender) checks the catalog rows and socket counts, Shooter's numbering, that every socket sits at a cell centre on its face, that a quarter turn turns a footprint as Shooter's does, and that the compositions assemble flush without overlaps.

`test/blender/kits/combat-robot.test.ts` builds the kit (with `ASSET_TOOLING_BLENDER`) and checks that the tar and bundle verify with every part, variant and level; that it has one material and four KTX2 textures within the release budget; tangents and `COLOR_0`; that every level stays inside its cuboid and rests on its mount face; the descriptor against its schema, the socket counts and hit proxies; LODs that at least halve, with their switch distances; and that the compositions name bundle entries or placeholders.
