# Textured hair kit

Curly, coily and braided hairstyles for the humanlike games, mmorpg and arpg ([#557](https://github.com/moritzbrantner/asset-tooling/issues/557)). The catalogued hair is all straight; these pieces are original, shaped after how the hair actually grows and sits. They are separate from the young residents so adults can wear them too. The rolling release is `textured-hair-kit` (`textured-hair.kit.tar`), and no game places the kit yet.

```sh
git lfs pull --include="assets/canonical/quaternius.universal-base-characters-standard.superhero-*-fullbody-*/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-textured-hair-kit.ts --out <directory>
```

KTX2 encoding needs KTX-Software's `ktx` (`ASSET_TOOLING_KTX` or on `PATH`).

## Entries

Each entry has a `male` and a `female` variant, fitted to that head. Owner decisions on #557: all six styles, the box braids both loose and tied back at shoulder length, the mockup's proportions, and opaque geometry.

| Key | Look | Triangles (male / female) | Chains |
| --- | --- | --- | --- |
| `hair.short-coils` | Close coily crop, shorter at the sides and nape | 1,080 / 1,080 | none |
| `hair.rounded-afro` | Round afro, about 5 cm out at the crown, trimmed at the nape | 2,072 / 2,072 | none |
| `hair.cornrows` | 20 straight-back plaits from the whole hairline, the scalp showing in the parts, short braided ends at the nape | 2,900 / 2,840 | none |
| `hair.box-braids` | About 48 square-parted braids from a centre part, falling to the shoulders | 4,460 / 4,332 | `braids_back`, `braids_left`, `braids_right` (3 joints each) |
| `hair.box-braids-tied` | The same braids drawn back into a low tail with a leather tie | 4,356 / 4,348 | `hair_tail` (2 joints) |
| `hair.loose-curls` | A curly cap with about 30 ringlets, jaw length at the sides and to the nape behind | 4,304 / 4,312 | `curls_back` (2 joints) |
| `hair.curly-bun` | Coils drawn up into a curly puff on the crown, with a tie | 1,212 / 1,212 | none |

Every piece sits on the same hairline: the forehead, the temples, in front of, above and behind the ears, and the nape, placed from each head's own brows and ears.

## Attaching a piece

Each entry variant is one static-rest, skinned glTF scene: the mesh node (named as the key) and a `Head` joint at that figure's head rest pose, plus the piece's chain joints below `Head`. A piece carries no clips.

- **Adults:** use the variant for the figure's head (`male` for `humanoid.ranger.male`, `female` for `humanoid.ranger.female`). Put the scene under the figure's `head.hair` socket, which is the inverse of the head's rest transform, so the piece's `Head` lands on the figure's `Head`; or bind the piece's joints to the figure's by name. This is the same contract as the [hair kit](hair-kit.md).
- **Young residents:** a young figure's head is an adult head scaled uniformly about its rig's `Head` rest. Its rig is the male skeleton for boys and girls alike, so the girls' female head was scaled about the male `Head`. Use `young.<figure>.fit`'s variant under the young figure's `Head` joint with the local transform `scale(young.<figure>.scale) × young.<figure>.socket` (the male `head.hair` socket, for every young figure). The scales were measured from the young-residents release: 0.945 teen boy, 0.89 teen girl, 0.906 boy, 0.898 girl.

A consumer springs the chain joints on top of the clips as for any Ranger accessory chain (`docs/humanoid-ranger.md`, #391). Left at rest they deform nothing. The scalp stays on `Head`.

Like every hairstyle, these need the hood off (`requires: { "outfit.hood": false }`). The afro and the bun stand well off the head, so `fitsUnderHeadwear` is false on them.

## Descriptor

The `textured-hair-descriptor` attachment (on `hair.short-coils/male`, schema `textured-hair-kit-descriptor-v1`) contains:

- `rig`: the `Head` joint, the `head.hair` socket and the attachment rule above;
- `fits`: for `male` and `female`, the figure, its `head.hair` socket and the head landmarks the pieces were placed from (brows, ear top and bottom, crown, neck), in metres up;
- `young`: each young figure's `fit`, `scale` and `socket`;
- `tints`: the Ranger hair tints (`tint.black`, `tint.brown`, `tint.blond`, `tint.grey`) as base colour factors;
- `hair[]`: per piece its `id`, `label`, `nodes`, `socket`, `joint` and `joints`, `variants`, `tintMaterials` (`MI_Hair_Textured`), `fixedMaterials` (`hair.tie` on the tied braids and the bun), `requires`, `fitsUnderHeadwear`, `secondary` (the chains per fit, in the Ranger's `{ id, kind, parent, joints, swingLimitDegrees, nodes }` shape) and `triangles` per fit.

The pieces carry no build or age morph targets yet: a figure's `build.lean` or `build.heavy` changes the head little, but the hair does not follow it.

## Materials, textures and cost

Two materials: `MI_Hair_Textured`, tinted with the material's base colour factor like the Ranger's hair, and `hair.tie`, a factor-only leather colour. Everything is opaque and single-sided. They share one procedural atlas, 1024 px, in three columns that each repeat along V: coils (two tiles wide, for the caps), ringlet strands and a three-strand plait (each wrapped once round a tube). The base colour is grey so the tint gives the colour (ETC1S), with a 512 px normal map (UASTC).

Measured on the first build: 1.75 MB of texture memory, a 2.2 MB download and a 2.2 MB tar, against a `budget` of 2 materials, 2 MB and 3 MB (`releases/textured-hair-kit.json`). Characters ship no levels of detail (Decision 1.4.2), and hair has no collision.

## How it is built

[`adapters/blender/textured_hair.py`](../adapters/blender/textured_hair.py) runs once per head. Its only input is the catalogued CC0 Universal Base Characters body (`Superhero_Male_FullBody`, `Superhero_Female_FullBody`, without its textures), used as the fit target and never exported.

- **Caps** (the coils, the afro, the curl cap, the bun's base and the braids' under-layer) are cast outward from a point inside the skull, column by column from the hairline up to a crown whorl, so they follow that head's shape. Each style sets its thickness: the afro rounds out to an ellipsoid above the hairline. The rim tucks a little under the skin so no gap shows.
- **Plaits and ringlets** are tubes. Cornrows run as lines of constant latitude about the ear-to-ear axis, converging a little at the nape. Box braids and ringlets hang as short ropes under gravity, kept outside the head, the neck and the upper back, and off the face. Loose braids are cut at the shoulders; tied braids run over the scalp to the tie and continue as a tail.
- **Settings** are at the top of each piece's function (thicknesses, counts, lengths) and in the hairline table in `Head`. All randomness is seeded.

[`scripts/build-textured-hair-kit.ts`](../scripts/build-textured-hair-kit.ts) imports each head's output, splits it into one scene per piece, skins every piece to a `Head` joint at that figure's rest (`bindToHead` from the hair kit), adds its chains with `addSecondaryChains`, encodes the textures as KTX2 and writes the descriptor.

`test/blender/textured-hair/textured-hair-kit.test.ts` checks the bundle, both variants of every entry, the `Head` joint at the rest pose, the chains, that the caps stay above the nape, the materials, the budget and that two builds are byte-identical.

## Review

Review images are in [`review/textured-hair-kit/`](../review/textured-hair-kit/): `sheet.jpg` (every piece on the adult male, the adult female and the young child girl), `close-<piece>.jpg` (front, three-quarter and back on each head) and `game.jpg` (the Greyhaven game camera, 12 m, 0.42 rad pitch, 50°, as a native 1080p crop, from the front and from behind). The figures there wear flat review materials and a darker skin; the hair is tinted dark brown.
