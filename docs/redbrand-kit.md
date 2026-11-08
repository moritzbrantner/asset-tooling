# Redbrand faction kit

The Redbrand faction kit (#517) dresses mmorpg's Redbrand Hollow bandits. They wear a rough dark oxblood long coat to mid-calf with long sleeves over brown work trousers and the Peasant boots, a mantle in the band's recolourable red (`faction`) round the neck and shoulders with a hanging end, a leather belt and leather bracers. It is the first of the Ranger bundle's unused variants rebuilt as its own model (owner answers on #517, 2026-11-08). mmorpg dresses its bandits and crossbowmen from the kit (moenarch-games/mmorpg#676), so the Ranger bundle no longer ships `outfit.redbrand` or `armor.redbrand`.

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-redbrand-kit.ts --out <directory>
```

The build needs the hydrated `assets/authored/redbrand-kit.blend` and the Quaternius Universal Base Characters and Modular Character Outfits packs (`git lfs pull --include="assets/authored/redbrand-kit.blend,assets/canonical/quaternius.universal-base-characters-standard.*/**,assets/canonical/quaternius.modular-character-outfits-fantasy-standard.*/**"`). KTX2 encoding needs KTX-Software's `ktx` (`ASSET_TOOLING_KTX` or on `PATH`). It publishes the rolling release `redbrand-kit` (`redbrand.kit.tar`) from CI.

## Entries

| Key | Variant | What |
| --- | --- | --- |
| `redbrand.kit.outfit` | `default` | The whole figure in the Dark skin |
| `redbrand.kit.outfit` | `skin.light` | The same figure in the Light skin |
| `redbrand.kit.armor` | `default` | The rigid plates (`redbrand.belt` on `pelvis.armor`, `redbrand.bracer_l`/`_r` on `lowerarm_l.armor`/`lowerarm_r.armor`) |

Each figure is a complete character on the male Ranger figure's (`humanoid.ranger.male`) rig: the Peasant arms and feet, the Ranger head and the Redbrand garments. The Peasant shirt and legs, which the coat and trousers hide, are left out. The figure has the same 65 joints by name at the same rest pose, plus the coat skirt and scarf chain joints (`skirt_*`, `scarf_01`). It carries the face morph targets and the age and build keys. It ships **no clips**: play the Ranger default's clips by joint name, as for every Ranger outfit variant. The kit is male-only for now.

Measured on the first build: 22,442 triangles per figure and 2,544 for the plates. The tar is 11.7 MB; most of it is the figure's 1024 px body, outfit and head textures.

## Descriptor

The `redbrand-descriptor` attachment (on `redbrand.kit.outfit/default`, schema `redbrand-kit-descriptor-v1`) contains:

- `outfits`: one record in the Ranger `humanoid-appearance` `outfits[]` shape, id `outfit.redbrand`, with:
  - `skins` naming the kit entry and variant per skin (`{ id: "skin.dark", entry: "redbrand.kit.outfit", variant: "default" }` and so on);
  - `base.hidden`;
  - `armor` (entry `redbrand.kit.armor`, the pieces with their sockets);
  - `garments`;
  - the `secondary` chains;
  - `faction` (material `faction` and its default colour).
- `morphs`: the variants carrying the face morph targets (`face.nodes`, `face.variants`) and the age and build keys (`variety.variants`, `variety.entries`). A consumer merges these into the Ranger appearance's `face.variants`, `ages.variants` and `builds.variants`/`entries`.
- `rig`: the joint count and the hash of the Ranger rig the figure keeps.

Adopting the kit is a loader switch. Take the outfit record from the kit and load its entries from the `redbrand-kit` bundle instead of the `humanoid-ranger-male` release. Presets, faction tint, face, morphs and clips stay as they are.

## How it is built

- **Geometry** (Decision 3.1.3) is hand-authored in `assets/authored/redbrand-kit.blend` (Git LFS):
  - collection `redbrand.cloth` holds one mesh per garment node, weighted by vertex groups named after the Ranger's joints;
  - collection `redbrand.plates` holds one mesh per plate;
  - every object sits at identity in the character's rest space, and its JSON custom property `redbrand` names its piece, material slots, hidden base nodes and, for a plate, its joint;
  - the file holds no third-party bytes: no Quaternius body, head or armature.
- **History of the geometry:** it was seeded from `armor.py`'s redbrand output. It was then shaped in Blender: the scarf became a shoulder mantle that drapes over the coat's shoulders and carries the faction colour at the game camera, its weights blend into the coat's torso and clavicle weights so the arms move under it, and the hanging end is longer.
- **`adapters/blender/redbrand.py`** loads `armor.py` as a declared Python input for the palette and the plates' occlusion bake. It then:
  - imports the fit target's armature;
  - skins the garments to it (`cloth`), or bakes the plates (`plates`);
  - writes observations in `armor.py`'s shape.
- **`scripts/build-redbrand-kit.ts`** builds the rest as the Ranger build builds its Peasant-based outfits, from the same catalog members through the same cached operations:
  - the body and head subset, the face variants and the Light skin transfer;
  - the Peasant outfit in both skins and the fit target;
  - the compose, the texture resize to the Ranger's sizes, the age and build keys and the chains;
  - the Ranger rig check.

  Every texture then becomes KTX2 (`KHR_texture_basisu`), encoded like the crag kit and the terrain (`TERRAIN_KTX2`): UASTC sRGB base colour, UASTC normals, ETC1S linear data maps.
- **Determinism:** the release build uses the shared generation and operation cache (`docs/cache.md`, #516). Two builds, one with the shared cache and one with an empty cache, gave the same tar. `test/blender/redbrand/redbrand-kit.test.ts` builds twice and compares.

To shape the garments again, append the two collections into a scene of a live Blender next to the Ranger fit target and edit them. Then write the collections back into the `.blend` with their `redbrand` properties and no armature modifiers or parents. Rebuild, and look at the result at the game camera before merging.
