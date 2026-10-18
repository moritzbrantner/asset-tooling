# Ranger character bundle

This is the build recipe for the first clothed, skinned humanoid of [#110](https://github.com/moritzbrantner/asset-tooling/issues/110): the Quaternius **Male_Ranger** outfit ([Atlas Decision 1.1.3](decisions/atlas.md)) with the Universal Base Characters head, and the UAL1 `Idle_Loop` and `Walk_Loop` clips retargeted onto its rig. It follows the owner answers of 2026-10-17 on #110:

- The clips are retargeted with 3d-lab's `three_d_animation::retarget` and an explicit semantic bone map.
- The walk is in place.
- The conventions are metres, +Y up, facing +Z and the origin between the feet.
- The result is a `gltf-resources-v1` bundle ([asset-bundles.md](asset-bundles.md#gltf-resources-profile)), published as a versioned GitHub Release.
- Acceptance is structural checks, the #111 viewer snapshots and consumer smoke tests. There is no byte-exact replay and no Blender world-space oracle.

The source members are listed in [humanoid-sources.md](humanoid-sources.md).

## Versions

The recipe has eleven versions. `--version` selects one, and the default is 11.

- **v1 (#110):** the character with `Idle_Loop` and `Walk_Loop`. It is one entry with no attachments, and it stays reproducible with `--version 1`, which rebuilt the recorded v1 tar `4de4cc65…` byte for byte after the v2 change.
- **v2 ([#260](https://github.com/moritzbrantner/asset-tooling/issues/260), [#113](https://github.com/moritzbrantner/asset-tooling/issues/113)):** v2 supersedes v1 as the bundle to publish. It follows the owner answers on #113:
  - **Clips:** it adds the run gaits, a sword idle and attack, a death and a shield guard (see [Clips](#clips)).
  - **Sockets:** the [humanoid-sockets-v1](humanoid-sockets.md) descriptor ships as the `humanoid-sockets` attachment (`application/json`) of the character entry.
  - **Weapons:** the sword and shield from the [weapon recipes](weapon-recipes.md) are separate entries, `equipment.sword.arming/default` and `equipment.shield.heater/default`, which a consumer parents to the character at runtime.

  It stays reproducible with `--version 2`, which rebuilt the recorded v2 tar `ccb267e4…` byte for byte after the v3 change.
- **v3 ([#257](https://github.com/moritzbrantner/asset-tooling/issues/257)):** v3 is v2 with game-resolution textures for browser delivery. It superseded v2 as the bundle to publish. See [Textures](#textures). v2 and v3 ship the hanging-arm sockets descriptor [`humanoid.ranger.male.sockets.bundle-v2.json`](../assets/descriptors/humanoid.ranger.male.sockets.bundle-v2.json). That file is kept byte for byte, so `--version 2` and `--version 3` still build the recorded tars.
- **v4 ([#113](https://github.com/moritzbrantner/asset-tooling/issues/113)):** v4 is v3 with the anatomically derived hand sockets ([humanoid-sockets.md](humanoid-sockets.md#how-the-hand-sockets-are-derived)), which hold up in the combat clips. It supersedes v3 as the bundle to publish. The character `.gltf`, its resources and the two equipment entries are byte-identical to v3. Only the `humanoid-sockets` attachment and the manifest change.
- **v5 ([#268](https://github.com/moritzbrantner/asset-tooling/issues/268)):** v5 is v4 with every clip retargeted through all three spine joints. 3d-lab `4e69c0f` adds the optional `upper-chest` `HumanoidBone` between `chest` and `neck`, and the v5 bone maps bind `DEF-spine.002` → `spine_02` as `chest` and `DEF-spine.003` → `spine_03` as `upper-chest` ([Bone map](#bone-map)). This removes most of the chest error described in [Death01 ground penetration](#death01-ground-penetration). It supersedes v4 as the bundle to publish. Only the character `.gltf`, its geometry/animation `.bin` and the manifest change. The textures, the `humanoid-sockets` attachment (the v4 descriptor) and the two equipment entries are byte-identical to v4.

- **v6 ([#112](https://github.com/moritzbrantner/asset-tooling/issues/112)):** v6 is v5 with 11 traversal clips and a second attachment of the character entry. It supersedes v5 as the bundle to publish.
  - **Clips:** UAL1 `Jump_Start`, `Jump_Loop`, `Jump_Land`, `Crouch_Idle_Loop`, `Crouch_Fwd_Loop`, `Roll` and `Roll_RM`, and UAL2 `ClimbUp_1m_RM`, `Slide_Start`, `Slide_Loop` and `Slide_Exit`, after the eight v2 clips and retargeted the same way (see [Clips](#clips)).
  - **Clip motion:** the `humanoid-clips` attachment (`application/json`) describes every clip (see [Clip motion](#clip-motion)).
  - **Not included:** the free Standard libraries have no backward, strafe, start/stop or turn-in-place clips. Those stay open on #112 (owner answer, 2026-10-17); paid library tiers are out of scope (Decision 6.1.4).

  The textures, the `humanoid-sockets` attachment and the two equipment entries are byte-identical to v5. After the v6 change, `--version 5` rebuilt the recorded v5 tar `059f9276…` byte for byte.

- **v7 ([#113](https://github.com/moritzbrantner/asset-tooling/issues/113), [#114](https://github.com/moritzbrantner/asset-tooling/issues/114)):** v7 is v6 with the archery gear and the combat clips. It supersedes v6 as the bundle to publish.
  - **Equipment:** three more entries from the [archery recipes](weapon-recipes.md#archery): `equipment.bow.long` (skinned to `grip` and `nock`), `equipment.arrow` and `equipment.quiver.back`.
  - **Sockets:** the `humanoid-sockets` attachment is the v7 descriptor with the [archery sockets](humanoid-sockets.md#archery-sockets-bundle-v7).
  - **Clips:** 16 more clips. The sword, counter, heavy and shield clips are the owner's picks on #114 after preview. Every combat clip gets a `role` in `humanoid-clips`, and strikes also get a `contact` (see [Clip motion](#clip-motion)). Bow draw and release clips are split out, because the free libraries have none.

  The character's textures and the sword and shield entries are byte-identical to v6. After the v7 change, `--version 6` rebuilt the recorded v6 tar `9f5d625c…` byte for byte.

- **v8 ([#112](https://github.com/moritzbrantner/asset-tooling/issues/112)):** v8 is v7 with eight walk-speed clips from Mixamo (Atlas Decision 6.1.6), for both figures. It supersedes v7 as the bundle to publish.
  - **Clips:** `Walk_Bwd_Loop`, `Walk_Strafe_Left_Loop`, `Walk_Strafe_Right_Loop`, `Walk_Start`, `Walk_Stop`, `Turn_Left`, `Turn_Right` and `Hit_Shove_Spin` (role `hit.shove`), from the Mixamo titles in `RANGER_V8_CLIPS`.
  - **Mixamo retarget (owner answer #112.Q6):** `animation.retarget@1` transfers rotations in each joint's local frame, and Mixamo bones don't share the Ranger's joint axes. So [`adapters/blender/mixamo_clip.py`](../adapters/blender/mixamo_clip.py) retargets in Blender instead:
    - it imports the composed Ranger with the round-trip bone heuristic;
    - each mapped joint copies its Mixamo bone's world-space rotation, offset by the rest-pose difference (constraints, then a visual-keying bake);
    - the pelvis keeps only the source hips' vertical motion, scaled by the hips heights.
    
    The build extracts the clip, re-indexes it to the character's joint order and embeds it like the other clips.
  - **Root motion:** every clip is in place. Turns keep their rotation (owner answer Q2), so the body ends a turn rotated 90°. The removed horizontal travel is `sourceRootDisplacement`, and from v8 its speed is `sourceRootSpeedMetersPerSecond`: walk backwards 1.031, strafes 1.576, start 0.616, stop 0.306 and shove 0.444 m/s.
  - **Inputs:** `--mixamo-dir <dir>` names the author's local Mixamo downloads ("Without Skin" FBX, 30 fps, Y Bot), one `<title>.fbx` per clip. Raw Mixamo files never enter git, the catalog or a release; `humanoid-clips` records only the provider, title, FBX SHA-256 and the license note `RANGER_MIXAMO_LICENSE`. Versions 1–7 need no Mixamo files.
  - **Jog-speed backward and strafe clips:** these are authored originally in v11 instead of taken from Mixamo (Atlas Decision 6.1.7).

- **v9 ([#116](https://github.com/moritzbrantner/asset-tooling/issues/116)):** v9 is v8 with appearance variants, following the owner answers of 2026-10-17. It supersedes v8 as the bundle to publish.
  - **Skins:** the character entry's `default` variant is the Dark skin. A `skin.light` variant re-imports the body and outfit with the Light base colours bound to their URIs, and keeps the same geometry, clips and `.bin`.
    - The outfit's own skin texture (`T_Regular_*_Dark_BaseColor.png`) has no Light original, so its Light version is **derived** (answer Q13 = A). It applies a per-channel mean and standard-deviation colour transfer from the body's Dark to Light base colour, over opaque pixels in 8-bit sRGB, encoded with `image.encode.png@1`.
    - The transfer statistics and all four hashes are recorded under `skins[1].derived` in the appearance descriptor.
  - **Hair:** static items, `hair.buzzed`, `hair.simple-parted` and `hair.long` (male) and `hair.long` and `hair.buns` (female), from the pack's "Origin at 0" hairstyles.
    - Each has the variants `hair-1` and `hair-2`, the pack's two hair textures.
    - They attach to the new `head.hair` socket: the inverse of the `Head` joint's rest transform, so the hair sits where it was modelled.
    - The pack's hair textures are near-grey, so hair is meant to be tinted.
  - **Tints:** `tint.black`, `tint.brown` and `tint.blond` (linear RGB 0.02/0.02/0.02, 0.18/0.09/0.04 and 0.62/0.48/0.25) are base-colour factors applied on top of `hair-1`, to the hair materials and to the body's eyebrows (`eyebrows.followsHairTint`).
  - **Hood:** the `outfit.hood` part names the hood mesh node (`Male_Ranger_Head_Hood` / `Female_Ranger_Head_Hood`). A consumer hides it to show hair, and hair entries declare `requires: {"outfit.hood": false}` (answer Q14 = A).
  - **Descriptor:** the `humanoid-appearance` attachment (`humanoid-appearance-v1`) of the character entry lists the skins, parts, hair entries and their sockets and texture variants, the tints and the eyebrow materials.

- **v10 ([#117](https://github.com/moritzbrantner/asset-tooling/issues/117)):** v10 is v9 with the soldier and knight outfits ([armor-recipes.md](armor-recipes.md)). It is male-only for now (owner answer Q8); build the female figure with `--version 9`.
  - **Outfit variants:** the character entry gains `outfit.soldier` and `outfit.knight`. Each is the Peasant outfit (minus the base nodes its garments hide), the head subset and the kit's skinned garments, with the same skeleton and clips as `default`. Both use the Dark skin.
  - **Armour entries:** `armor.soldier` and `armor.knight` are static GLBs with one node per rigid piece. Each node rides its joint's `<joint>.armor` socket, which the sockets descriptor now declares ([humanoid-sockets.md](humanoid-sockets.md#armour-sockets-bundle-v10)).
  - **Descriptor:** `humanoid-appearance` gains `outfits`: `outfit.archer` (the `default` variant), `outfit.soldier` and `outfit.knight`, each with its variant, armour pieces and sockets, garments, hidden base nodes and faction slot.
  - Under Decision 7.1.4 this is the replaceable current candidate for review, not a published release.

- **v11 ([#112](https://github.com/moritzbrantner/asset-tooling/issues/112), owner answer 2026-10-18):** v11 is v10 with three original jog-speed clips. [`adapters/blender/jog_clips.py`](../adapters/blender/jog_clips.py) authors them in Blender on the animated Ranger. No Mixamo data is used; Mixamo clips were watched only as motion reference (Atlas Decision 6.1.7).
  - **`Jog_Bwd_Loop`:** the CC0 UAL1 `Jog_Fwd_Loop` played backwards, with the lowest spine joint pitched 18° back so the torso leans away from the travel direction. `humanoid-clips` records its ground speed like the forward gaits.
  - **`Jog_Strafe_Left_Loop` / `Jog_Strafe_Right_Loop`:** an authored side-gallop with a 0.5 s cycle at a reference speed of 1.4 m/s (`sourceRootSpeedMetersPerSecond`).
    - **Feet:** each foot follows an explicit in-place trajectory. A planted foot slides against the travel direction at the reference speed. The lead foot swings out, then the trail foot swings in and lands 12 cm short of it, so the legs never cross.
    - **Legs:** a two-bone solve keeps the knees forward and the feet level.
    - **Pelvis:** it bobs and drops as far as the spread legs need.
    - **Upper body:** it keeps the jog's mean posture, with the arm and spine swing damped to 45 % and rolled 6° into the travel direction.
  - The clips are added after the v8 clips, for both figures. The soldier and knight variants get them too. Under Decision 7.1.4 they are the current candidates for review.

v1–v4 keep their two-bone spine map. The processor treats an unmapped `upper-chest` exactly as before, so the new pin rebuilds them unchanged: after the v5 change, `--version 1` and `--version 4` rebuilt the recorded tars `4de4cc65…` and `222f21f8…` byte for byte at `4e69c0f`. No older processor checkout is needed.

## Female Ranger

`--figure female` (#115, owner answer Q1 = A) builds `humanoid.ranger.female` with the same recipe from v7 on. It uses the Universal Base Characters `Superhero_Female_FullBody` head (`keepMeshes: ["Eyebrows", "Eyes"]`) on the full `Female_Ranger` outfit ([humanoid-sources.md](humanoid-sources.md#female-body-and-outfit-115)).

Both figures share the 65-joint rig, so the female Ranger gets the same bone maps, clips (35 in v7), equipment entries and `humanoid-clips` metadata. Its hips reference height is measured on its own rig. This is the second real humanoid performing the same clip set through the shared operation path.

Its sockets are derived from the Female_Ranger rig into [`humanoid.ranger.female.sockets.json`](../assets/descriptors/humanoid.ranger.female.sockets.json) (`bun examples/weapons/derive-sockets.ts --rig <Female_Ranger.gltf> --out <file> --character humanoid.ranger.female`). They have the same ids as the male sockets, and the stowed sockets keep the male joint-frame values.

The character entry has 2 skins and 32,234 triangles. The tar is published as the `humanoid-ranger-female-v7` release, with socket sheets for `Sword_Idle`, `Sword_Regular_C`, `Walk_Loop` and a stowed idle.

## Build

```sh
git clone https://github.com/moritzbrantner/3d-lab <checkout>
git -C <checkout> checkout 4e69c0f64177d3babdf0ea991a631c62f577e684   # the stability/processors.json pin
cargo fetch --manifest-path <checkout>/examples/asset-tooling-animation-adapter/Cargo.toml
git lfs pull   # the humanoid members under assets/canonical/
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-ranger-character.ts --processor-checkout <absolute checkout> --out <directory> [--version 1|2|3|4|5|6|7]
```

Versions 2 to 7 generate the weapons through `external.blender.script@1`, so they need Blender 5.2.2. `ASSET_TOOLING_BLENDER` names it, otherwise `blender` on `PATH` is used. Blender installed as a snap can only read and write under `$HOME`, so set `TMPDIR` to a directory there. Version 1 needs no Blender. Versions 3 to 7 also need `ffmpeg` and `ffprobe` for the image codec.

[`scripts/build-ranger-character.ts`](../scripts/build-ranger-character.ts) is the maintained recipe. It needs no network after `cargo fetch`: the processor runs `cargo run --offline`. The processor checkout must be source-clean at the pinned commit. `Cargo.lock` and `target/` may be present, but nothing else may differ. Its identity (`git-clean-exact-head`, cargo/rustc versions and the probe) is part of the `animation.retarget@1` build identity. `<directory>` becomes the object-store root, which holds every intermediate AssetRef. The script prints the bundle directory, the tar path, the tar sha256 and the export ref, and writes `lineage.json` next to them with every intermediate AssetRef and the retarget observations.

| Step | Operation | Inputs and parameters |
| --- | --- | --- |
| 1 | `scene.import.gltf@2` | The Male_Ranger outfit, and the Superhero body with its two [declared substitutions](humanoid-sources.md#declared-substitution). |
| 2 | `scene.subset.skinned.gltf@1` | The body, cut down to its head and face with the [Ranger recipe](gltf-subset.md#ranger-character-recipe). |
| 3 | `scene.compose.skinned.gltf@1` | Skeleton = outfit, parts = the head subset. |
| 4 | `scene.extract.animation.gltf@1` | The composed GLB with `hipsJoint: "pelvis"`: the target rig only. |
| 5 | `scene.extract.animation.gltf@1` | Once per clip: the UAL1 GLB with `hipsJoint: "DEF-hips"`, or for `Idle_Shield_Loop` the UAL2 GLB with `hipsJoint: "pelvis"`. Each run yields the source rig and the clip. |
| 6 | `animation.retarget@1` | Each clip with its source rig and the target rig, its library's bone map for the version (below), `sampleRate: 30` and `rootMotion: "in-place"`. |
| 7 | `scene.embed.animation.gltf@1` | The composed GLB with every retargeted clip, under its source name, in the order of the clip table. |
| 8 (v2) | `external.blender.script@1`, then `scene.import.gltf@2` | The `sword.arming` and `shield.heater` presets of `adapters/blender/weapon.py`, generated into `<directory>/weapons/<piece>/` and imported. |
| 8b (v3–v5) | `scene.textures.resize.gltf@1` | The step-7 GLB with `RANGER_TEXTURE_POLICY` ([Textures](#textures)), and each weapon GLB that has images. The weapons have none, so they are bundled unchanged. |
| 9 | `asset.bundle@4` | `gltf-resources-v1`: key `humanoid.ranger.male`, variant `default`. From v2 on it also carries the `humanoid-sockets` attachment, validated against the rig's joints, and the two equipment entries. v2 and v3 attach [`humanoid.ranger.male.sockets.bundle-v2.json`](../assets/descriptors/humanoid.ranger.male.sockets.bundle-v2.json), and v4 and v5 attach [`humanoid.ranger.male.sockets.json`](../assets/descriptors/humanoid.ranger.male.sockets.json). |
| 10 | `scripts/pack-asset-bundle.ts` | Packs `<directory>/bundle` into `<directory>/humanoid.ranger.male.tar` and its `.sha256`. |

Every step uses the `NODE_SKINNED_MESH_NON_ROOT` and `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` validator exceptions, the same ones the bundle profile fixes.

## Bone map

`animation.retarget@1` binds 3d-lab `HumanoidBone` ids to a joint name in each rig. The UAL1 rig is a 53-joint Rigify `DEF-*` skeleton. The UBC/Outfits rig has 65 joints in the Unreal style. Both have three spine joints. v5 (`RANGER_V5_BONE_MAP`) maps each of them exactly once through the optional `upper-chest` bone, which sits between `chest` and `neck` (3d-lab `4e69c0f`). v1–v4 (`RANGER_BONE_MAP`) have no `upper-chest` and bind `chest` to `DEF-spine.003` / `spine_03`, leaving the middle joint unmapped.

| HumanoidBone | UAL1 joint | UBC/Outfits joint |
| --- | --- | --- |
| `root` | `root` | `root` |
| `hips` | `DEF-hips` | `pelvis` |
| `spine` | `DEF-spine.001` | `spine_01` |
| `chest` | v5: `DEF-spine.002`; v1–v4: `DEF-spine.003` | v5: `spine_02`; v1–v4: `spine_03` |
| `upper-chest` (v5) | `DEF-spine.003` | `spine_03` |
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

Several joints are not mapped: the fingers and thumbs, the `*_leaf` joints, and in v1–v4 also `spine_02`. They keep their rest pose, so the hands stay in their rest grip. Finger retargeting belongs to the broader library work in #115.

UAL2 uses the same 65-joint Unreal-style rig as UBC/Outfits. `RANGER_UBC_BONE_MAP` (v1–v4, 22 ids) and `RANGER_V5_UBC_BONE_MAP` (v5, 23 ids) therefore bind each `HumanoidBone` id to the same joint name on both sides, for example `hips` → `pelvis` / `pelvis`. Its rest pose is close to the Ranger's but not identical. The retarget transfers rotation deltas from each rig's own rest, so the difference does not leak into the result.

## Retargeting

Asset-tooling implements no part of the retargeting. Processor `three-d-animation-retarget` (3d-lab `4e69c0f`, contract in 3d-lab `docs/contracts/animation-processing.md`) does all of it:

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

Across the 22 mapped bones, each clip has 22 rotation channels, 2 translation channels (hips and root) and 22 scale channels. v5 maps 23 bones, so each clip has 48 channels instead of 46, with the same samples: 3,648 keys for `Idle_Loop` and `Idle_Shield_Loop`, 1,968 for `Walk_Loop`, 1,392 for `Jog_Fwd_Loop`, 1,008 for `Sprint_Loop`, 2,448 for `Sword_Idle`, 2,256 for `Sword_Attack` and 3,504 for `Death01`. The scale channels appear because both libraries key scale on every mapped bone; for UAL1 the keyed scale stays within 4e-7 of 1. UAL1 also ships `Sword_Attack_RM`, a root-motion variant. The bundle takes the plain `Sword_Attack`, and `in-place` removes any remaining horizontal hips travel. `Death01` keeps its vertical drop, because in-place removes only horizontal motion.

## Conventions

The character keeps the Quaternius export's conventions; no transform is changed. The composed rest pose was checked against them:

- **Units and axes:** metres, +Y up.
- **Origin:** `root` is at the origin, and the feet are symmetric about x = 0. The ankles are at z = -0.09 and the balls of the feet at z = +0.06.
- **Facing:** +Z (the toes point to +Z) with the character's left at +X.
- **Height:** the pelvis is at 0.949 m and the head joint at 1.60 m.
- **Root motion:** every clip is in place. The pelvis's horizontal model-space position is constant over each clip; gameplay owns position and facing (mmorpg#39).

## Textures

v3 runs the character GLB through [`scene.textures.resize.gltf@1`](gltf-texture-resize.md) with `RANGER_TEXTURE_POLICY`:

- the longest edge is at most 1024 px for `baseColor`, `normal` and `emissive`, and at most 512 px for `metallicRoughness` and `occlusion`;
- `default` is 1024 px;
- smaller images, such as the 256 px eye textures, are kept byte for byte.

The textures stay PNG, so no consumer needs a KTX2 or WebP decoder. Colour is averaged in linear light, ORM and roughness data as stored, and normal maps as renormalized vectors, and the PNGs are written at zlib level 9. Only image bytes change. The v3 character `.gltf` differs from v2 only in its `images` entries, the geometry and animation `.bin` is the same file, and the two equipment entries are byte-identical to v2.

From the recorded v3 build (the 13 images total 53,414,027 bytes before and 7,169,668 bytes after):

| Image | Slot | Before | After |
| --- | --- | --- | --- |
| `T_Ranger_Normal` | normal | 4096², 12,713,653 B | 1024², 962,296 B |
| `T_Ranger_BaseColor` | baseColor | 4096², 6,630,927 B | 1024², 871,737 B |
| `T_Ranger_ORM` | metallicRoughness | 4096², 10,792,085 B | 512², 249,136 B |
| `T_Regular_Male_Normal` | normal | 2048², 4,064,184 B | 1024², 915,837 B |
| `T_Regular_Male_Dark_BaseColor` | baseColor | 2048², 1,316,151 B | 1024², 473,503 B |
| `T_Regular_Male_Roughness` | metallicRoughness | 2048², 3,160,102 B | 512², 185,123 B |
| `T_Hair_1_BaseColor` | baseColor | 2048², 1,570,376 B | 1024², 651,218 B |
| `T_Hair_1_Normal.png` | normal | 2048², 4,326,126 B | 1024², 1,110,405 B |
| `T_Eye_Brown` | baseColor | 256², 35,958 B | unchanged |
| `T_Eye_Normal.png` | normal | 256², 15,099 B | unchanged |
| `T_Superhero_Male_Dark` | baseColor | 2048², 1,384,380 B | 1024², 499,951 B |
| `T_Superhero_Male_Normal` | normal | 2048², 4,252,937 B | 1024², 1,013,633 B |
| `T_Superhero_Male_Roughness` | metallicRoughness | 2048², 3,152,049 B | 512², 185,772 B |

**Visual parity:** the socket sheets (`examples/weapons/socket-sheets.py`, Blender 5.2.2 Cycles) were rendered for v2 and v3 at rest, `Idle_Loop` middle, `Walk_Loop` middle and `Sword_Attack` 50 %. The renders are deterministic: a fresh v2 render matched the published v2 `Sword_Attack` sheet exactly. The v2 to v3 differences, as mean and maximum absolute RGB difference on a 0–255 scale over the 1440 × 960 sheet, were:

| Pose | Mean | Max | Pixels differing by more than 16 |
| --- | --- | --- | --- |
| rest | 0.062 | 49 | 0.010 % |
| `Idle_Loop` middle | 0.130 | 39 | 0.042 % |
| `Walk_Loop` middle | 0.135 | 44 | 0.058 % |
| `Sword_Attack` 50 % | 0.094 | 49 | 0.010 % |

v6 adds these clips, also in place, with 48 channels each:

| Clip | Source | Use | Duration |
| --- | --- | --- | --- |
| `Jump_Start` | UAL1 | jump takeoff | 1.333 s |
| `Jump_Loop` | UAL1 | airborne / fall loop | 2.5 s |
| `Jump_Land` | UAL1 | landing | 1.267 s |
| `Crouch_Idle_Loop` | UAL1 | crouch idle | 2.933 s |
| `Crouch_Fwd_Loop` | UAL1 | crouch walk | 2 s |
| `Roll` | UAL1 | dodge roll, in-place source | 1.467 s |
| `Roll_RM` | UAL1 | dodge roll, root-motion source | 1.467 s |
| `ClimbUp_1m_RM` | UAL2 | climb up a 1 m ledge | 0.667 s |
| `Slide_Start` | UAL2 | slide entry | 0.833 s |
| `Slide_Loop` | UAL2 | slide loop | 2 s |
| `Slide_Exit` | UAL2 | slide exit | 0.5 s |

In-place retargeting removes the horizontal hips travel of the `_RM` sources and keeps vertical motion. `ClimbUp_1m_RM` therefore still rises about 1 m and the slide clips drop and raise the pelvis about 0.8 m. The source travel is recorded in [Clip motion](#clip-motion), so a consumer can move the gameplay body to match.

v7 adds these clips (UAL2 unless noted), also in place:

| Clip | `role` | Duration | Contact (`hand_r` unless noted) |
| --- | --- | --- | --- |
| `Sword_Regular_A`, `_A_Rec` | `sword.light-strike`, `.recovery` | 0.433 s, 0.967 s | 0.25 s |
| `Sword_Regular_B`, `_B_Rec` | `sword.counter`, `.recovery` | 0.533 s, 1.033 s | 0.25 s |
| `Sword_Regular_C` | `sword.heavy-strike` | 2 s | 0.65 s |
| `Sword_Regular_Combo` | `sword.light-chain` | 3 s | 1.55 s |
| `Sword_Block` | `shield.block-impact` | 1.233 s | |
| `Idle_Shield_Break` | `shield.block-break` | 1.067 s | |
| `Shield_OneShot` | `shield.bash` | 0.833 s | 0.083 s (`hand_l`) |
| `Hit_Chest`, `Hit_Head` (UAL1), `Hit_Knockback` | `hit.chest`, `hit.head`, `hit.knockback` | 0.333, 0.433, 0.833 s | |
| `Spell_Simple_Enter`, `_Idle_Loop`, `_Shoot`, `_Exit` (UAL1) | `cast.enter`, `cast.hold`, `cast.release`, `cast.exit` | 0.533, 2.1, 0.5, 0.433 s | 0.083 s (`_Shoot`) |

The v2 clips `Sword_Idle`, `Sword_Attack`, `Death01` and `Idle_Shield_Loop` get the roles `sword.ready`, `sword.strike` (contact 0.383 s), `death` and `shield.guard-hold`.

## Clip motion

From v6 the character entry carries a `humanoid-clips` attachment, schema `humanoid-clips-v1`. It is canonical JSON with `units: "m"`, `up: "+Y"`, `facing: "+Z"` and one entry per clip, in bundle order:

- `name`, and `source`: the library's catalog id, the source clip name and the sha256 of the extracted source animation (`lineage.json` lists the same AssetRef);
- `durationSeconds`, `loop` (the source name ends in `_Loop`), `interpolation: "LINEAR"` and `rootMotion: "in-place"`;
- `sourceRootDisplacement` `{x, y, z}`: the source hips' model-space travel from the first to the last key, scaled by the hips reference-height ratio (0.9491 / 0.9167). `x` and `z` were removed from the clip; `y` is still in it;
- from v7, `role` for the combat clips, and for strikes `contact` `{joint, seconds, speedMetersPerSecond}`: the midpoint of the sample interval in which that joint moves fastest in model space. This is a presentation landmark. It never times gameplay, and the consumer owns windup, active and recovery phases;
- `groundSpeedMetersPerSecond`, only for the forward gaits `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop` and `Crouch_Fwd_Loop`. It is the median speed at which the lower foot moves backwards (−Z) between consecutive samples of the retargeted clip, which is the body speed at which that foot would not slide. The source gaits are themselves in place, so this is the only speed they define.

From the recorded v6 build: ground speeds 1.0434 m/s (walk), 1.7637 m/s (jog), 2.1345 m/s (sprint) and 0.657 m/s (crouch walk). Root displacement: `Roll_RM` z 5.2693 m, `ClimbUp_1m_RM` y 1.0353 m and z 1.7356 m, `Jump_Start` y 0.358 m, `Slide_Start` y −0.8079 m and `Slide_Exit` y +0.8079 m. These are measurements, not a gameplay contract: the consumer owns movement speed and collision.

The largest differences are in the hand close-ups, where fine texture detail is lost.

**Normal maps:** each resized normal map keeps the sign of its mean X and Y components, which rules out a flipped green channel. The mean vector length is 1.000, so the maps are not washed out. The mean angle to a plain box downscale of the source is 0.18–0.34°.

## Bundle and consumer pinning

The v2–v6 bundles have three entries, and v7 adds `equipment.bow.long`, `equipment.arrow` and `equipment.quiver.back`:

- **`humanoid.ranger.male` / `default`:** `scenes/humanoid.ranger.male/default.gltf` with one geometry/animation `.bin` and its 13 PNG textures as hash-addressed resources (game resolution from v3 on). It has 2 skins, 31,578 triangles and the eight clips above (v6: 19 clips). Its `humanoid-sockets` attachment is that version's descriptor, byte for byte; from v6 it also has the `humanoid-clips` attachment.
- **`equipment.sword.arming` / `default`:** 1,304 triangles, with nodes `grip` and `sword.arming`.
- **`equipment.shield.heater` / `default`:** 1,706 triangles, with nodes `grip` and `shield.heater`.

The weapons are unskinned and unanimated. A consumer parents an item's scene root under the socket joint with the socket's TRS ([humanoid-sockets.md](humanoid-sockets.md)). `manifest.json` records each embedded GLB's AssetRef as `source`, and `lineage.json` from the build links the character GLB back to the canonical members and lists the weapon and sockets AssetRefs. The v1 bundle has only the character entry, with the clips `Idle_Loop` and `Walk_Loop` and no attachment.

A consumer pins the three things described in [Release distribution and consumer pinning](asset-bundles.md#release-distribution-and-consumer-pinning):

1. the release tag;
2. the tar sha256;
3. its own copy of `export.ref.json`.

It then runs `bun scripts/pack-asset-bundle.ts --verify humanoid.ranger.male.tar --ref <pinned export.ref.json>` (or `verifyAssetBundle` after extracting). It loads the character with `readAssetBundleGltf(dir, manifest, "humanoid.ranger.male", "default")`, the weapons the same way, and the sockets with `readAssetBundleAttachment(dir, manifest, "humanoid.ranger.male", "default", "humanoid-sockets")` (and, from v6, the clip motion with `"humanoid-clips"`). Publishing the release (`gh release create`) is a separate, explicit step.

Two cold v1 builds on 2026-10-17 from separate object stores produced the same tar: sha256 `4de4cc65585a0709066843a9c0bf73315820024e360326c2f1bf86b4c7955c91`, 55,587,328 bytes, with manifest sha256 `72f79132d20dae5f9d17de2b32eb0d41543f8bd74db1c0c0b2d0a9afe4b386d7` (5,364 bytes). Two v2 builds on 2026-10-17 from separate object stores (Blender 5.2.2 snap) also produced the same tar: sha256 `ccb267e4c6e21dd8d98597784569d51732612a0a76f3c6b9c067d556b3f66167`, 56,005,120 bytes, with manifest sha256 `a1170d10db2a275e59bde2e243a5163d735d6b466fb8fa0e07434c0ccfaae90e` (8,525 bytes). Two cold v3 builds on 2026-10-17 from separate object stores also produced the same tar: sha256 `cd6393c06ef5b793032fce7ed9f2c10d92609045d874296ace0506b54971fc3f`, 9,758,720 bytes (v2: 56,005,120), with manifest sha256 `3cee42ebbc1e8fe3d405ee5d69ff5059c6a992f12c721d9df42238a17b97b1a5` (7,827 bytes). Two cold v4 builds on 2026-10-17 from separate object stores also produced the same tar: sha256 `222f21f8df449321f4cb34b67e693186e0435a449c19eacb8dece9fb001a741f`, 9,758,720 bytes, with manifest sha256 `cdc63b4632d08c88807082109fd633aa00c3f54f2c1627ef81b4034ccebba169` (7,827 bytes). After the v4 change, `--version 2` and `--version 3` rebuilt the recorded tars `ccb267e4…` and `cd6393c0…` byte for byte. Two cold v5 builds on 2026-10-17 from separate object stores (3d-lab `4e69c0f`, Blender 5.2.2 snap) also produced the same tar: sha256 `059f92768f2181070f32d48c6102be1b77143cc4d21d99a24d6ebd7d3bd04d0c`, 9,778,176 bytes, with manifest sha256 `a127d96cdaf6a75826fad14fb9b7f53f02608f4791f9dd0d9284a4f949a12678` (7,827 bytes). Two cold v6 builds on 2026-10-17 from separate object stores (3d-lab `4e69c0f`, Blender 5.2.2 snap) also produced the same tar: sha256 `9f5d625cb0d28fde67ad002608460ab2575790aa71a02bc2249a6bc0f26f9006`, 10,396,672 bytes, with manifest sha256 `6e506a4ff266ea4e18126d1809c7157e052fae6ef8719040fcda902a0b94d061` (8,409 bytes). Two cold v7 builds on 2026-10-17 from separate object stores (3d-lab `4e69c0f`, Blender 5.2.2 snap) also produced the same tar: sha256 `62bbe8637421f6ef22fa4f91ff329ba1b8092836bb47e202bf5e6dfa3f9b0c0a`, 11,194,368 bytes, with manifest sha256 `f211bdbdcf086a4af1c887afa9ecbd34ad7945ca1067f72ef119182a8d3ed8c7` (11,744 bytes). These are records of those runs, not a byte-exact replay contract.

## Tests

- `bun test test/gltf-animation-operations.test.ts` uses hand-authored skinned fixtures. It covers the rig, the hips reference height through a non-joint armature, clip extraction on joint indices, skipping a non-joint channel, an extract → embed → extract round trip, and the rejection of existing or duplicate clip names and of out-of-range nodes.
- `bun test test/animation-retarget-operations.test.ts` runs a fixture adapter. It covers the name → index binding conversion, the `sampleRate` grid, output and observation checks, and parameter failures.
- `bun scripts/check-processor-contract.ts <checkout> <commit> moritzbrantner/3d-lab examples/asset-tooling-animation-adapter/Cargo.toml animation.retarget` runs the pinned processor on two tiny rigs, twice, including an `upper-chest` bend that must land on the target's `upper-chest` joint. This is also the hosted stability matrix entry.
- `bun test test/gltf-texture-resize-operations.test.ts` covers the texture operation ([gltf-texture-resize.md](gltf-texture-resize.md#tests)).
- `test/humanoid-ranger.test.ts` always checks the v2 and v6 clip lists, the UAL2 same-name bone maps, the v5 spine map (each spine joint mapped once) against the v1–v4 map, the v6 default, the sockets descriptor of each version and `RANGER_TEXTURE_POLICY`. It also runs the whole v6 recipe and checks the bundle structurally:
  - every clip name in order, each with a positive duration;
  - in place: the pelvis's horizontal model-space drift, with root and pelvis keys composed, is at most 1 cm;
  - only mapped joints are animated, with LINEAR samplers, and every clip rotates `spine_02`;
  - the two equipment entries are unskinned, unanimated and have a `grip` node;
  - the `humanoid-sockets` attachment matches the versioned descriptor byte for byte and validates against the 65 joints;
  - the `humanoid-clips` attachment lists every clip in order with its source animation sha256, loop flag and in-place root motion; the gait speeds increase from crouch walk to sprint, and `Roll_RM` and `ClimbUp_1m_RM` record their removed travel;
  - the 13 character textures fit their slot limits, none is upscaled, the image bytes shrink at least fourfold, and the equipment has no images.

  The full run skips unless the Git LFS payloads are hydrated, `ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB` names the pinned checkout and `ASSET_TOOLING_BLENDER` names Blender 5.2.2.

## Visual check of the v2 clips

The socket sheets were rendered with the sword in `hand_r.weapon` and the shield in `hand_l.shield` at `Jog_Fwd_Loop` and `Sprint_Loop` (a quarter and the middle), `Sword_Idle` (the middle), `Sword_Attack` (30, 50 and 70 %), `Death01` (the middle and the end) and `Idle_Shield_Loop` (the middle). They show no inverted or twisted limbs and no root drift: the pelvis keeps its horizontal position in every clip. The gaits run in place, so the feet slide backwards by design; gameplay moves the character. Known limits:

- **Hands:** the fingers keep their open rest pose (#115), so the sword lies across an open hand in every clip.
- **Sword angle (bundle-v2 sockets, fixed in v4):** the `hand_r.weapon` socket was authored for a hanging arm. In `Sword_Idle` the blade points sideways at hip height rather than forward, and in `Sword_Attack` it follows the extended arm.
- **Shield guard (bundle-v2 sockets, fixed in v4):** `hand_l.shield` aligns the shield's vertical axis with the forearm. In `Idle_Shield_Loop` the forearm is held across the body, so the shield sits on its side with the point toward the character's left instead of down.
- **Death:** at the end of `Death01` the character lies on its back with the pelvis joint 6.5 cm above the ground, and the right hand's fingertip joints sink up to 9 cm below it. See [Death01 ground penetration](#death01-ground-penetration) for the cause, fixed in v5.

## Visual check of the v4 sockets

The socket sheets (`examples/weapons/socket-sheets.py`, Blender 5.2.2 Cycles) were rendered from the v4 bundle, with the sword in `hand_r.weapon` and the shield in `hand_l.shield`, at these poses:

- rest;
- the middle of `Idle_Loop`;
- a quarter and the middle of `Walk_Loop`;
- `Sword_Idle` 50 %;
- `Sword_Attack` 30, 50 and 70 %;
- `Idle_Shield_Loop` 50 %;
- the end of `Death01`.

Directions below are the character's own.

| Pose | Finding |
| --- | --- |
| rest (T-pose) | The grip lies under the open palm along the knuckle line, and the blade runs past the thumb. The shield hangs under the left forearm, face down. |
| `Idle_Loop` middle | The sword points forward from the hanging right hand, slightly raised and clear of the leg. The shield stands on the outside of the left arm, face out, its top tilted forward and its point down and back. |
| `Walk_Loop` quarter and middle | The same as `Idle_Loop`. The shield is close to upright on the outside of the arm. Nothing clips. |
| `Sword_Idle` 50 % | The stance turns about 40° to the right, with the sword hand low beside the right hip. The blade points forward along the stance, slightly to the right, and about 24° up. Seen from the world front, it still reads as pointing out to the right, because the whole stance is turned. With the bundle-v2 socket it was level and pointed straight to the right. |
| `Sword_Attack` 30 % and 50 % | The lunge to the left extends the arm, and the blade continues the arm's line: a level thrust in the strike direction. The shield is held back on the left with its face outward. |
| `Sword_Attack` 70 % | In the recovery, the blade is raised forward and up from the right hand. |
| `Death01` end | The sword and shield lie flat beside the body and partly below the ground, like the right hand ([below](#death01-ground-penetration)). |
| `Idle_Shield_Loop` 50 % | The shield stands upright in front of the chest with its face forward and its point down. Its top edge is at chin height. The sword hangs from the right hand, pointing forward and down. |

The sheets show no gross clipping. Known limits:

- The fingers are open (#115).
- The shield's forearm strap floats behind the board beside the wrist ([humanoid-sockets.md](humanoid-sockets.md#ranger-sockets)).
- The hanging-arm poses tilt the shield forward.
- The `Sword_Idle` stance itself is turned, and with it the guard.

## Visual check of v5

The socket sheets were rendered from the v5 bundle with the same setup as for v4, at `Sword_Idle` 50 %, `Sword_Attack` 50 %, the end of `Death01`, `Idle_Shield_Loop` 50 % and the middle of `Walk_Loop`, and compared with the v4 sheets. The legs, the pelvis and the in-place behaviour are unchanged. The chest now follows the source's middle spine bend, so the upper body changes as follows:

| Pose | Change from v4 |
| --- | --- |
| `Walk_Loop` middle | No visible change. |
| `Sword_Idle` 50 % | The upper body leans further forward and the head is lower. The blade is close to level instead of raised about 24°. The shield hangs lower in front of the left hip. |
| `Sword_Attack` 50 % | The torso is hunched forward over the lunge, with the head down. The thrust now points forward and down instead of level. The shield is raised high on the left, with its rim beside the hood. |
| `Idle_Shield_Loop` 50 % | The head is tilted further down, and the shield's top edge is at eye height instead of chin height. The sword points further down. |
| `Death01` end | The body lies the same way, but the shoulders and head are higher and both hands lie on the ground instead of below it. The sword and shield lie flat beside the body. The sheets have no ground plane, so whether their edges touch it cannot be read from them. |

The sheets show no inverted or twisted limbs and no gross clipping. The known limits of v4 (open fingers, the floating shield strap, the turned `Sword_Idle` stance) still apply.

## Death01 ground penetration

At the end of `Death01`, the right fingertip joints of the v2–v4 bundles are 8.7 cm below the ground. UAL1's own fingers are about 2 cm above it. The cause is not the retarget's height handling:

- **Hips height:** the pelvis lies 6.5 cm above the ground, which is UAL1's 6.3 cm scaled by 0.9491 / 0.9167.
- **Root translation:** in-place removes only the horizontal part.
- **Limb length:** the Ranger's upper arm (0.251 m) and forearm (0.240 m) are shorter than UAL1's (0.274 m and 0.273 m), not longer.

The cause is the bone map. UAL1 has three spine joints (`DEF-spine.001`, `.002` and `.003`). The 22-bone `HumanoidBone` vocabulary of 3d-lab `86e5fe1` had only `spine` and `chest`, and v1–v4 bind these to `spine_01` and `spine_03`. The local rotation of `DEF-spine.002` is therefore dropped, and the Ranger's `spine_02` keeps its rest pose. The chest's world orientation is off by the bend of `DEF-spine.002`. At the end of `Death01` that bend is 6.0°, and the arm hangs from the chest.

**Fix (v5, [#268](https://github.com/moritzbrantner/asset-tooling/issues/268)):** 3d-lab `4e69c0f` adds the optional `upper-chest` bone, and v5 maps all three spine joints ([Bone map](#bone-map)). IK would not have fixed this, and a fold of `DEF-spine.002` into `DEF-spine.003` before the retarget would have put animation semantics into asset-tooling.

The chest error is the angle between the world-frame rotation deltas from rest, W(t) · W(rest)⁻¹, of the Ranger's `spine_03` and the source's `DEF-spine.003` (for `Idle_Shield_Loop`, UAL2's `spine_03`). It is measured at 11 evenly spaced samples per clip, from the start to the last key:

| Clip | Maximum chest error, v4 | Maximum chest error, v5 |
| --- | --- | --- |
| `Idle_Loop` | 5.9° | 0.5° |
| `Walk_Loop` | 5.2° | 0.7° |
| `Jog_Fwd_Loop` | 16.1° | 5.5° |
| `Sprint_Loop` | 11.8° | 4.2° |
| `Sword_Idle` | 20.4° | 1.9° |
| `Sword_Attack` | 29.8° | 11.3° |
| `Death01` | 14.4° | 1.8° |
| `Idle_Shield_Loop` | 12.9° | 2.2° |

At the end of `Death01` in v5, the lowest right fingertip joint (`ring_04_leaf_r`) is 0.9 cm above the ground (v4: `middle_04_leaf_r`, 8.7 cm below). The right shoulder (`upperarm_r`) is at 6.2 cm (v4: 2.3 cm), the wrists (`hand_r`, `hand_l`) at 3.6 and 2.6 cm (v4: −4.1 and −2.8 cm), and the lowest left fingertip at 0.2 cm (v4: −7.3 cm). The pelvis stays at 6.5 cm.

**Remaining error:** in v5, the pelvis, `spine_01` and `spine_02` follow the source within 1.6°. The rest of the error appears at `spine_03`. In `Sword_Attack`, `DEF-spine.003` twists up to 75° from its rest, and the rest orientations of `spine_03` and `DEF-spine.003` differ by 11.1° in world space. The processor transfers each bone's local rotation delta onto the target's rest, so a large twist of a joint whose rest axes differ from the source's is applied about slightly different world axes. That is a property of `three-d-animation-humanoid-retarget-v1` in 3d-lab, not of the bone map.

## Not covered here

These remain open on #110 and its consumers:

- the #111 viewer snapshot set at rest, idle and walk. The v2 clips were checked with the Blender socket sheets instead (`examples/weapons/socket-sheets.py --poses=…`), with the findings below;
- the source-versus-runtime pose comparisons;
- the consumer smoke tests in mmorpg#210 and arpg;
- publishing the GitHub Release.
