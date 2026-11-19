# Spell effect meshes

Twenty-four small meshes that make mmorpg's spells look like spells and its arrows like arrows ([#726](https://github.com/moritzbrantner/asset-tooling/issues/726), for the combat overhaul after moenarch-games/mmorpg#884, where every projectile is still a ball and a box). Blink, a grapple rope and hook, the rooted-feet vine and ice holds and an ice-slip scrape joined for the movement and control clips of [#767](https://github.com/moritzbrantner/asset-tooling/issues/767) ([#771](https://github.com/moritzbrantner/asset-tooling/issues/771), mmorpg #294 movement spells, #933 Frost Nova and #934 Entangling Roots); the vine and ice holds can replace mmorpg's procedural ring and vines. The leap slam and the dash trail and dust are in [`strike-effects`](strike-effects.md). Four looping school bolts, five school impacts, a frost nova, a tileable beam segment and heal motes are node- and morph-animated glTF meshes with vertex-colour alpha and an emissive glow; the arrow, crossbow bolt and throwing knife are static, opaque models. They come from one reproducible Blender recipe, [`adapters/blender/spell_effects.py`](../adapters/blender/spell_effects.py), in one rolling release, `spell-effects` (`spell.effects.tar`). They are original and use no third-party sources. Spawning, timing, placement and gameplay belong to the game.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-spell-effects.ts --out <directory>
```

[`scripts/build-spell-effects.ts`](../scripts/build-spell-effects.ts) runs the recipe once per entry through `external.blender.script@1`, checks each GLB with `scene.import.gltf@2` and exports a `gltf-resources-v1` bundle. It writes `spell.effects.tar` (+ `.sha256`), `export.ref.json`, `descriptor.json` and `lineage.json` in about fifteen seconds. It needs no network, GPU, KTX-Software or LFS payloads, and a rebuild packs the same tar.

## Entries

Each key is `spell.effects.<entry>`. `Loop` clips repeat while the projectile or beam lives; `Play` clips run once and end at zero scale or zero area, so a game removes the instance when the clip ends.

| Entry | Use | Look | Clip | Triangles | Extent (m) |
| --- | --- | --- | --- | --- | --- |
| `bolt-fire` | Firebolt | hot core in a tumbling shell of back-swept flame tongues, flickering tail | `Loop` 0.4 s | 104 | 0.46 × 0.41 × 0.77 |
| `bolt-shadow` | Shadow Bolt, Corruption | violet orb wrapped in two winding green wisps, dark violet tail | `Loop` 0.6 s | 120 | 0.34 × 0.34 × 0.62 |
| `bolt-holy` | Smite | gold core with a turning star of pale rays, pale gold tail | `Loop` 0.5 s | 80 | 0.56 × 0.58 × 0.64 |
| `bolt-nature` | Wrath | green seed of light with three leaves spinning about it, green tail | `Loop` 0.6 s | 92 | 0.3 × 0.3 × 0.63 |
| `impact-fire` | a fire hit | hot flash and flame tongues thrown out and up | `Play` 0.35 s | 70 | about 0.9 across, 0.8 high |
| `impact-shadow` | a shadow hit | violet shell that swells and collapses inward, green sparks | `Play` 0.4 s | 96 | about 1.2 across |
| `impact-holy` | a holy hit | gold flash star and a column of light that rises and narrows | `Play` 0.4 s | 54 | about 1.1 across, 1.7 high |
| `impact-nature` | a nature hit | green flash and six leaves thrown up and out | `Play` 0.45 s | 58 | about 1.1 across |
| `impact-frost` | a frost hit | pale flash and a burst of four-sided ice shards | `Play` 0.35 s | 48 | about 0.75 across |
| `arrow` | bow shots | steel broadhead, ash shaft, three vanes (one red cock feather), nock | none | 62 | 0.8 long |
| `crossbow-bolt` | crossbow shots | square bodkin head, thick dark shaft, two leather vanes | none | 44 | 0.45 long |
| `throwing-knife` | thrown knives | double-edged blade, leather grip, ring pommel | none | 72 | 0.22 long |
| `frost-nova` | Frost Nova | frost wave and 16 ice spikes bursting out to 8 m, then sinking | `Play` 0.5 s | 192 | 16.5 across, 1.6 high |
| `beam-segment` | Lightning Beam, Holy Beam | three crossed glow planes about a jagged core; `Crackle` morph | `Loop` 0.24 s | 128 | 0.3 × 0.26 × 1 |
| `heal-motes` | Renew, Rejuvenation, heals | eight soft motes spiralling up around the target | `Play` 0.8 s | 96 | 1.1 across, 0.2–2.25 high |
| `blink-out` | Blink, as the caster leaves (`Blink_Out`, 0.3 s) | a shimmer column about the body narrows to nothing while ten motes spiral in to the caster's middle, which pops with a small star | `Play` 0.3 s | 168 | 1.1 across, 2.3 high |
| `blink-in` | Blink, as the caster arrives (`Blink_In`, 0.4 s) | a star flash at the body, a shimmer column that flares and narrows, eight motes thrown out, and a faint ring that runs out over the ground to 1.15 m | `Play` 0.4 s | 208 | 2.3 across, 2.1 high |
| `grapple-rope` | a grapple's rope from the hand to the hook (`Grapple_Throw` releases 0.4 s in) | two twisted strands of hemp; half a turn per piece, so copies tile | none | 128 | 0.06 × 0.06 × 1 |
| `grapple-hook` | a grapple's hook, flying and caught | a three-pronged iron grapnel, prongs curving back from the crown, with a rope lashing at its eye | none | 174 | 0.28 × 0.25 × 0.4 |
| `roots-hold-loop` | Entangling Roots: a rooted target's feet while it holds | four bark-and-green vines out of the ground, coiling round both ankles, with a leaf each; they slowly squeeze and ease | `Loop` 1.2 s | 188 | 0.87 × 0.69 × 0.64 high |
| `roots-hold-end` | the root breaking | the same vines give a last squeeze, then let go and sink into the ground | `Play` 0.35 s | 188 | the same |
| `frost-hold-loop` | Frost Nova's freeze: a rooted target's feet while it holds | ice shards jutting round both ankles, a glassy band about each ankle and a frosted patch on the ground, with three glints twinkling in turn | `Loop` 1 s | 112 | 0.76 × 0.72 × 0.49 high |
| `frost-hold-end` | the freeze breaking | the shards burst out and sink, the crust shrinks away and the glints flash once | `Play` 0.35 s | 112 | 0.94 × 0.8 × 0.49 high |
| `ice-slip-scrape` | feet sliding on ice | two pale frost scrapes and two fine scratches drawn out along the slide, ice chips flicked to the sides; the scrapes then thin away | `Play` 0.6 s | 96 | 0.86 wide, z = 0 to 1 |

**Frames.** Metres, +Y up, right-handed, at mmorpg's projectile scale (its primitive arrow is 0.8 m, its spell ball 0.12 m in radius).
- **Tip** (`align: "tip"`, bolts and shots): origin at the tip, +Z forward; the body and tail trail back along -Z. The game spins a knife itself.
- **Hit** (`align: "hit"`, impacts): origin at the hit point; the holy column and fire tongues rise along +Y.
- **Ground** (`align: "ground"`, `frost-nova`, `heal-motes`, the blinks and the holds): origin at the caster's or target's feet, +Z its facing. The blinks gather and burst at 1 m, the body's middle; the holds sit round two ankles 0.26 m apart across +Z. The nova is authored at Frost Nova's 8 m radius (`radius: 8`); a game with another radius scales X and Z by radius / 8.
- **Beam** (`align: "beam"`): one segment from z = 0 to z = 1 (`tileLength: 1`), with the same cross-section at both ends. Scale it along Z to the beam's length, or lay copies end to end.
- **Path** (`align: "path"`, `ice-slip-scrape`): origin at the feet where the slide starts, on the ground, +Z along the slide; the scrapes run to z = 1 (`length: 1`), so scale Z by the slide distance.
- **Grapple**: `grapple-rope` is a beam piece (`align: "beam"`): stretch it from the hand to the hook's eye or lay copies end to end. `grapple-hook` is a shot (`align: "tip"`): origin at its crown, +Z towards the target; its eye, where the rope ties on, is at z = -0.4 (`length: 0.4`).

**Materials and tint.** No textures. Colour and opacity are per vertex, in `COLOR_0` (RGBA), times the material's base colour. Spell vertex colours stay at or below white, so the material colour is each school's brightest hue and a game recolours an entry by setting its material's base and emissive colours. Each descriptor entry names its main material and its authored sRGB colour in `tint`.
- `spell-fire` `#ffa84c`, `spell-shadow` `#b36bff`, `spell-holy` `#ffe08c`, `spell-nature` `#9eff6b`, `spell-frost` `#b3e5ff`: one per school, blended, double-sided, emissive (core glTF, emissive factor equal to the base colour).
- `spell-fel` `#99ff6b`: the shadow bolt's wisps and the shadow impact's sparks.
- `spell-energy` `#dbedff`: a pale neutral glow for the beam and the heal motes, which a game tints per spell (blue-white lightning, gold Holy Beam and Renew, green Rejuvenation).
- `shot`: opaque, white base; the vertex colours give wood, steel, leather, feathers, hemp rope and the bark-and-green vines of the roots hold, which stay opaque and earthy rather than glowing.

The kit costs 8 materials, at most 17 draw calls per entry (the frost nova), no texture memory and a 460 KB download.

**Animation.** Node translation, rotation and scale, sampled at 100 frames per second so every clip length is a whole number of frames, and loop clips end where they start. The bolt tails carry a `Flicker` morph, the beam a `Crackle` morph (its jagged core jumps to new kinks; the ends stay on the axis so tiles still meet), and the frost wave a `Thin` morph that collapses it to its crest; the blink-in ring and the ice-slip scrapes carry a `Thin` morph too, the root vines a `Writhe` morph (tighter coils, turned a little) and the frost crust a `Shatter` morph (each shard thrown out and down from its ankle); their weights are part of the entry's clip. A `*-hold-loop` entry repeats while the hold lasts; when it breaks, swap it for its `*-hold-end` entry, which starts from the loop's crust or vines at rest and ends gone.

## Descriptor `spell-effects-descriptor-v1`

The `spell-effects-descriptor` attachment on the first entry (also written as `descriptor.json`) has the frames (`origins`), the playback and tinting rules and, per entry, `key`, `role`, `use`, `school`, `align`, `clip` (`name`, `duration` in seconds, `loop`; `null` for the shots), `intendedScale` (1: already at the game's scale), `tint` (`material`, `colour`), `radius` for the nova, `tileLength` for the beam and the grapple rope, `length` for the shots, the grapple hook and the ice-slip scrape, `triangles`, `materials` and `bounds`. `bounds` is the box every frame of the clip stays inside, morphs included, so a game can cull an instance by it.

## Consumers

mmorpg would fetch the release like its other rolling bundles, `fetch_rolling spell-effects spell.effects effects/spell.effects` in its `scripts/fetch-bundles.sh`, then load each `spell.effects.<entry>` glTF from the unpacked bundle in place of the ball-and-box projectiles of `crates/mmorpg-presentation/src/units/mod.rs` `projectiles()`. Wiring it in is mmorpg's change, not part of this kit.

## Edit

The tables at the top of the recipe set the clip lengths (`CLIPS`), the material colours (`COLOURS`), the shot colours, the nova radius, and the impact leaves, shards and heal motes (`LEAVES`, `SHARDS`, `MOTES`). Each entry is one function. To see a change, build it in a live Blender (for example through the Blender MCP) in its own scene at 100 fps:

```python
import bpy, runpy
fx = runpy.run_path("adapters/blender/spell_effects.py")
scene = bpy.data.scenes.new("spell-effects")
scene.render.fps = 100
fx["build"]("bolt-fire", scene.collection)
```

Every `build` call starts its clip at frame 0. Delete the `spell-*` and `shot` materials to rebuild them after changing their colours.

## Test

`test/blender/spell-effects/` builds the real bundle and checks the keys, the eight materials and no textures, the cost limit, each entry's clip (one `Loop` or `Play` of its declared length, none for the shots), RGBA `COLOR_0` on every primitive, blended double-sided core-glTF spell materials and the opaque `shot`, the triangle ceiling, the frames (bolts and shots start at their tip and trail back along -Z, the arrow is 0.8 m long, the nova reaches 8 m and stays on the ground, the beam runs from 0 to 1, the blinks and holds rest on the ground and the holds stay at the feet, the grapple rope tiles from 0 to 1, the hook trails back to its eye 0.4 m behind the crown, and the ice-slip scrape lies on the ground from 0 to 1) and a byte-identical rebuild. It skips without Blender.

## Review

Review renders are in [`review/spell-effects/`](../review/spell-effects/): `game-camera.jpg` (the 12 m, 0.42 rad pitch, 50° Greyhaven camera with 1.8 m stand-in figures: bolts in flight, each school's impact on a target, a beam between two figures, heal motes and the shots), `close-up.jpg` (the four bolts and five impacts), `shots.jpg` (the arrow, crossbow bolt and knife) and `overview.jpg` (the frost nova from above, mid-burst). In the renders the beam and the motes keep the neutral `spell-energy` colour.

The #771 movement and control effects have `movement-game-camera.jpg` (the whole set at the game camera, 0.12 s into each clip: blink in, the leap slam, the dash trail and dust, the vine and ice holds and their ends, the ice-slip scrape and a grapple rope between two figures; blink out is just out of frame and the hook too small to judge there, so see the strips) and `movement-strips.jpg` (each effect at five moments of its clip, cropped from the same game camera at in-game pixel size; the leap slam and dash rows are in [`review/strike-effects/movement-strips.jpg`](../review/strike-effects/movement-strips.jpg)).

CI publishes the rolling `spell-effects` release when this merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). `releases/spell-effects.json` holds its budget (8 materials, 1 MB of texture memory, a 1 MB download).
