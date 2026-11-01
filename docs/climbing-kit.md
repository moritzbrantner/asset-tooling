# Climbing kit

The climbing kit ([#394](https://github.com/moritzbrantner/asset-tooling/issues/394), consumer mmorpg#490) dresses the MMORPG's climbable surfaces: timber ladders, a knotted hanging rope and climbing ivy. It is a reproducible procedural Blender recipe, [`adapters/blender/climbing.py`](../adapters/blender/climbing.py), with a descriptor and a `gltf-resources-v1` bundle in one rolling release, `climbing-kit` (Atlas Decision 7.1.5), never a numbered one.

The parts are sized to the Ranger's traversal clips ([Traversal clips](humanoid-ranger.md#traversal-clips-416), `adapters/blender/traversal_clips.py`):

- `Ladder_*`: rungs every 0.30 m (`rungSpacingMeters`), the rung plane 0.36 m in front of the pelvis, the hands wrapping rungs 0.19 m either side of the centre, the balls of both feet on the rung 0.6 m below the pelvis.
- `Rope_*`: a vertical rope 0.30 m in front of the pelvis, gripped by fists whose wrists sit about 5 cm beside and 4.5 cm behind its axis.
- `Climb_*`: a face 0.36 m in front of the pelvis. The ivy covers such a face; the climber holds the face beneath it.

Gameplay owns the collision (`StaticCollider`, `Grip`). The parts are presentation; their box `collisionProxies` serve consumers without colliders.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-climbing-kit.ts --out <directory>
```

[`scripts/build-climbing-kit.ts`](../scripts/build-climbing-kit.ts) runs one `external.blender.script@1` job per part and level (15 parts × 3 levels), imports each GLB through `scene.import.gltf@2` with no validator exceptions, writes the descriptor from the recipe's observations and the measured bounds, and packs a `gltf-resources-v1` bundle to `<directory>/climbing.kit.tar` with `lineage.json`, `descriptor.json` and `export.ref.json`. It needs the hydrated ivy-leaf payload (`git lfs pull --include="assets/canonical/quaternius.medieval-village-megakit-standard.t-vineleaf-png-png/**"`) and takes about six minutes. Snap Blender reads and writes only under `$HOME`, so set `TMPDIR` there.

`climbing.build(part, lod, collection, leaves, location)` also runs in a live Blender session once `climbing.use_common(runpy.run_path("adapters/blender/kit_common.py"))` has bound the shared helpers.

## Materials

- **Wood** (rails, rungs, the beam): weathered pine generated with numpy, grain along each piece, 0.6 m per tile, colour, normal and AO/roughness maps at 512 px. Each rail and rung gets its own tint, darker and greener in the bottom 0.6 m.
- **Rope:** three-strand hemp generated with numpy: the strands' lay turns once per 0.15 m of rope, so stacked pieces continue it.
- **Ivy:** the CC0 Quaternius Medieval Village MegaKit `T_VineLeaf` ivy-leaf cluster (catalog source `quaternius.medieval-village-megakit-standard.t-vineleaf-png-png`), turned into a bright grey mask like the bushes' leaves (#462). Each card is an alpha-`MASK` quad whose colour comes from `COLOR_0`: deep green near the face and low down, mid green, a sunnier green on outward and upward cards, yellow-green on young tips. Card normals bend towards the face normal, so the cover shades softly. The stems use a numpy ivy-bark texture.
- **Iron** (nails, the ring, the eye bolt, straps): a dark metallic factor.

Every material is multiplied by `COLOR_0`, as a glTF viewer does.

## Parts

Each part's frame: metres, +Y up, right-handed. Its back (z = 0) lies on the face it climbs, and its origin is on the ground (or the joint) at the centre of that back. The climber faces it from +Z. Each part carries two empty nodes, `climb.bottom` and `climb.top`, at the ends of its grip line.

| Key | Triangles (LOD0 / lod1 / lod2) | Footprint W × D × H (m) | Notes |
| --- | --- | --- | --- |
| `climbing.kit.ladder-3m` | 628 / 132 / 96 | 0.600 × 0.100 × 3.000 | 9 rungs from 0.3 m |
| `climbing.kit.ladder-6m` | 1,228 / 252 / 176 | 0.600 × 0.100 × 6.000 | 19 rungs from 0.3 m |
| `climbing.kit.ladder-9m` | 1,828 / 372 / 256 | 0.600 × 0.100 × 9.000 | 29 rungs from 0.3 m |
| `climbing.kit.ladder-section` | 296 / 72 / 56 | 0.600 × 0.100 × 1.200 | 4 rungs from 0.15 m, tiles every 1.2 m |
| `climbing.kit.ladder-top` | 528 / 160 / 104 | 0.600 × 0.100 × 1.340 | 2 rungs from 0.15 m, hooks over a parapet at 1.0 m |
| `climbing.kit.rope-4m` | 2,508 / 978 / 254 | 0.160 × 0.440 × 4.000 | 6 knots, beam and ring |
| `climbing.kit.rope-8m` | 4,328 / 1,590 / 366 | 0.160 × 0.440 × 8.000 | 12 knots, beam and ring |
| `climbing.kit.rope-12m` | 6,208 / 2,250 / 470 | 0.160 × 0.440 × 12.000 | 19 knots, beam and ring |
| `climbing.kit.rope-section` | 560 / 192 / 32 | 0.092 × 0.440 × 1.200 | 2 knots, tiles every 1.2 m |
| `climbing.kit.rope-anchor` | 724 / 310 / 150 | 0.160 × 0.440 × 0.425 | beam and ring above the joint |
| `climbing.kit.rope-end` | 384 / 188 / 24 | 0.092 × 0.440 × 0.600 | stopper knot, frayed tail |
| `climbing.kit.vine-strip` | 2,568 / 1,038 / 296 | 1.000 × 0.140 × 2.000 | tiles every 2 m |
| `climbing.kit.vine-top` | 1,088 / 436 / 124 | 1.000 × 0.140 × 1.000 | ragged top |
| `climbing.kit.vine-3m` | 3,092 / 1,206 / 344 | 1.000 × 0.140 × 3.000 | rooted cover |
| `climbing.kit.vine-6m` | 7,158 / 2,736 / 800 | 1.000 × 0.140 × 6.000 | rooted cover |

The footprint is the part's nominal box; `bounds` in the descriptor is measured and includes overhangs (the ivy cards, the ladder-top hooks behind the face). The release tar is about 6.3 MB.

- **Ladders.** Two chamfered rails, 65 × 90 mm, 0.6 m wide over all and 0.1 m deep, with round rungs 38 mm thick through both rails. At LOD0 the rungs' tenon ends show 1 cm past the rails and an iron wedge nail holds each. The whole ladders stand on the ground with the first rung at 0.3 m and the rails running 0.3 m past the last rung, capped with an iron band. `ladder-section` is a 1.2 m tile with rungs at 0.15, 0.45, 0.75 and 1.05 m, so stacked sections keep the 0.30 m pitch. `ladder-top` continues a section with two rungs, then its rails rise past a parapet whose top is at 1.0 m and hook back over it (towards −Z) and down 0.25 m behind the face. Place it so that y = 1.0 is the parapet top.
- **Ropes.** A 50 mm rope, its axis 0.30 m in front of the face, with a knot (a 92 mm bulge) every 0.6 m on the grid 0.3 + 0.6k. The anchor is a 16 cm timber beam stub out of the face with an iron strap, an eye bolt and a 15 cm iron ring; the rope loops over the ring's lower wire and its tail is whipped to the standing part. The bottom is a stopper knot over a whipped, frayed tail. The whole ropes reach their nominal length at the top of the beam. `rope-end` (up to y = 0.6), `rope-section` (1.2 m) and `rope-anchor` (from the joint at y = 0) stack in that order.
- **Vines.** Four woody main stems wander up a 1 m wide strip with side shoots, covered by overlapping leaf cards 0.2–0.3 m across, mostly facing out of the face and hanging tip-down, 2.5–10 cm proud of it. `vine-strip` is a 2 m tile: its stems and cards repeat with that period, so stacked strips have no seam (cards near a strip's ends overhang into the next one, which is part of the pattern). `vine-top` is the strip's ragged upper end: the stems end between 0.55 and 0.95 m and the young tips turn yellow-green. `vine-3m` and `vine-6m` are whole covers whose stems spring from a root clump on the ground.

## Descriptor

The `climbing-kit-descriptor-v1` attachment hangs on `climbing.kit.ladder-3m/default`:

- top level: `units`, `up`, `facing`, `handedness`, `origin` (`back-base-center`), `placement`, `rungSpacing` (0.3), `lodSelection` and `assets`;
- each asset: `key`, `role`, `family` (`ladder`, `rope`, `vine`), `triangles`, `footprint`, `bounds`, `collisionProxies` (boxes `{name, tag, center, size}`; `tag` is `climbable` for the grip volume and `solid` for the rope's beam), `climb` and `lods`;
- `climb`: `grip` (`ladder`, `rope` or `face`), `clips` (`Ladder_*`, `Rope_*`, `Climb_*`), `approach` (`+Z`), `standOff` (the clips' distance from the grip plane or axis to the pelvis), `gripLine` (`from`, `to`: the rung centre line, the rope axis, or the face's centre line), and per family:
  - ladders: `rungs` (`spacing`, `first`, `count`, `radius`, `span` between the rails, `z` of the rung plane); `ladder-section` adds `tile` (`axis`, `pitch` 1.2); `ladder-top` adds `topOut` (`parapetTop`, `hooks`);
  - ropes: `radius` (0.025) and `knots` (heights); `rope-section` adds `tile`; `rope-anchor` and `rope-end` add `joins`;
  - vines: `face` (`normal`, `z`, `width`) and a `note`: a vine is a cover, so mmorpg climbs the face beneath it with its own `Grip::Rock` or `Grip::Timber`; `vine-strip` adds `tile` (pitch 2), `vine-top` adds `joins`.

### Attaching the clips

- **Ladder:** put the rung plane (`z` of `rungs`) 0.36 m in front of the pelvis and slide the character so its hand rungs land on the grid. In the authored clips (clip root at the origin), the hands hold rungs at root-relative heights 0.248 + 0.3k m, so a ladder whose rungs are at `first + 0.3k` in world space wants the clip root at a height ≡ `first − 0.248` (mod 0.3). The `Ladder_*` `contacts` give each plant exactly.
- **Rope:** put the rope axis (`gripLine`) 0.30 m in front of the pelvis, on the character's centre line. Any height works; knots may pass through a fist.
- **Vine:** climb the face as any `Climb_*` face; the cover is 0.14 m deep at most, inside the clips' 0.36 m stand-off.

## Levels of detail

Every part ships `default` (LOD0), `lod1` and `lod2` as bundle variants in the same frame, built by the same recipe at `lod` 1 and 2 (the fortress kit's approach), and the descriptor carries the greyhaven-nature [#449 LOD metadata](greyhaven-nature-bundle.md#lod-metadata): `lodSelection` plus per asset `lods: { boundingSphere, levels: [{ variant, triangles, minScreenSize, referenceMaxDistance }] }`.

- **Ladders:** `lod1` square rails, six-sided rungs without caps, nails or bands; `lod2` four-sided rungs.
- **Ropes:** fewer sides (10, 6, 4) and rings (every 6, 15, 30 cm; knots keep their flank rings until `lod2`), a coarser ring; `lod2` drops the fray, strap and whipping.
- **Vines:** like the bush `thin` level: `lod1` keeps a seeded 40 % of the cards grown by 0.85/√0.4, `lod2` 14 % grown by 0.78/√0.14, flat at 5 cm off the face; `lod2` drops the side shoots and root clump; stems lose sides.

Switch points are distances per family (`CLIMBING_LOD_DISTANCES`: ladders 15 m and 45 m, ropes 12 m and 35 m, vines 20 m and 60 m at a 60° vertical FOV). Each part's `minScreenSize` follows from its own bounding sphere, so a 1.2 m section and a 9 m ladder switch at the same distance.

## Review

Reviewed in the live Blender (`blender-2`) with the male Ranger (`outfit.class.ranger`, untextured: the release's KTX2 textures don't import) driven by the release's `Ladder_Idle_Loop`, `Ladder_Up_Loop`, `Rope_Idle_Loop` and `Rope_Up_Loop` through copy-transform constraints, against a face with the kit placed as above. Renders: `~/.cache/agent-work/persist-2026-10-30/at394-*.png`.

- **Ladder:** the fingers close over the rungs and the balls of both feet stand on the rung 0.6 m below the pelvis. The wrists sit about 3.6 cm further from the rung plane than the clip's target (the clip's arm IK falls a little short), which reads as a firm grip from the side.
- **Rope:** both fists close round the 50 mm rope and the feet clamp it.
- **Ivy:** reads as a green climbing route against grey rock from 20 m. Stacked strips show no seam.

Known gaps: the knots are smooth bulges, not tied-knot geometry; the ivy has one leaf shape and no seasonal variant; a vine cover doesn't wrap round a face's edge.
