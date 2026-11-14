# Hair and beard kit

The hair and beard kit (#517) ships the male Ranger's hairstyles and beards as separate skinned pieces on the Ranger head joints, so mmorpg can attach the chosen piece to any male figure (owner answer on #517, 2026-11-08). It rebuilds the Ranger bundle's unused hair and beard variants as their own model. mmorpg switched (mmorpg#677, mmorpg#797), so the male Ranger bundle no longer has hair or beards of its own: its appearance names this kit (`hairKit`), and the kit is the only source of the male hairstyles and beards.

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-hair-kit.ts --out <directory>
```

The build needs the hydrated `assets/authored/hair-kit.blend` and the Quaternius Universal Base Characters and Modular Character Outfits packs (`git lfs pull --include="assets/authored/hair-kit.blend,assets/canonical/quaternius.universal-base-characters-standard.*/**,assets/canonical/quaternius.modular-character-outfits-fantasy-standard.*/**"`). KTX2 encoding needs KTX-Software's `ktx` (`ASSET_TOOLING_KTX` or on `PATH`). It publishes the rolling release `hair-kit` (`hair.kit.tar`) from CI.

## Entries

| Key | Variants | Piece | Source |
| --- | --- | --- | --- |
| `hair.buzzed` | `hair-1`, `hair-2` | Pack hairstyle | Recipe-built from the catalog |
| `hair.simple-parted` | `hair-1`, `hair-2` | Pack hairstyle | Recipe-built from the catalog |
| `hair.long` | `hair-1`, `hair-2` | Pack hairstyle with its buzzed crown (`Hair_Long`, `Hair_Buzzed`) | Recipe-built from the catalog |
| `hair.balding`, `hair.receding`, `hair.swept`, `hair.tied` | `hair-1` | Hand-modelled hairstyle | `hair-kit.blend` |
| `beard.full`, `beard.short`, `beard.long`, `beard.goatee`, `beard.moustache`, `beard.walrus` | `default` | Hand-modelled facial hair | `hair-kit.blend` |

The keys are the option ids the Ranger's `humanoid-appearance` already uses, so presets keep working. The pack hairstyles are a third party's meshes, so they stay recipe-built from the catalog and out of the `.blend` (Decision 3.1.3). As in the Ranger bundle, `hair-1` and `hair-2` of a pack hairstyle are the same asset and share every resource. The kit is male-only, because the hand-modelled pieces are fitted to the male head.

Measured on the first build: 830 to 3,736 triangles for the pack hairstyles, 2,288 to 5,096 for the hand-modelled hairstyles, 552 to 6,296 for the beards. The tar is 7.5 MB.

## Attaching a piece

Each entry is one static-rest, skinned glTF scene: the mesh node (`Hair_Long`, `hair.tied`, `beard.full`, ...) and a `Head` joint at the head's rest pose, plus the piece's accessory chain joints below `Head`. A piece carries no clips and no copy of the figure's other joints.

- **Through a socket** (the smallest adoption): put the piece's scene under the figure's `head.hair` socket for a hairstyle or `head.armor` for a beard, as mmorpg attaches hair today. The socket is the inverse of the head's rest transform, so the piece's `Head` joint lands exactly on the figure's `Head` joint and the mesh follows the head.
- **By joint name:** bind the piece's skin to a figure on the Ranger rig by joint name, keeping the inverse bind matrices. The figure's `Head` replaces the piece's, and the chain joints are parented to it. The two routes are the same at rest.

Chain joints are `hair_back_01..03` on `hair.long`, `hair_tail_01..02` on `hair.tied` and `beard_01` or `beard_01..02` on `beard.full` and `beard.long`. A consumer springs them on top of the clips as for any Ranger accessory chain (`docs/humanoid-ranger.md`, #391); left at rest they deform nothing.

Every piece carries the Ranger's build morph targets (`build.lean`, `build.heavy`); the beards also carry the age targets. A consumer drives them with the figure's own weights.

## Descriptor

The `hair-descriptor` attachment (on `hair.buzzed/hair-1`, schema `hair-kit-descriptor-v1`) contains:

- `figure`, `rig`: the figure the pieces fit, its joint count and rig hash, the `Head` joint and the rule above;
- `tints`: the hair tints (`tint.black`, `tint.brown`, `tint.blond`, `tint.grey`) as base colour factors;
- `hair[]` and `facialHair.options[]`, one record per piece:
  - `id` (and `entry`, the same key); `label` for a beard; `source` (the pack mesh name, or `authored`);
  - `socket`, `joint` (`Head`) and `joints` (`Head` plus the chain joints);
  - `variants`: the entry's variant names;
  - `tintMaterials` (recolour these with the tint) and `fixedMaterials` (the tied style's `hair.tie` keeps its leather colour);
  - `hides`: figure nodes the piece hides (none today; hair, eyebrows and head all stay visible);
  - for a hairstyle, `requires: { "outfit.hood": false }`, as the Ranger's record: a hairstyle needs the hood off;
  - `secondary`: the chains in the Ranger's `{ id, kind, parent, joints, swingLimitDegrees, nodes }` shape (`parent` is `Head`);
  - `morphs`: the morph target names it carries (`build`, and `age` on beards);
  - `triangles`.

`facialHair.followsHairTint` is true: beards take the hair tint, like the Ranger's. Adoption details are in the mmorpg adoption issue linked from #517.

## How it is built

- **Geometry** (Decision 3.1.3): the hand-modelled pieces are authored in `assets/authored/hair-kit.blend` (Git LFS).
  - Collections `hair.kit.hair` and `hair.kit.beards` hold one mesh object per piece, at identity in the character's rest space (Blender's Z-up frame of the glTF character). Their JSON custom property `hairkit` names the material slots, and they keep the UVs in the strand column of `T_Hair_1`.
  - The materials are placeholders. The file holds no third-party bytes: no Quaternius head, hair, armature or texture.
  - The geometry was seeded from `adapters/blender/hair_beards.py` (#380) on the fit target, then shaped in Blender: the crown pinch on `hair.swept` was softened, the beard hems were smoothed, and the inner shell against the skin was removed from the hair caps and from the beards where it lies on the skin (about half the triangles of a cap).
- **`adapters/blender/hair_kit.py`** reads an output's collection, dresses each mesh in the pack's `MI_Hair_1` (from the declared input `material`, the Ranger's imported Hair_Buzzed) or the `hair.tie` factor material, and exports static meshes.
- **`scripts/build-hair-kit.ts`** builds the rest from the same catalog members, through the same cached operations as the Ranger:
  - the Ranger rig and the fit target (the Peasant outfit and the plain head);
  - the pack hairstyles' import (with the long style's crown) and texture resize;
  - the build keys on every piece and, on the beards, the age keys (`male_variety.py`);
  - the head skin: every mesh goes on a `Head` joint at the rest pose (the inverse of the `head.hair` socket), then the accessory chains are added below it with `addSecondaryChains` (the Ranger's `RANGER_HAIR_CHAINS` and `RANGER_BEARD_CHAINS`, each chain on its own piece, parent `Head`);
  - every texture becomes KTX2 (`KHR_texture_basisu`), encoded like the crag and Redbrand kits (`TERRAIN_KTX2`): UASTC sRGB base colour, UASTC normals, ETC1S linear data maps.
- **Determinism:** the release build uses the shared generation and operation cache (`docs/cache.md`, #516). `test/blender/hair/hair-kit.test.ts` builds twice and compares the tars.

To shape the pieces again, append the two collections into a scene of a live Blender next to the fit target and edit them. Then write the collections back into the `.blend` with their `hairkit` properties and no third-party data. Rebuild, and look at the result on the head at the game camera before merging.
