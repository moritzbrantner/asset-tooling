# Strike effect meshes

Thirteen small animated meshes that a game spawns at a strike's contact point or on the weapon, so hits read at the gameplay camera ([#724](https://github.com/moritzbrantner/asset-tooling/issues/724), for moenarch-games/mmorpg#885's contact frames). The cleave sweep and the combo glint joined for Greyhaven's cleave and its follow-up window ([#754](https://github.com/moritzbrantner/asset-tooling/issues/754), mmorpg #909 and #910). The leap slam, dash trail and dash dust joined for the movement clips of [#767](https://github.com/moritzbrantner/asset-tooling/issues/767) ([#771](https://github.com/moritzbrantner/asset-tooling/issues/771), mmorpg #294); the movement-spell and control effects that glow or hold are in [`spell-effects`](spell-effects.md). The Tinker's bomb blast and trap snap joined for mmorpg#950 ([#775](https://github.com/moritzbrantner/asset-tooling/issues/775)); its flask pool and fire are spell effects. They are node- and morph-animated glTF meshes, not flipbooks; the arpg flipbooks in [`combat-effects`](combat-effects.md) stay as they are. They come from one reproducible Blender recipe, [`adapters/blender/strike_effects.py`](../adapters/blender/strike_effects.py), in one rolling release, `strike-effects` (`strike.effects.tar`). They are original and use no third-party sources. No game spawns them yet: timing, placement, tint and gameplay belong to the game.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-strike-effects.ts --out <directory>
```

[`scripts/build-strike-effects.ts`](../scripts/build-strike-effects.ts) runs the recipe once per entry through `external.blender.script@1`, checks each GLB with `scene.import.gltf@2` and exports a `gltf-resources-v1` bundle. It writes `strike.effects.tar` (+ `.sha256`), `export.ref.json`, `descriptor.json` and `lineage.json` in about twenty seconds. It needs no network, GPU, KTX-Software or LFS payloads, and a rebuild packs the same tar.

## Entries

Each key is `strike.effects.<entry>`, with one clip, `Play`, which plays once. Every entry ends at zero scale or zero area, so a game removes the instance when the clip ends.

| Entry | Use | Look | `Play` | Triangles | Extent over the clip (m) |
| --- | --- | --- | --- | --- | --- |
| `strike-arc-cut` | sword, dagger and axe chain hits | thin crescent ribbon, 1.15 m swing radius, sweeps 52° and thins onto its bright edge | 0.18 s | 64 | 2.2 × 1.6 |
| `strike-arc-heavy` | finishers, maces, two-handers | wider crescent, 1.55 m swing radius, with a low edge band | 0.25 s | 160 | 3.1 × 2.3 |
| `cleave-sweep` | a slash that hits more than one enemy | wide, flat fan, 1.6 m swing radius, about 190° of arc with a raised edge band; sweeps 105° and thins onto its edge | 0.3 s | 176 | 3.2 × 3.2 |
| `combo-glint` | the weapon while a follow-up window is open | a four-pointed star glint and a smaller, later twinkle, each three crossed star planes, that pop, turn and shrink away | 0.3 s | 64 | 1.0 × 1.0 × 0.85 |
| `strike-thrust` | spear and dagger stabs | narrow six-sided streak that stretches forward and thins, with a star flare at the contact | 0.15 s | 32 | 0.6 × 1.5 |
| `impact-burst` | any hit on a body | a core and 14 short spikes that pop, overshoot and shrink | 0.2 s | 50 | about 0.9 across |
| `ground-slam` | jumping-strike landing | flat ring with a low shock lip that grows to 1.6 m and thins away, and six chips thrown up and out | 0.4 s | 168 | 3.2 × 3.2 × 0.45 high |
| `lunge-dust` | running-strike start | five low dust puffs at and behind the feet that bloom, drift back and dissipate | 0.35 s | 120 | 1.0 × 1.0 × 0.3 high |
| `leap-slam` | Leap Slam's landing: spawn at the `Leap_Slam` contact, 0.36 s into the clip | a dark crater and seven jagged cracks that snap open, the long ones ahead of the attacker; a billowing dust ring that rolls out to about 1.9 m; five stones thrown up and forward. The cracks thin away last | 0.6 s | 160 | 3.5 × 3.4 × 0.8 high |
| `dash-trail` | a dash (`Dash_Lunge`, 0.4 s): spawn at the start | five pale speed streaks between knee and head height whose heads run ahead with the dasher and whose tails follow it in, so they stretch out and close up at the end | 0.4 s | 120 | 0.6 wide, 0.37–1.65 m high, z = 0 to 1 |
| `dash-dust` | a dash's start foot | three stretched dust puffs and five grit chips kicked back behind the start foot | 0.35 s | 92 | 0.8 × 1.35 × 0.36 high |
| `bomb-blast` | the Tinker's pot bomb going off where it lands (#775) | a warm fireball of nine spikes that flashes up and burns away, a shock ring racing out to the 3 m `radius` and thinning, three smoke clouds billowing up and four pot shards thrown out | 0.9 s | 195 | 5.6 × 5.6 × 1.9 high |
| `trap-snap` | the Tinker's spring trap snapping shut, at its `ground` frame (swap the trap to `triggered`) (#775) | a flat flash where the teeth meet, six sparks flicked off them and two dust puffs kicked out from under the base | 0.3 s | 68 | 0.24 × 0.84 × 0.51 high |

**Frames.** Metres, +Y up, right-handed, sized for the Ranger's reach.
- **Strike entries** (`align: "strike"`): origin at the contact point, +Z along the strike direction. The arcs lie in the XZ plane, their outer edge through the contact point and tangent to +Z there, curving back to their swing centre at `(-swingRadius, 0, 0)`. Roll them about Z for a diagonal or overhead cut, and mirror X for the other side.
- **Weapon entry** (`align: "weapon"`, `combo-glint`): origin at the point on the weapon to glint, usually the blade's tip or middle. Parent it to the weapon so it follows the swing; it reads from any side, so its rotation does not matter. Spawn it when the follow-up window opens, and again every 0.3 s or so while it stays open if the game wants a held cue.
- **Ground entries** (`align: "ground"`, `ground-slam`, `lunge-dust`, `leap-slam`, `dash-dust`, `bomb-blast` and `trap-snap`): origin at the landing or foot point on the ground, +Z the attacker's facing. Turn `leap-slam` to the attacker's heading: its long cracks and its stones go ahead.
- **Path entry** (`align: "path"`, `dash-trail`): origin at the start of the dash on the ground, +Z along the dash; the streaks run to z = 1 (`length: 1`), so scale Z by the dash distance and leave X and Y alone.

**Materials.** No textures. Colour and opacity are per vertex, in `COLOR_0` (RGBA): a bright edge at alpha 1 fading to alpha 0. Both materials are core glTF (no extensions), blended and double-sided:
- `strike-glow`: a warm white base colour with the same emissive colour, so it reads in an unlit or emissive pass. Used by the arcs, cleave, glint, thrust, burst, ring and dash streaks.
- `strike-dust`: a dusty brown base colour, no emission. Used by the dust puffs, the slam's chips and the leap slam's cracks, dust ring and stones (each mesh shades the brown darker or lighter through its vertex colour).

Tint an effect by changing its material's base and emissive colours. The kit costs 2 materials, at most 8 draw calls per entry, no texture memory and a 220 KB download.

**Animation.** Node translation, rotation and scale, sampled at 100 frames per second so every clip length is a whole number of frames. The two arcs, the cleave, the slam's ring and the leap slam's cracks and dust ring also have one morph target, `Thin`, which collapses the ribbon onto its bright edge (the ring onto its crest, the cracks onto their centre lines); its weight is part of the same `Play` clip.

## Descriptor `strike-effects-descriptor-v1`

The `strike-effects-descriptor` attachment on the first entry (also written as `descriptor.json`) has the frames (`origins`), the playback rule and, per entry, `key`, `role`, `use`, `align`, `clip` (`name`, `duration` in seconds, `loop: false`), `intendedScale` (1: the entries are already sized for the Ranger), `swingRadius` for the arcs, `length` for the dash trail, `radius` for the bomb blast (3 m, #775), `triangles`, `materials` and `bounds`. `bounds` is the box every frame of the clip stays inside, morphs included, so a game can cull an instance by it.

## Consumers

mmorpg would fetch the release like its other rolling bundles, for example `fetch_rolling strike-effects strike.effects effects/strike.effects` in its `scripts/fetch-bundles.sh`, and then load each `strike.effects.<entry>` glTF from the unpacked bundle. Wiring it in is mmorpg's change, not part of this kit.

## Edit

The tables at the top of the recipe set the clip lengths (`CLIP_SECONDS`), the arcs' radius, width, span, segments and sweep (`ARCS`), the burst's spikes (`SPIKES`), the slam's chips (`CHIPS`), the dust puffs (`PUFFS`), the leap slam's cracks and stones (`CRACKS`, `KINKS`, `STONES`), the dash streaks (`STREAKS`), the dash dust (`DASH_PUFFS`, `GRIT`) and the two material colours. Each entry is one function. To see a change, build it in a live Blender (for example through the Blender MCP) in its own scene with the scene at 100 fps:

```python
import bpy, runpy
fx = runpy.run_path("adapters/blender/strike_effects.py")
scene = bpy.data.scenes.new("strike-effects")
scene.render.fps = 100
fx["build"]("ground-slam", scene.collection)
```

Every `build` call starts its clip at frame 0. Delete the `strike-glow` and `strike-dust` materials to rebuild them after changing their colours.

## Test

`test/blender/strike-effects/` builds the real bundle and checks the keys, the two materials and no textures, the cost limit, one `Play` clip per entry of its declared length, RGBA `COLOR_0` on every primitive, blended double-sided core-glTF materials, the triangle ceiling, the frames (the arcs and the cleave reach the contact point and curve back past their swing centre, the ground entries rest on the ground, the thrust trails back along -Z, the leap slam reaches further ahead than behind, the dash trail runs from 0 to 1 and the dash dust is kicked back) and a byte-identical rebuild. It skips without Blender.

## Review

Review renders are in [`review/strike-effects/`](../review/strike-effects/): `game-camera.jpg` (the 12 m, 0.42 rad pitch, 50° Greyhaven camera, early in each clip, with 1.8 m stand-in figures), `close-up.jpg` (the burst, thrust and arcs from the side) and `overview.jpg` (from above, later in each clip); `follow-up.jpg` shows the cleave sweep and the combo glint at the same game camera, over three moments of each clip (#754); `movement-strips.jpg` shows the leap slam and the dash trail and dust at five moments of each clip, cropped from the same game camera at in-game pixel size, and [`review/spell-effects/movement-game-camera.jpg`](../review/spell-effects/movement-game-camera.jpg) the whole #771 set at the game camera (#771).

CI publishes the rolling `strike-effects` release when this merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). `releases/strike-effects.json` holds its budget (2 materials, 1 MB of texture memory, a 1 MB download).
