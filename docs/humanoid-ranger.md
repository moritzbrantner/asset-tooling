# Ranger character bundle

This is the build recipe for the first clothed, skinned humanoid of [#110](https://github.com/moritzbrantner/asset-tooling/issues/110): the Quaternius **Male_Ranger** outfit ([Atlas Decision 1.1.3](decisions/atlas.md)) with the Universal Base Characters head, and the UAL1 `Idle_Loop` and `Walk_Loop` clips retargeted onto its rig. It follows the owner answers of 2026-10-17 on #110:

- The clips are retargeted with 3d-lab's `three_d_animation::retarget` and an explicit semantic bone map.
- The walk is in place.
- The conventions are metres, +Y up, facing +Z and the origin between the feet.
- The result is a `gltf-resources-v1` bundle ([asset-bundles.md](asset-bundles.md#gltf-resources-profile)), published as a versioned GitHub Release.
- Acceptance is structural checks, the #111 viewer snapshots and consumer smoke tests. There is no byte-exact replay and no Blender world-space oracle.

The source members are listed in [humanoid-sources.md](humanoid-sources.md).

## Build

```sh
git clone https://github.com/moritzbrantner/3d-lab <checkout>
git -C <checkout> checkout 86e5fe1dc6e564176de35723b31e217bf385b20a   # the stability/processors.json pin
cargo fetch --manifest-path <checkout>/examples/asset-tooling-animation-adapter/Cargo.toml
git lfs pull   # the humanoid members under assets/canonical/
bun scripts/build-ranger-character.ts --processor-checkout <absolute checkout> --out <directory>
```

[`scripts/build-ranger-character.ts`](../scripts/build-ranger-character.ts) is the maintained recipe. It needs no network after `cargo fetch`: the processor runs `cargo run --offline`. The processor checkout must be source-clean at the pinned commit. `Cargo.lock` and `target/` may be present, but nothing else may differ. Its identity (`git-clean-exact-head`, cargo/rustc versions and the probe) is part of the `animation.retarget@1` build identity. `<directory>` becomes the object-store root, which holds every intermediate AssetRef. The script prints the bundle directory, the tar path, the tar sha256 and the export ref, and writes `lineage.json` next to them with every intermediate AssetRef and the retarget observations.

| Step | Operation | Inputs and parameters |
| --- | --- | --- |
| 1 | `scene.import.gltf@2` | The Male_Ranger outfit, and the Superhero body with its two [declared substitutions](humanoid-sources.md#declared-substitution). |
| 2 | `scene.subset.skinned.gltf@1` | The body, cut down to its head and face with the [Ranger recipe](gltf-subset.md#ranger-character-recipe). |
| 3 | `scene.compose.skinned.gltf@1` | Skeleton = outfit, parts = the head subset. |
| 4 | `scene.extract.animation.gltf@1` | The composed GLB with `hipsJoint: "pelvis"`: the target rig only. |
| 5 | `scene.extract.animation.gltf@1` | The UAL1 GLB with `hipsJoint: "DEF-hips"`, once for `Idle_Loop` and once for `Walk_Loop`: the source rig and both clips. |
| 6 | `animation.retarget@1` | Each clip with the source and target rigs, the bone map below, `sampleRate: 30` and `rootMotion: "in-place"`. |
| 7 | `scene.embed.animation.gltf@1` | The composed GLB with both retargeted clips, named `Idle_Loop` and `Walk_Loop`. |
| 8 | `asset.bundle@4` | `gltf-resources-v1`, key `humanoid.ranger.male`, variant `default`. |
| 9 | `scripts/pack-asset-bundle.ts` | Packs `<directory>/bundle` into `<directory>/humanoid.ranger.male.tar` and its `.sha256`. |

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

## Retargeting

Asset-tooling implements no part of the retargeting. Processor `three-d-animation-retarget` (3d-lab `86e5fe1`, contract in 3d-lab `docs/contracts/animation-processing.md`) does all of it:

- It samples the source clip at each sample time.
- It transfers each mapped bone's local rotation delta onto the target's rest pose.
- It scales hips and root translation by the ratio of the reference heights.
- With `in-place`, it removes the model-space horizontal part of that translation and keeps the vertical bob.

The reference height of each rig is its hips joint's model-space height at rest, taken through every ancestor (`scene.extract.animation.gltf@1`): 0.9167 m for UAL1 `DEF-hips` and 0.9491 m for UBC `pelvis`. The sample grid is `start + i/30` up to the clip's last key. The last sample is always exactly the clip's last key, never past it, so both loop endpoints are sampled. Output keys are written as LINEAR glTF samplers on the skin's joint nodes.

From the recorded build:

| Clip | Duration | Samples | Channels | Keys |
| --- | --- | --- | --- | --- |
| `Idle_Loop` | 2.5 s | 76 | 46 | 3,496 |
| `Walk_Loop` | 1.333 s | 41 | 46 | 1,886 |

Across the 22 mapped bones, each clip has 22 rotation channels, 2 translation channels (hips and root) and 22 scale channels. The scale channels appear because UAL1 keys scale on every mapped bone; the keyed scale stays within 4e-7 of 1.

## Conventions

The character keeps the Quaternius export's conventions; no transform is changed. The composed rest pose was checked against them:

- **Units and axes:** metres, +Y up.
- **Origin:** `root` is at the origin, and the feet are symmetric about x = 0. The ankles are at z = -0.09 and the balls of the feet at z = +0.06.
- **Facing:** +Z (the toes point to +Z) with the character's left at +X.
- **Height:** the pelvis is at 0.949 m and the head joint at 1.60 m.
- **Root motion:** the walk is in place. The pelvis's horizontal model-space position is constant over both clips; gameplay owns position and facing (mmorpg#39).

## Bundle and consumer pinning

The bundle has one entry, `humanoid.ranger.male` / `default`: `scenes/humanoid.ranger.male/default.gltf` with one geometry/animation `.bin` and its 13 PNG textures as hash-addressed resources. It has 2 skins, 31,578 triangles and the clips `Idle_Loop` and `Walk_Loop`. `manifest.json` records the embedded GLB's AssetRef as `source`, and `lineage.json` from the build links that GLB back to the canonical members.

A consumer pins the three things described in [Release distribution and consumer pinning](asset-bundles.md#release-distribution-and-consumer-pinning):

1. the release tag;
2. the tar sha256;
3. its own copy of `export.ref.json`.

It then runs `bun scripts/pack-asset-bundle.ts --verify humanoid.ranger.male.tar --ref <pinned export.ref.json>` (or `verifyAssetBundle` after extracting) and loads the character with `readAssetBundleGltf(dir, manifest, "humanoid.ranger.male", "default")`. Publishing the release (`gh release create`) is a separate, explicit step.

Two cold builds on 2026-10-17 from separate object stores produced the same tar: sha256 `4de4cc65585a0709066843a9c0bf73315820024e360326c2f1bf86b4c7955c91`, 55,587,328 bytes, with manifest sha256 `72f79132d20dae5f9d17de2b32eb0d41543f8bd74db1c0c0b2d0a9afe4b386d7` (5,364 bytes). This is a record of that run, not a byte-exact replay contract.

## Tests

- `bun test test/gltf-animation-operations.test.ts` uses hand-authored skinned fixtures. It covers the rig, the hips reference height through a non-joint armature, clip extraction on joint indices, skipping a non-joint channel, an extract → embed → extract round trip, and the rejection of existing or duplicate clip names and of out-of-range nodes.
- `bun test test/animation-retarget-operations.test.ts` runs a fixture adapter. It covers the name → index binding conversion, the `sampleRate` grid, output and observation checks, and parameter failures.
- `bun scripts/check-processor-contract.ts <checkout> <commit> moritzbrantner/3d-lab examples/asset-tooling-animation-adapter/Cargo.toml animation.retarget` runs the pinned processor on two tiny rigs, twice. This is also the hosted stability matrix entry.
- `test/humanoid-ranger.test.ts` runs the whole recipe and checks the bundle structurally. It skips unless the Git LFS payloads are hydrated and `ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB` names the pinned checkout.

## Not covered here

These remain open on #110 and its consumers:

- the #111 viewer snapshot set at rest, idle and walk;
- the source-versus-runtime pose comparisons;
- the consumer smoke tests in mmorpg#210 and arpg;
- publishing the GitHub Release.
