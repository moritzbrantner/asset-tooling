# Greyhaven mounts

The `mounts` rolling release supplies a tacked riding horse for mmorpg's mounts (mmorpg#298), ready ahead of them ([#769](https://github.com/moritzbrantner/asset-tooling/issues/769)). Its rider is the Ranger: the [riding clips](humanoid-ranger.md#riding-clips-769) ship with the figures in their `ride` family. Wolf mounts and mounted combat wait for #298's acquisition and roster answers. The game owns spawning, mounting rules, steering, travel, collision and everything else about behaviour.

| Key (variant `default`) | Source | Catalog source | Size in metres (W × H × D, at rest) | Triangles | Joints |
| --- | --- | --- | --- | --- | --- |
| `greyhaven.mount.horse` | Quaternius *Ultimate Animated Animals*, `Horse.glb` (CC0-1.0), the farm horse's source; tack and clips original | `quaternius.ultimate-animated-animals-horse-glb` | 0.85 × 2.05 × 2.41 | 6,074 | 50 |

The numbers are from the build of 2026-11-19; the descriptor carries each build's measurements. The packed tar is about 2 MB.

## The horse

- **Size.** 2.05 m at the ears, about 1.55 m at the withers: a riding horse that carries the 1.84 m male Ranger with his head near 2.4 m.
- **Tack** in Greyhaven colours: a slate-blue saddle blanket with an ochre band, a brown saddle with pommel, cantle and flaps, a girth, stirrup leathers and dark iron stirrups, a bridle (crown piece, browband, cheek pieces, noseband and bit rings) and reins. The blanket and saddle are shrink-wrapped onto the horse at rest. The tack is one mesh skinned to the horse: the saddle, girth and stirrups ride `Torso2`, the bridle `Head`, and the reins follow the neck bone beside them from the bit to the hands. Five factor-only materials (`Greyhaven_Tack_*`) beside the source's own.
- **Sockets**, all on `Torso2`, so they move together with the saddle. Each is `{id, joint, translation, rotation}` in the joint's frame (as the Ranger's sockets), plus `restAt`, the point in the root frame at rest. A child at the socket has +X the horse's left, +Y up and +Z ahead (the **seat frame**). The joint frame is scaled about 42 times, so the translations are small numbers.

| Socket | Seat frame (m) | What sits there |
| --- | --- | --- |
| `saddle.seat` | 0, 0, 0 (1.604 m above the ground) | the rider's root; its pelvis joint sits here, 9 cm over the middle of the seat |
| `reins.l` / `reins.r` | ±0.08, 0.06, 0.34 | the rider's fists on the reins, just above the withers |
| `stirrup.l` / `stirrup.r` | ±0.38, −0.73, 0.12 | the stirrup treads, under the balls of the rider's feet |

[`src/mounts.ts`](../src/mounts.ts) holds these points, the seat height and the gait timing; the horse recipe and the ride clips both read them.

## Clips

In place, 30 fps. The recipe places every hoof and solves the legs with two-bone IK (the fore cannon and forearm from the elbow, the hind femur and tibia to the hock over a tilted cannon), so a planted hoof slides back at exactly the gait's speed: it stays still once the game moves the horse at that speed. Each gait records its `speedMetersPerSecond`, `strideMeters`, `strideSeconds`, `footfalls` (each hoof's touchdown and lift-off as stride fractions; phase 0 is the left hind's touchdown) and `hoofSlideMeters` (the worst planted slide with the speed added back).

| Clip | Length | Speed | Footfalls | Notes |
| --- | --- | --- | --- | --- |
| `Ride_Idle_Loop` | 4 s loop | — | square | breathing, a weight shift, an ear flick, a head bob and a tail swish |
| `Walk_Loop` | 1.1 s loop | 1.5 m/s | LH 0, LF 0.25, RH 0.5, RF 0.75 | lateral four-beat; the head nods twice a stride; slide 8 mm |
| `Trot_Loop` | 0.733 s loop | 3.4 m/s | LH + RF 0, RH + LF 0.5 | diagonal two-beat with a suspension; the back bounces twice a stride |
| `Canter_Loop` | 0.6 s loop | 5.0 m/s | LH 0, RH + LF 0.28, RF 0.52 | right-lead three-beat, rocking, then a suspension |
| `Gallop_Loop` | 0.467 s loop | 8.0 m/s | LH 0, RH 0.11, LF 0.36, RF 0.48 | right-lead transverse four-beat; the neck pumps; a suspension |
| `Turn_L` / `Turn_R` | 2.4 s | — | — | 90° on the haunches, the forehand stepping round; ends turned (`turnDegrees` ±90, the game applies the yaw) |
| `Rear` | 2.6 s | — | — | spooked: the hindquarters drop, the forehand rises 42° on the hind hooves with the forelegs tucked and pawing (`riseSeconds` 0.99), and lands where it stood (`landSeconds` 2.13) |
| `Halt` | 1.1 s | — | — | from `Walk_Loop`'s first frame to `Ride_Idle_Loop`'s, slowing over one stride; `travelMeters` 0.825 is the distance it stands for |

## Build

```sh
git lfs pull --include="assets/canonical/quaternius.ultimate-animated-animals-horse-glb/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-mounts.ts --out .artifacts/mounts
```

[`scripts/build-mounts.ts`](../scripts/build-mounts.ts) imports the pinned payload from canonical storage (offline, hash-verified), runs [`adapters/blender/mounts.py`](../adapters/blender/mounts.py) through `external.blender.script@1`, checks the GLB with `scene.import.gltf@2`, expresses the sockets in their joint's frame and exports a `gltf-resources-v1` bundle. It writes `greyhaven.mounts.tar`, `export.ref.json`, `greyhaven.mounts.descriptor.json` and `lineage.json`. A rebuild packs the same tar bytes.

## Descriptor `greyhaven-mounts-descriptor-v1`

Attached as `mounts-descriptor` to `greyhaven.mount.horse/default` and written beside the tar: the conventions (metres, +Y up, facing +Z, the origin at the centre of the footprint on the ground), the clip names, and for the horse its `restBounds`, `size`, `triangles`, `joints`, `sockets`, `seat` (the socket, its height, the frame and the tack's seat-frame points), each clip's length, loop flag and measurements, the `rider` (the Ranger's `ride` family and the horse clip each rider clip plays with) and provenance.

## Release

CI publishes the rolling `mounts` release when the recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). `releases/mounts.json` holds its budget. `test/blender/mounts/` builds the real bundle and checks the key, one skin and the clips, the grounded and centred bounds, the height, the seat height the ride clips assume, the sockets against the tack points, each gait's speed, planted hooves and footfall order, the turns, provenance and a byte-identical replay. It skips without Blender or with an unhydrated source.

The review sheets, rendered from both recipes with the published Rangers, are in [`review/mounts-769/`](../review/mounts-769/README.md).
