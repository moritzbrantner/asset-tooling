# Shooter weapons and mods

The eight weapons and four weapon mods of the [Shooter](https://github.com/moenarch-games/shooter) beta's socket-grid robots ([#594](https://github.com/moritzbrantner/asset-tooling/issues/594)). They are the companion of the [robot part kit](combat-robot-kit.md) (#595) and use its socket, frame and origin convention, its `Part` builder and its palette.

It is a reproducible Blender recipe, [`adapters/blender/shooter_weapons.py`](../adapters/blender/shooter_weapons.py), built to the [kit standard](kit-standard.md) and shipped as its own rolling release, `shooter-weapons` (`shooter-weapons.kit.tar`). It is original procedural work with no third-party assets (see [Sources](#sources)). No game places it yet.

**Why its own release.** The robot release is near its 2 MB download budget (1.80 MB since the core was retired), and weapons are a separate catalogue a game may load on its own (pickups, shooter#62). One kit, one release (kit standard): `shooter-weapons` has its own `releases/shooter-weapons.json` and budget (1 material, 6 MB texture memory, 1.8 MB download; measured 5.6 MB and 1.61 MB).

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-shooter-weapons.ts [--textures full|half] --out <directory>
```

[`scripts/build-shooter-weapons.ts`](../scripts/build-shooter-weapons.ts) runs the recipe once per weapon or mod and level, drops animation channels that never move, adds tangents and `COLOR_0`, writes the descriptor and encodes the shared atlas to KTX2. The recipe declares `combat_robot.py` and `kit_common.py` as its Python inputs. It needs KTX-Software's `ktx` CLI, but no network, GPU or LFS payloads, and takes about a minute.

## Weapons

Each key and cuboid is Shooter's catalog row (`crates/shooter-sim/src/robot.rs`, `parts::weapon`: a light weapon is 1 × 1 × 2 cells, a heavy one 1 × 2 × 2, no sockets). The glow is Shooter's energy colour for the weapon (`crates/shooter-client/src/effects.rs`, `tint`), so a weapon reads by colour as well as by shape.

| Key | Cells | Triangles (LOD0 / lod1 / lod2) | States | Look |
| --- | --- | --- | --- | --- |
| `weapon.energy-rifle` | 1 × 1 × 2 | 524 / 220 / 72 | `fire` | a short pale receiver with a sight and a cyan energy cell, a long finned gunmetal shroud, a cyan muzzle ring |
| `weapon.shotgun` | 1 × 1 × 2 | 568 / 268 / 96 | `fire` (kick, then pump) | a chunky gunmetal receiver with a hazard band, two stacked wide barrels, a ribbed pump, yellow shell lights |
| `weapon.laser` | 1 × 1 × 2 | 848 / 424 / 84 | `beam` (loop) | a round finned body, a flared head with a red lens and three focusing prongs on a ring that turns while it fires |
| `weapon.flamethrower` | 1 × 1 × 2 | 540 / 256 / 84 | `fire` (loop) | a pale body, an olive striped fuel tank with a gauge, a flared steel nozzle with an orange pilot ring |
| `weapon.grapple-hook` | 1 × 1 × 2 | 544 / 268 / 132 | `launch`, `retract` | a hazard-striped launch tube, a cable winch, the hook (a steel spike, a green band, three claws that open) |
| `weapon.energy-blade` | 1 × 1 × 2 | 478 / 194 / 82 | `extend`, `retract`, `swing` | a gunmetal hilt with a grip and a pale guard, and a magenta plasma blade |
| `weapon.rail-gun` | 1 × 2 × 2 | 712 / 304 / 96 | `charge`, `fire` | a pale capacitor block, two gunmetal rails with an open violet channel between them that fills as it charges |
| `weapon.rocket-launcher` | 1 × 2 × 2 | 872 / 404 / 132 | `fire-a`, `fire-b`, `reload` | a gunmetal cradle with two olive tubes, a red warhead showing in each, orange ready lights |

**Axes.** A weapon points out of its socket: its barrel, emitter, hook or blade runs along the part's +z (glTF +Y), its muzzle at the far end, and its up is the part's +y (glTF −Z). How a weapon is aimed on a robot is the build's choice of socket and orientation (Shooter's). Every level stays inside the weapon's cuboid at rest, so weapons on neighbouring sockets never clip. A stock barrel ends 9 to 10 cm short of the cuboid's top on the rifle, laser and rail gun, which leaves room for the long barrel.

**Rig.** A weapon is one mesh skinned rigidly (every vertex weight 1 on one node) to a short node chain: `base`, the moving pieces (`barrel`, `pump`, `emitter`, `nozzle`, `hook`, `claw-1..3`, `spool`, `wrist`, `blade`, `rails`, `rocket-a`, `rocket-b`) and the two emissive channels. Every node rests unrotated at its pivot, in the part's own axes, and is one draw call. lod1 and lod2 have the same nodes and the same animations.

**Emissive channels.** `glow-charge` (energy, charge or readiness: the rifle's cell, the shotgun's shell lights, the laser's strip, the fuel gauge, the grapple's ready light, the blade's guard lights, the rail gun's channel, the rocket pod's ready lights) and `glow-fire` (the flash when it fires: muzzle rings, the laser's lens, the pilot ring, the hook's band, the launch light; the blade has none, its blade is the glow). A channel's glow geometry sits proud of a dark housing; its node's scale is the channel's level: 1 lit as modelled, 0 hidden, above 1 a flash. A charge channel scales along its length, like a bar filling. The clips animate them; a renderer may also set them from game state. The glow colour is in the atlas's emissive map at glTF emissive strength 1.

**States.** Each is one glTF animation at 30 frames a second:

| Weapon | State | Loop | Seconds | Moves |
| --- | --- | --- | --- | --- |
| rifle | `fire` | – | 0.2 | the barrel kicks back 2.5 cm; the muzzle flashes; the cell dips and refills |
| shotgun | `fire` | – | 0.6 | the barrels kick 2 cm, then the pump racks 5 cm back and forward; the shell lights empty and refill |
| laser | `beam` | yes | 0.5 | the prong ring turns a third of a turn; the lens glows brighter |
| flamethrower | `fire` | yes | 0.4 | the pilot ring flickers, the nozzle shakes |
| grapple | `launch` | – | 0.2 | the hook pushes 12 cm out, its claws open, the winch spins, the band flashes |
| | `retract` | – | 0.4 | the reverse, from 12 cm out |
| blade | `extend`, `retract` | – | 0.2 | the blade grows out of (or shrinks into) the emitter |
| | `swing` | – | 0.47 | the hilt swings about its wrist from −0.9 to +0.9 rad and back (the quick-melee reference) |
| rail gun | `charge` | – | 1.0 | the charge fills the channel between the rails; the muzzle ring lights at the end |
| | `fire` | – | 0.3 | the rails kick 3 cm; the muzzle flashes; the channel empties |
| rocket launcher | `fire-a`, `fire-b` | – | 0.27 | that tube's rocket slides out and disappears (it is in flight: Shooter's); the launch light flashes |
| | `reload` | – | 0.83 | both rockets slide back up their tubes; the ready lights come on |

Shooter's grapple moves the `hook` node to its target itself (it leaves the cuboid) and draws the cable from the `muzzle` anchor to the `cable` anchor.

## Anchors

Anchors use the robot kit's `anchors[]` (glTF part frame, metres; `normal` is the fire or mount direction, `up` the weapon's up), each riding a node:

| Weapon | Anchors |
| --- | --- |
| rifle | `muzzle` (0, 0.31, 0) on `barrel`; `mod-muzzle` there; `mod-side` (−0.05, 0.105, 0) |
| shotgun | `muzzle` (0, 0.362, 0) on `barrel`, between the two bores; `mod-side` (−0.05, 0.115, 0) |
| laser | `muzzle` (kind `emitter`) (0, 0.295, 0); `mod-muzzle` there |
| flamethrower | `muzzle` (kind `emitter`) (−0.012, 0.366, 0) on `nozzle` |
| grapple | `muzzle` (kind `launcher`) (0, 0.283, 0), where the cable leaves; `cable` (kind `cable-anchor`) (0, 0.24, 0) on `hook`, where it ends; `hook-tip` (0, 0.4, 0) on `hook` |
| blade | `blade-base` (0, 0.195, 0) and `blade-tip` (0, 0.4, 0) on `blade` (kind `blade-edge`, `up` the cutting edge, the part's +x), for a swing trail; joint `wrist` (kind `blade-swing`) at (0, 0.045, 0) about (1, 0, 0), range ±0.9 |
| rail gun | `muzzle` (0, 0.31, −0.1) on `rails`; `mod-muzzle` there; `mod-side` (−0.05, 0.075, −0.1) |
| rocket launcher | `muzzle-a` (0.008, 0.353, 0) and `muzzle-b` (0.008, 0.353, −0.2); `mod-side` (−0.05, 0.17, −0.1) |

The muzzle frames are for effects only: Shooter owns where shots start and what they hit.

## Mods

Four static add-ons, Shooter's catalog mods (`BETA.mods`; code 4, the heat sink, is retired and not built). Each has its own frame: its origin is the point it sits on, its glTF +Y the anchor's normal and its −Z the anchor's up (so u = up × normal, as on a socket). A side mod is at most 7 × 12 cm and 5 cm deep and sits on a dark rail on the weapon's −x side; the long barrel continues the muzzle.

| Key | Sits on | Fits in Shooter today | Triangles | Look |
| --- | --- | --- | --- | --- |
| `mod.rapid-cycler` | `mod-side` | rifle, rail gun, shotgun | 188 / 76 / 24 | a fluted steel drum with a hazard band between bearing blocks |
| `mod.overcharger` | `mod-side` | rifle, rail gun, shotgun | 320 / 144 / 36 | a pale capacitor block with two red-hot coils |
| `mod.long-barrel` | `mod-muzzle` | rifle, rail gun, laser | 168 / 84 / 36 | a 9 cm fluted barrel extension with a slotted muzzle brake; its own `muzzle` anchor (0, 0.09, 0) replaces the weapon's |
| `mod.efficiency-coil` | `mod-side` | rifle, rail gun, rocket launcher, shotgun | 180 / 48 / 24 | a copper coil between steel caps with a green window |

A weapon carries a `mod-side` or `mod-muzzle` anchor exactly when a mod Shooter's catalog fits on it uses that anchor; the descriptor's `fits` repeats the catalog for reference, and Shooter decides. Every mod stays inside the cuboid of every weapon it fits (tested), so a modded weapon clips nothing its stock version does not. The long barrel makes a light weapon a heavy module in Shooter (a two-cell footprint along the part's y); its visual stays inside the weapon's own 1 × 1 × 2 cuboid, along the barrel.

## Descriptor `socket-grid-kit-descriptor-v2`

The descriptor is canonical JSON, the `socket-grid-descriptor` attachment of `weapon.energy-rifle` (`default`), and also written as `descriptor.json` next to the tar. Its schema is [`schemas/socket-grid-kit-descriptor-v2.schema.json`](../schemas/socket-grid-kit-descriptor-v2.schema.json): the published v1 (unchanged) plus what weapons need:

| Field | Meaning |
| --- | --- |
| `parts[]` | As in v1 (`cells`, `cuboid`, `bounds`, `mount`, `sockets` (none), `joints`, `anchors`, `hitProxies`, `lods`), plus `channels[]` (`name`, `node`, `kind: emissive`, linear `colour`, `meaning`) and `states[]` (`name`, `animation`, `loop`, `seconds`, `use` such as `fire`, `continuous-fire`, `charge`, `launch`, `swing`, `reload`, and the `nodes` it moves). |
| `mods[]` | `key`, `kind: mod`, `mountsOn` (the anchor name), `fits`, `bounds`, `triangles`, `mount`, `anchors` (the long barrel's `muzzle`) and `lods`. |
| `weaponAxes`, `channelRule`, `modMounting` | The rules above, as text. |
| `compositions[]` | The review builds; an item from another kit names it (`kit: "shooter-combat-robot"`), and a modded weapon carries `mod` (`key`, `anchor`, `translation`, `rotation` in the build's frame). |

**Authority.** Shooter owns the weapon and mod IDs and footprints, which mods fit, firing, energy, damage, hits, ranges, pickups, audio, effects, attachment legality and assembly. Anchors and muzzles are for effects; the hit proxy (one box round the full-detail bounds) is non-authoritative.

## Compositions

`standard`, `heavy`, `skirmisher` and `marksman` are Shooter's named loadouts exactly (`robot.rs`, `LOADOUTS`, with their mods), on the robot kit's parts. `turret` is the robot kit's turret with the rail gun, a laser and a flamethrower on its housing; `mini-tank` is its mini-tank with a long-barrel rail gun on the turret hinge and a rocket pod on the deck (the tracks stay placeholders until #634). `test/shooter-weapons.test.ts` checks that they assemble flush without overlaps, that every mod sits inside its weapon and that between them they show every weapon and mod.

## Attach and detach

Every level of every weapon and mod is a closed surface (tested), with a finished mount plate. A weapon is its own glTF scene that stays inside its cuboid at rest, so when its parent part falls away, the weapon (and its mod, on its anchor node) goes with it without tears; `detach.jpg` shows it.

## Edit

The tables at the top of the recipe set the atlas (`CELLS`, 128 px units on 1024 px), the glow colours (`TINT`) and the states (`STATES`). Each weapon is a short function. To see a change in a live Blender, in its own scene:

```python
import bpy, runpy
kit = runpy.run_path("adapters/blender/shooter_weapons.py")
kit["use_sources"](runpy.run_path("adapters/blender/combat_robot.py"), runpy.run_path("adapters/blender/kit_common.py"))
kit["build"]("weapon.rail-gun", bpy.context.scene.collection, level=0)
```

The weapon comes back parented to its armature; its states are NLA tracks (mute all but one to see it). Delete the `weapon-metal` material and its `weapon-metal-*` images first when you change the atlas. When Shooter changes a weapon's cells or a mod's fits, update `WEAPON_PARTS` / `WEAPON_MODS` in the build script and the recipe's `PARTS`, then rebuild.

## Sources

The catalogued CC0 Quaternius *Sci-Fi Essentials Kit* has guns, but as stylised low-poly hand-held models: none fits a 20 cm socket cuboid pointing out of its socket, none has the robot kit's look, and adapting one would mean rebuilding it. Kenney's and Poly Haven's CC0 libraries have nothing on a socket grid. Every weapon and mod is therefore original geometry built by the recipe, on the robot kit's `Part` builder, with procedurally painted textures; the kit uses no third-party files and no paid sources or generators.

## Review

Review images are in [`review/shooter-weapons/`](../review/shooter-weapons/), rendered by [`scripts/review-shooter-weapons.py`](../scripts/review-shooter-weapons.py) in EEVEE from the recipes and a build's `descriptor.json`:

```sh
<blender 5.2.2> -b --factory-startup -P scripts/review-shooter-weapons.py -- --descriptor <build>/descriptor.json --out review/shooter-weapons
```

Unless noted, at third-person gameplay scale: 3.6 m from the build, the eye 1.7 m up, a 60° vertical field of view.

- `loadouts.jpg`: the four loadouts, front and back three-quarter (standard, heavy; skirmisher, marksman);
- `firing.jpg`: a shot per weapon from the side of its fire direction: rifle and shotgun (standard), laser and flamethrower (turret), rail gun and rockets (heavy), the long-barrel rail gun (mini-tank), the long-barrel rifle (marksman);
- `blade-grapple.jpg` (3.6 m) and `blade-grapple-close.jpg` (1.6 m): the blade retracted, extending, extended and through its swing; the grapple ready, launching, launched, its hook 1 m and 2.5 m out on the cable, retracting;
- `mods.jpg`: each mod on its loadout close up, then skirmisher and marksman at gameplay scale;
- `detach.jpg`: heavy losing its right arm with the blade, marksman its left arm with the long-barrel rifle, the turret its gun housing with three weapons;
- `turret.jpg`, `mini-tank.jpg`: front, side, back and three-quarter;
- `gameplay.jpg`: all six builds about 10 m away;
- `weapons.jpg`: every weapon and every mod on a weapon, close (30° lens); `lods.jpg`: each weapon's three levels.

The muzzle flashes, bolts, beams, flames, pellets, rocket exhaust and the grapple's cable are review cues drawn from the descriptor's muzzle and cable frames; they do not ship (Shooter's effects do that). Placeholder tracks are translucent purple boxes. Shooter has no approved style capture yet; a passing test is not visual approval.

## Tests

`test/shooter-weapons.test.ts` (no Blender) checks the weapon and mod rows against Shooter's catalog and the robot kit's placeholders, that anchors sit inside their weapon with perpendicular unit frames and that each weapon has exactly the mod anchors its fits need, that every mod stays inside the cuboid of every weapon it fits and the long barrel's muzzle continues the weapon's, and that the loadouts, turret and mini-tank assemble flush without overlaps.

`test/blender/kits/shooter-weapons.test.ts` builds the kit (with `ASSET_TOOLING_BLENDER`) and checks that the tar and bundle verify with every weapon, mod and level; one material and four KTX2 textures within the release budget; tangents and `COLOR_0`; that every level is closed, rests on its mount face and stays inside its cuboid (weapons) or envelope (mods); that each weapon is skinned rigidly with every node unrotated, its channel, anchor and joint nodes present and the blade's wrist on its pivot; that its states are its animations, of its own nodes, as long as declared, loops ending where they start; the descriptor against the v2 schema; LODs that at least halve, with their switch distances; and that composition items name bundle entries, robot parts or placeholders.
