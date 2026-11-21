# Resident clothing kit

Everyday garments for Greyhaven's residents in the humanlike games, mmorpg and arpg ([#560](https://github.com/moritzbrantner/asset-tooling/issues/560)): adults, teenagers and children. The rolling release is `resident-clothing` (`resident-clothing.kit.tar`), and no game places the kit yet.

```sh
git lfs pull --include="assets/canonical/quaternius.modular-character-outfits-fantasy-standard.*/**"
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-resident-clothing.ts --out <directory>
```

KTX2 encoding needs KTX-Software's `ktx` (`ASSET_TOOLING_KTX` or on `PATH`).

The owner decided all four questions on #560: all seven garment types; garments layered only where a layer shows, with authored folds and the existing #391 accessory chains and no simulated cloth; mostly shared poor and better-off cuts with one or two distinct better-off silhouettes; and the work aprons belong to this kit. The mockup is on the branch `mockup/560-resident-clothing`.

## Entries

Each entry is one piece, `resident-clothing.<piece>`. Its variants are the fits it is made for, and the finish when it is not plain: `female`, `female.poor`, `female.fine`.

| Piece | Fits | Finishes | Hides | Chains | Triangles |
| --- | --- | --- | --- | --- | --- |
| `smock`: fitted yoke with a smocked band, the body gathered from it into deep folds above the knee, full sleeves into cuffs | child boy, child girl | plain, poor, fine | body | none | 4,448–4,656 |
| `smock.long`: the smock dress, the same yoke with the body to mid-calf | child girl, teen girl | plain, poor, fine | body, legs, skirt | 4 skirt | 5,024–5,424 |
| `pinafore`: linen bib and front skirt, shoulder straps crossing to the back, waist ties | child girl, teen girl | plain | none | apron | 774 |
| `shirt`: linen collar, yoke and sleeves; the body under the jerkin is left out | adult male, teen boy | plain, poor | none | none | 2,752–2,880 |
| `jerkin`: sleeveless leather, standing collar, front lacing, a short skirt pointed at the front | adult male, teen boy | plain | body | none | 3,496–3,754 |
| `chemise`: linen yoke above the kirtle's neckline and forearm sleeves; the rest is left out | adult female, teen girl | plain, poor | none | none | 2,208–2,304 |
| `kirtle`: fitted, laced bodice; a gathered skirt with cartridge pleats at the waist relaxing into deep folds, its hem rising over the valleys | adult female, teen girl (high neck, easy bodice, full sleeves) | plain, poor, fine | body, legs, skirt | 4 skirt | 7,716–10,100 |
| `tunic`: loose and knee length, gathered under the belt, long sleeves | adult male, teen boy | plain, poor, fine | body | 4 skirt | 5,056–6,080 |
| `apron.leather`: the smith's heavy bib apron to the knee, neck strap and waist ties | adult male, adult female | plain | none | apron | 680 |
| `apron.half`: the innkeeper's linen half-apron with waist ties | adult male, adult female | plain | none | apron | 506 |
| `belt.rope`: knotted at the front with two hanging ends | every fit | plain | none | none | 864 |
| `belt.leather`: with a brass buckle and a pouch at the hip | adults, teens | plain | none | none | 528 |

**Finishes.** `poor` has faded cloth, sewn-on patches, darns and a shorter, frayed, uneven hem. `fine` has fine wool with an embroidered hem band and trimmed cuffs and neckline. Most finishes share the cut. The better-off adults have two distinct silhouettes (owner decision on #560 Q3), checked at the game camera: the **gown** (`kirtle` `female.fine`), a fuller floor-length skirt with 22 folds and bell oversleeves, and the **long tunic** (`tunic` `male.fine`), to mid-calf and fuller. The teen and child `fine` variants keep their everyday cut.

**Looks.** The descriptor's `looks` are the ten showcased looks of the mockup: child's smock, smock dress and pinafore, teen jerkin and shirt, teen kirtle, kirtle, patched kirtle, the better-off gown, patched work tunic, the better-off innkeeper (long tunic, leather belt and half-apron) and the smith (tunic and leather apron), each with a dye.

## Wearing a piece

- **Rig:** every variant is one skinned glTF scene on its fit's 65-joint rig at rest, plus the piece's own chain joints. Bind its joints to the figure's by name and play the figure's clips. The adults are `humanoid.ranger.male` and `humanoid.ranger.female` in their Peasant-based resident outfits; the young fits are the [young residents](young-residents.md) (`young-residents.kit.<figure>`), whose joints the build test checks to within 0.1 mm.
- **Hides:** a variant's `hides` names the figure's mesh nodes it replaces (`Male_Peasant_Body`, `Female_Peasant_Legs`, `outfit.body`, `skirt`, …). Hidden parts are not drawn, so nothing underneath can poke through.
- **Requires:** the jerkin needs the shirt (the jerkin is sleeveless and replaces the body); the adult kirtle needs the chemise (its scooped neckline shows it). `requires` lists them.
- **Layers:** aprons, the pinafore and belts are fitted over the garments in `over`, in the same fit: the leather apron over the tunic or jerkin (male) or the kirtle (female), the half-apron also over the long tunic, the pinafore over the smock dress, and belts over everything at the waist. A layer worn over something else may clip.
- **Chains (#391):** skirts carry `skirt.front`, `.back`, `.left` and `.right` from `pelvis` (joints `skirt_f_01` …, swing 20°); aprons and the pinafore carry `apron` (`apron_01` …, swing 15°). They come with the piece; a consumer springs them on top of the clips, and left at rest they deform nothing. They are listed per variant in `secondary`, in the Ranger's `{ id, kind, parent, joints, swingLimitDegrees, nodes }` shape.
- **Builds:** the pieces carry no `build.lean` or `build.heavy` morph targets yet, so they fit the average build.

## Materials and textures

Two materials over one atlas: `cloth` shows linen, leather, trims, rope and brass as they are, and `cloth.dyed` (the wool kirtles and tunics, the smocks) is tinted by multiplying its base colour factor with a dye from `materials.dyes` (undyed, madder, woad, weld, green, brown, grey). Every piece is opaque and single-sided; hems, cuffs and necklines are turned inside, so their edges show a thickness.

The atlas is painted by the recipe (`paint_atlas`): 2048 px, 4 × 4 cells of 512 px, each a 416 px tile wrapped into a 48 px gutter. The cells are wool, linen and leather in plain, poor (patches, darns, stains) and fine weaves; embroidered, braided, madder and woad trim bands; rope; brass; honeycomb smocking; and front lacing. A 1024 px normal map comes from the same height field. Base colour is ETC1S, the normal map UASTC.

Measured on the first build: 50 variants, 2 materials, 6.7 MiB of texture memory, an 11.1 MiB download and the largest variant 10,100 triangles (the gown). The `budget` in `releases/resident-clothing.json` is 2 materials, 7 MiB and 12 MiB. A dressed figure stays near the young residents' 18–20k triangles, because each piece replaces the parts it hides. Characters ship no levels of detail (Decision 1.4.2), and garments have no collision.

## How it is built

[`adapters/blender/resident_clothing.py`](../adapters/blender/resident_clothing.py) runs once per fit. Its inputs are the catalogued CC0 Quaternius `Male_Peasant` or `Female_Peasant` outfit (glTF and buffer only), read as the fit target and never shipped, and [`young_residents.py`](../adapters/blender/young_residents.py), whose `PROFILES` carry the male outfit to each young figure exactly as that kit bakes it (`FITS` holds the figure's overall scale).

- **Shells.** A garment is rings round the body. Fitted parts (`torso`, `sleeve`) are cast onto the body's outermost surface plus a clearance, smoothed so they rest on the outfit underneath instead of copying its folds, and take the skin weights of the body under them, so they move with it. Ease is added after: the tunic blouses above its belt, the smocks' sleeves are full.
- **Skirts** (`skirt`) hang from the fitted waist or yoke. Going down they never narrow, they clear the legs and boots, and authored folds (`tube_folds`: tubular folds, round outside and creased in the valleys, with cartridge pleats at the waist) multiply the radius. Their weights settle on the pelvis and follow each thigh more toward the hem; long skirts blend the thighs across the front and back and hand part of the share below the knee to the calves, so a bent knee carries the skirt back with the boot.
- **Layers** (`hanging_panel`, `strap`, `ring_band`) are fitted over the body and the garments named in `OVER`.
- **UVs** are in metres, mapped into each face's atlas cell by whole repeats (`atlas_uv`). A face that still overhangs its gutter, a stretched face under a T-posed arm, is squeezed into its cell; the build fails if more than 2 % of a piece's faces need that, and the descriptor reports `squeezedFaces` per variant.
- **Settings** are tables and arguments at the top of each garment function (lengths, ease, fold counts and depths, stride and calf shares). All randomness is seeded.

[`scripts/build-resident-clothing.ts`](../scripts/build-resident-clothing.ts) imports each fit's output, splits it into one scene per variant, adds the chains with `addSecondaryChains`, adds `COLOR_0` and tangents, encodes the textures as KTX2 and writes the `resident-clothing-descriptor` attachment (schema `resident-clothing-kit-descriptor-v1`, on `resident-clothing.smock/child-boy`): `rig`, `fits` (figure, source, the nodes a piece may hide and the landmarks it was fitted from), `materials` and `dyes`, `finishes`, `pieces` with every variant's fit, finish, cut, node, triangles, materials, `hides`, `requires` and `secondary`, and `looks`.

`test/blender/resident-clothing/resident-clothing.test.ts` checks the bundle, every variant's rig, rotations, young joint positions, chains, materials and lighting attributes, the cut of the better-off silhouettes, the budget and that two builds are byte-identical.

## Review

Review images are in [`review/resident-clothing/`](../review/resident-clothing/): `sheet.jpg` (the ten looks in the idle pose), `game.jpg` (the Greyhaven game camera, 12 m, 0.42 rad pitch, 50°, front and behind, native-pixel crops), `close-<look>.jpg` (front, three-quarter and back) and `poses-front.jpg` / `poses-back.jpg` (every look in idle, two walk frames, the run, a crouch, the sword attack, overhead smash and whirl, and a spell cast). They were rendered from the recipe outputs on the Peasant outfits and the young residents, with flat skin, untextured adult heads without hair, and the looks' dyes.

**Known limits.** At the peak of a run or a deep lunge, an ankle-length skirt (the kirtle, the gown, the smock dress) stretches between the legs, and the forward knee can press against its front: linear skinning without cloth can't do better, and the chains add the swing. The garments follow the average build only. The adult male's Peasant arms are full, so his sleeves are too.
