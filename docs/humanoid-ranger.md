# Ranger character bundle

This is the build recipe for the first clothed, skinned humanoid of [#110](https://github.com/moritzbrantner/asset-tooling/issues/110): the Quaternius **Male_Ranger** outfit ([Atlas Decision 1.1.3](decisions/atlas.md)) with the Universal Base Characters head, and the UAL1 `Idle_Loop` and `Walk_Loop` clips retargeted onto its rig. It follows the owner answers of 2026-10-17 on #110:

- The clips are retargeted with 3d-lab's `three_d_animation::retarget` and an explicit semantic bone map.
- The walk is in place.
- The conventions are metres, +Y up, facing +Z and the origin between the feet.
- The result is a `gltf-resources-v1` bundle ([asset-bundles.md](asset-bundles.md#gltf-resources-profile)), published as a versioned GitHub Release.
- Acceptance is structural checks, the #111 viewer snapshots and consumer smoke tests. There is no byte-exact replay and no Blender world-space oracle.

The source members are listed in [humanoid-sources.md](humanoid-sources.md).

## Versions

The recipe has two versions. `--version` selects one, and the default is 2.

- **v1 (#110):** the character with `Idle_Loop` and `Walk_Loop`. It is one entry with no attachments, and it stays reproducible with `--version 1`, which rebuilt the recorded v1 tar `4de4cc65…` byte for byte after the v2 change.
- **v2 ([#260](https://github.com/moritzbrantner/asset-tooling/issues/260), [#113](https://github.com/moritzbrantner/asset-tooling/issues/113)):** v2 supersedes v1 as the bundle to publish. It follows the owner answers on #113:
  - **Clips:** it adds the run gaits, a sword idle and attack, a death and a shield guard (see [Clips](#clips)).
  - **Sockets:** the [humanoid-sockets-v1](humanoid-sockets.md) descriptor ships as the `humanoid-sockets` attachment (`application/json`) of the character entry.
  - **Weapons:** the sword and shield from the [weapon recipes](weapon-recipes.md) are separate entries, `equipment.sword.arming/default` and `equipment.shield.heater/default`, which a consumer parents to the character at runtime.

## Build

```sh
git clone https://github.com/moritzbrantner/3d-lab <checkout>
git -C <checkout> checkout 86e5fe1dc6e564176de35723b31e217bf385b20a   # the stability/processors.json pin
cargo fetch --manifest-path <checkout>/examples/asset-tooling-animation-adapter/Cargo.toml
git lfs pull   # the humanoid members under assets/canonical/
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-ranger-character.ts --processor-checkout <absolute checkout> --out <directory> [--version 1|2]
```

Version 2 generates the weapons through `external.blender.script@1`, so it needs Blender 5.2.2. `ASSET_TOOLING_BLENDER` names it, otherwise `blender` on `PATH` is used. Blender installed as a snap can only read and write under `$HOME`, so set `TMPDIR` to a directory there. Version 1 needs no Blender.

[`scripts/build-ranger-character.ts`](../scripts/build-ranger-character.ts) is the maintained recipe. It needs no network after `cargo fetch`: the processor runs `cargo run --offline`. The processor checkout must be source-clean at the pinned commit. `Cargo.lock` and `target/` may be present, but nothing else may differ. Its identity (`git-clean-exact-head`, cargo/rustc versions and the probe) is part of the `animation.retarget@1` build identity. `<directory>` becomes the object-store root, which holds every intermediate AssetRef. The script prints the bundle directory, the tar path, the tar sha256 and the export ref, and writes `lineage.json` next to them with every intermediate AssetRef and the retarget observations.

| Step | Operation | Inputs and parameters |
| --- | --- | --- |
| 1 | `scene.import.gltf@2` | The Male_Ranger outfit, and the Superhero body with its two [declared substitutions](humanoid-sources.md#declared-substitution). |
| 2 | `scene.subset.skinned.gltf@1` | The body, cut down to its head and face with the [Ranger recipe](gltf-subset.md#ranger-character-recipe). |
| 3 | `scene.compose.skinned.gltf@1` | Skeleton = outfit, parts = the head subset. |
| 4 | `scene.extract.animation.gltf@1` | The composed GLB with `hipsJoint: "pelvis"`: the target rig only. |
| 5 | `scene.extract.animation.gltf@1` | Once per clip: the UAL1 GLB with `hipsJoint: "DEF-hips"`, or for `Idle_Shield_Loop` the UAL2 GLB with `hipsJoint: "pelvis"`. Each run yields the source rig and the clip. |
| 6 | `animation.retarget@1` | Each clip with its source rig and the target rig, its library's bone map below, `sampleRate: 30` and `rootMotion: "in-place"`. |
| 7 | `scene.embed.animation.gltf@1` | The composed GLB with every retargeted clip, under its source name, in the order of the clip table. |
| 8 (v2) | `external.blender.script@1`, then `scene.import.gltf@2` | The `sword.arming` and `shield.heater` presets of `adapters/blender/weapon.py`, generated into `<directory>/weapons/<piece>/` and imported. |
| 9 | `asset.bundle@4` | `gltf-resources-v1`: key `humanoid.ranger.male`, variant `default`. In v2 it also carries the `humanoid-sockets` attachment ([`assets/descriptors/humanoid.ranger.male.sockets.json`](../assets/descriptors/humanoid.ranger.male.sockets.json), validated against the rig's joints) and the two equipment entries. |
| 10 | `scripts/pack-asset-bundle.ts` | Packs `<directory>/bundle` into `<directory>/humanoid.ranger.male.tar` and its `.sha256`. |

Every step uses the `NODE_SKINNED_MESH_NON_ROOT` and `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` validator exceptions, the same ones the bundle profile fixes.

## Bone map

`animation.retarget@1` binds 3d-lab `HumanoidBone` ids to a joint name in each rig. The UAL1 rig is a 53-joint Rigify `DEF-*` skeleton. The UBC/Outfits rig has 65 joints in the Unreal style.

| HumanoidBone | UAL1 joint | UBC/Outfits joint |
| --- | --- | --- |
| `root` | `root` | `root` |
| `hips` | `DEF-hips` | `pelvis` |
| `spine` | `DEF-spine.001` | `spine_01` |
| `chest` | `DEF-spine.003` | `spine_03` |
| `neck` | `DEF-neck` | `neck_01` |
| `head` | `DEF-head` | `Head` |
| `left-shoulder` / `right-shoulder` | `DEF-shoulder.L` / `.R` | `clavicle_l` / `_r` |
| `left-upper-arm` / `right-upper-arm` | `DEF-upper_arm.L` / `.R` | `upperarm_l` / `_r` |
| `left-lower-arm` / `right-lower-arm` | `DEF-forearm.L` / `.R` | `lowerarm_l` / `_r` |
| `left-hand` / `right-hand` | `DEF-hand.L` / `.R` | `hand_l` / `_r` |
| `left-upper-leg` / `right-upper-leg` | `DEF-thigh.L` / `.R` | `thigh_l` / `_r` |
| `left-lower-leg` / `right-lower-leg` | `DEF-shin.L` / `.R` | `calf_l` / `_r` |
| `left-foot` / `right-foot` | `DEF-foot.L` / `.R` | `foot_l` / `_r` |
| `left-toes` / `right-toes` | `DEF-toe.L` / `.R` | `ball_l` / `_r` |

Several joints are not mapped: `spine_02`, the fingers and thumbs, and the `*_leaf` joints. They keep their rest pose, so the hands stay in their rest grip. Finger retargeting belongs to the broader library work in #115.

UAL2 uses the same 65-joint Unreal-style rig as UBC/Outfits. `RANGER_UBC_BONE_MAP` therefore binds the same 22 `HumanoidBone` ids to the same joint name on both sides, for example `hips` → `pelvis` / `pelvis`. Its rest pose is close to the Ranger's but not identical. The retarget transfers rotation deltas from each rig's own rest, so the difference does not leak into the result.

## Retargeting

Asset-tooling implements no part of the retargeting. Processor `three-d-animation-retarget` (3d-lab `86e5fe1`, contract in 3d-lab `docs/contracts/animation-processing.md`) does all of it:

- It samples the source clip at each sample time.
- It transfers each mapped bone's local rotation delta onto the target's rest pose.
- It scales hips and root translation by the ratio of the reference heights.
- With `in-place`, it removes the model-space horizontal part of that translation and keeps the vertical bob.

The reference height of each rig is its hips joint's model-space height at rest, taken through every ancestor (`scene.extract.animation.gltf@1`): 0.9167 m for UAL1 `DEF-hips`, 0.9167 m for UAL2 `pelvis` and 0.9491 m for UBC `pelvis`. The sample grid is `start + i/30` up to the clip's last key. The last sample is always exactly the clip's last key, never past it, so both loop endpoints are sampled. Output keys are written as LINEAR glTF samplers on the skin's joint nodes.

## Clips

Clip names are the source names. Every clip is in place. From the recorded v2 build:

| Clip | Source | Use | Duration | Samples | Channels | Keys |
| --- | --- | --- | --- | --- | --- | --- |
| `Idle_Loop` | UAL1 | idle (v1) | 2.5 s | 76 | 46 | 3,496 |
| `Walk_Loop` | UAL1 | walk (v1) | 1.333 s | 41 | 46 | 1,886 |
| `Jog_Fwd_Loop` | UAL1 | run, jog gait (#260) | 0.933 s | 29 | 46 | 1,334 |
| `Sprint_Loop` | UAL1 | run, sprint gait (#260) | 0.667 s | 21 | 46 | 966 |
| `Sword_Idle` | UAL1 | sword idle (#113) | 1.667 s | 51 | 46 | 2,346 |
| `Sword_Attack` | UAL1 | melee attack (#260, #113) | 1.533 s | 47 | 46 | 2,162 |
| `Death01` | UAL1 | death (#260) | 2.4 s | 73 | 46 | 3,358 |
| `Idle_Shield_Loop` | UAL2 | shield guard (#113) | 2.5 s | 76 | 46 | 3,496 |

Across the 22 mapped bones, each clip has 22 rotation channels, 2 translation channels (hips and root) and 22 scale channels. The scale channels appear because both libraries key scale on every mapped bone; for UAL1 the keyed scale stays within 4e-7 of 1. UAL1 also ships `Sword_Attack_RM`, a root-motion variant. The bundle takes the plain `Sword_Attack`, and `in-place` removes any remaining horizontal hips travel. `Death01` keeps its vertical drop, because in-place removes only horizontal motion.

## Conventions

The character keeps the Quaternius export's conventions; no transform is changed. The composed rest pose was checked against them:

- **Units and axes:** metres, +Y up.
- **Origin:** `root` is at the origin, and the feet are symmetric about x = 0. The ankles are at z = -0.09 and the balls of the feet at z = +0.06.
- **Facing:** +Z (the toes point to +Z) with the character's left at +X.
- **Height:** the pelvis is at 0.949 m and the head joint at 1.60 m.
- **Root motion:** every clip is in place. The pelvis's horizontal model-space position is constant over each clip; gameplay owns position and facing (mmorpg#39).

## Bundle and consumer pinning

The v2 bundle has three entries:

- **`humanoid.ranger.male` / `default`:** `scenes/humanoid.ranger.male/default.gltf` with one geometry/animation `.bin` and its 13 PNG textures as hash-addressed resources. It has 2 skins, 31,578 triangles and the eight clips above. Its `humanoid-sockets` attachment is the descriptor, byte for byte.
- **`equipment.sword.arming` / `default`:** 1,304 triangles, with nodes `grip` and `sword.arming`.
- **`equipment.shield.heater` / `default`:** 1,706 triangles, with nodes `grip` and `shield.heater`.

The weapons are unskinned and unanimated. A consumer parents an item's scene root under the socket joint with the socket's TRS ([humanoid-sockets.md](humanoid-sockets.md)). `manifest.json` records each embedded GLB's AssetRef as `source`, and `lineage.json` from the build links the character GLB back to the canonical members and lists the weapon and sockets AssetRefs. The v1 bundle has only the character entry, with the clips `Idle_Loop` and `Walk_Loop` and no attachment.

A consumer pins the three things described in [Release distribution and consumer pinning](asset-bundles.md#release-distribution-and-consumer-pinning):

1. the release tag;
2. the tar sha256;
3. its own copy of `export.ref.json`.

It then runs `bun scripts/pack-asset-bundle.ts --verify humanoid.ranger.male.tar --ref <pinned export.ref.json>` (or `verifyAssetBundle` after extracting). It loads the character with `readAssetBundleGltf(dir, manifest, "humanoid.ranger.male", "default")`, the weapons the same way, and the sockets with `readAssetBundleAttachment(dir, manifest, "humanoid.ranger.male", "default", "humanoid-sockets")`. Publishing the release (`gh release create`) is a separate, explicit step.

Two cold v1 builds on 2026-10-17 from separate object stores produced the same tar: sha256 `4de4cc65585a0709066843a9c0bf73315820024e360326c2f1bf86b4c7955c91`, 55,587,328 bytes, with manifest sha256 `72f79132d20dae5f9d17de2b32eb0d41543f8bd74db1c0c0b2d0a9afe4b386d7` (5,364 bytes). Two v2 builds on 2026-10-17 from separate object stores (Blender 5.2.2 snap) also produced the same tar: sha256 `ccb267e4c6e21dd8d98597784569d51732612a0a76f3c6b9c067d556b3f66167`, 56,005,120 bytes, with manifest sha256 `a1170d10db2a275e59bde2e243a5163d735d6b466fb8fa0e07434c0ccfaae90e` (8,525 bytes). These are records of those runs, not a byte-exact replay contract.

## Tests

- `bun test test/gltf-animation-operations.test.ts` uses hand-authored skinned fixtures. It covers the rig, the hips reference height through a non-joint armature, clip extraction on joint indices, skipping a non-joint channel, an extract → embed → extract round trip, and the rejection of existing or duplicate clip names and of out-of-range nodes.
- `bun test test/animation-retarget-operations.test.ts` runs a fixture adapter. It covers the name → index binding conversion, the `sampleRate` grid, output and observation checks, and parameter failures.
- `bun scripts/check-processor-contract.ts <checkout> <commit> moritzbrantner/3d-lab examples/asset-tooling-animation-adapter/Cargo.toml animation.retarget` runs the pinned processor on two tiny rigs, twice. This is also the hosted stability matrix entry.
- `test/humanoid-ranger.test.ts` always checks the v2 clip list and the UAL2 same-name bone map. It also runs the whole v2 recipe and checks the bundle structurally:
  - every clip name in order, each with a positive duration;
  - in place: the pelvis's horizontal model-space drift, with root and pelvis keys composed, is at most 1 cm;
  - only mapped joints are animated, with LINEAR samplers;
  - the two equipment entries are unskinned, unanimated and have a `grip` node;
  - the `humanoid-sockets` attachment matches the versioned descriptor byte for byte and validates against the 65 joints.

  The full run skips unless the Git LFS payloads are hydrated, `ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB` names the pinned checkout and `ASSET_TOOLING_BLENDER` names Blender 5.2.2.

## Visual check of the v2 clips

The socket sheets were rendered with the sword in `hand_r.weapon` and the shield in `hand_l.shield` at `Jog_Fwd_Loop` and `Sprint_Loop` (a quarter and the middle), `Sword_Idle` (the middle), `Sword_Attack` (30, 50 and 70 %), `Death01` (the middle and the end) and `Idle_Shield_Loop` (the middle). They show no inverted or twisted limbs and no root drift: the pelvis keeps its horizontal position in every clip. The gaits run in place, so the feet slide backwards by design; gameplay moves the character. Known limits:

- **Hands:** the fingers keep their open rest pose (#115), so the sword lies across an open hand in every clip.
- **Sword angle:** the `hand_r.weapon` socket was authored for a hanging arm. In `Sword_Idle` the blade points sideways at hip height rather than forward, and in `Sword_Attack` it follows the extended arm.
- **Shield guard:** `hand_l.shield` aligns the shield's vertical axis with the forearm. In `Idle_Shield_Loop` the forearm is held across the body, so the shield sits on its side with the point toward the character's left instead of down.
- **Death:** at the end of `Death01` the character lies on its back with the pelvis joint 6.5 cm above the ground, and the right hand's fingertip joints sink up to 9 cm below it. The likely cause is the Ranger's longer arms and the hips-height scaling.

## Not covered here

These remain open on #110 and its consumers:

- the #111 viewer snapshot set at rest, idle and walk. The v2 clips were checked with the Blender socket sheets instead (`examples/weapons/socket-sheets.py --poses=…`), with the findings below;
- the source-versus-runtime pose comparisons;
- the consumer smoke tests in mmorpg#210 and arpg;
- publishing the GitHub Release.
