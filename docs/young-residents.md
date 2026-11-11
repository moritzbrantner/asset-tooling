# Young residents

Children and teenagers for the humanlike games, mmorpg and arpg ([#556](https://github.com/moritzbrantner/asset-tooling/issues/556), Decision 1.1.4). The rolling release is `young-residents`, and no game places the kit yet. It is built by [`scripts/build-young-residents.ts`](../scripts/build-young-residents.ts) from the recipe [`adapters/blender/young_residents.py`](../adapters/blender/young_residents.py).

## Contents

| Entry | Figure | Age | Height | Head | Clothes | Triangles |
| --- | --- | --- | --- | --- | --- | --- |
| `young-residents.kit.teen-boy` | Teen boy | about 14 | 1.66 m | male | tunic, trousers | 18,320 |
| `young-residents.kit.teen-girl` | Teen girl | about 14 | 1.55 m | female | tunic, long skirt | 20,104 |
| `young-residents.kit.child-boy` | Boy | about 8 | 1.30 m | male | tunic, trousers | 18,791 |
| `young-residents.kit.child-girl` | Girl | about 8 | 1.25 m | female | tunic, long skirt | 20,482 |

Sources are the CC0 Quaternius `Male_Peasant` outfit and Universal Base Characters heads and pack hair, already in the catalog. The figures are always dressed. Only the head and neck are kept from the base body, the same subset as the adult Ranger, and the test fails if a head vertex is bound to anything below the neck. The skirted figures drop the trousers instead of hiding them. The adult female outfit's fitted corset isn't used.

## Frames and rig

Metres, +Y up, right-handed, feet on the ground at the origin, facing +Z. Each figure has the adults' 65-joint rig: the same joint names and the same joint rotations as `humanoid.ranger.male`, at the figure's own joint offsets. The age proportions are baked into the rest pose, as a per-bone width and length (`PROFILES` in the recipe).

**Clips:** play the `humanoid.ranger` clips by joint name. Use their rotation tracks, and the pelvis translation track multiplied by the figure's `pelvisScale` in the descriptor; drop any other translation track. The slider page does this with `Idle_Loop` and `Walk_Loop`.

**Levels and collision:** characters ship no levels of detail (Decision 1.4.2). The kit declares no collision: a figure uses the game's character capsule, scaled to its height.

## Materials and textures

Seven materials, all KTX2-textured except the skirt: `skin`, `hands`, `hair`, `brows`, `eyes`, `outfit` and `skirt`. These are skinned figures rather than batched scenery, so they keep the Ranger family's separate materials instead of one atlas. The kit costs at most 9 draw calls per figure, 26.7 MB of texture memory and an 18.6 MB download.

A consumer tints with the material's base colour, in linear values:

| Material | Colour |
| --- | --- |
| `skin`, `hands` | a skin tone from `skinTones` |
| `hair` | a colour from `hairColours` |
| `brows` | the hair colour × 0.75 |
| `outfit`, `skirt` | `look.cloth`, `look.skirt` |

## Sliders

Every figure's `head`, `eyes` and `brows` carry the same 21 morph targets. A weight runs from -1 to 1, and 0 is the unchanged source head. The targets are listed in the descriptor's `morphs.groups` (the `young-residents-descriptor` attachment on the first figure):

| Group | Targets |
| --- | --- |
| Face | `low_face`, `face_w`, `jaw_w`, `chin_w`, `chin_len`, `cheek`, `cheekbone` |
| Eyes | `eye_size`, `eye_space`, `eye_tilt`, `eye_open`, `lid_full` |
| Nose | `nose_size`, `nose_bridge`, `nose_w`, `nose_len` |
| Mouth | `lips`, `mouth_w`, `smile` |
| Brows | `brow_h`, `brow_ridge` |

Each figure's `look` gives its starting weights and colours. `peoples` are five starting points that add offsets to a figure's weights and pick a skin tone: Norrmark, Ashplain, Sunmarch, Tidewater and Saltisle. The names are placeholders. The offsets are anatomy, kept moderate so they don't turn into caricature.

The page at [`compare/young/`](https://moritzbrantner.github.io/asset-tooling/compare/young/) has a live slider for every target, the peoples, skin and hair swatches, the Ranger's idle and walk clips, and a copy button for the values. It reads the descriptor from the rolling release and shows a notice until the first one exists.

## Edit

The tables at the top of the recipe set the proportions (`PROFILES`), each figure's head, hair, height and painted detail (`FIGURES`) and the skirt (`SKIRT_RINGS`, `SKIRT_SWING`). `slider_fields` holds one displacement per slider, placed on the landmarks of [`face_variants.py`](../adapters/blender/face_variants.py). The looks, skin tones, hair colours and peoples are tables at the top of the build script.

`test/blender/young-residents/young-residents.test.ts` checks the bundle, the adult joint rotations, the heights, the morph targets, the head subset, the cost limit and that two builds are byte-identical. Review images are in [`review/young-residents/`](../review/young-residents/).

**Known limits:** the hair is straight only; curly, coily and braided styles are [#557](https://github.com/moritzbrantner/asset-tooling/issues/557). The tunic's texture has faint chest shading painted for an adult. Extreme slider combinations can look angular.
