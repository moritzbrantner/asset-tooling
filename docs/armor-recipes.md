# Soldier and knight armour, resident clothes and class outfits

[`adapters/blender/armor.py`](../adapters/blender/armor.py) (with `src/armor-recipes.ts`) authors the [#117](https://github.com/moritzbrantner/asset-tooling/issues/117) soldier and knight outfits. It runs through the pinned Blender script backend ([blender-script.md](blender-script.md)) and follows the owner answers of 2026-10-17. The male figure comes first (Q8).

- **Archer:** the existing Ranger outfit, which is the character's `default` variant.
- **Soldier:** the Quaternius Peasant outfit, with an original gambeson-style tunic over it, a kettle hat, a belt and front greaves. The sash carries the faction colour.
- **Knight:** the Peasant outfit, with original plate over it: bascinet, breastplate, spaulders and pauldrons, couters, gauntlets, cuisses with knee cops, greaves and sabatons. The tabard carries the faction colour.

The pieces are scripted originals following the [humanlike style spec](style-humanlike.md). They are not copied from any game or pack, and they use factor-only materials: `steel`, `iron`, `leather`, `gambeson` and the `faction` slot. The faction slot defaults to muted dark red (linear 0.25/0.04/0.04, Q11), and a consumer recolours it through the material's base-colour factor.

## Refinements (#301)

After the owner's first review, the knight's shapes were reworked:

- **Bascinet:** an analytic skull fitted to the head's extents, no longer a scan of the head. It is a rounded dome that narrows to a point set back over the crown. The sides and back fall almost straight to the jaw and nape, flaring slightly at the rim. The face opening is an arch whose top follows the brow and whose sides drop toward the cheeks.
- **Shoulders:** a **spaulder** (the shoulder cop) rides `clavicle_*` through a new `clavicle_*.armor` socket, so it stays on the shoulder when the arm hangs or rises. The **pauldron** lames below it ride the upper arm and slide under the cop.
- **Gauntlets:** a mitten shell over the whole hand and fingers, closed at the fingertips, plus the flared cuff.
- **Breastplate:** finer sampling and a central keel down the front.
- **Rims:** the finishing bevel is 4 mm with three segments, so the plate edges read as rolled rims.
- **Tabard:** shaped cloth instead of flat boards (see Outputs).
- **Skins:** the soldier and knight are built for both skins: `outfit.<kit>` (Dark) and `outfit.<kit>.skin.light` (Light, with the same derived skin texture as the Ranger). Each outfit in `humanoid-appearance` lists its `skins`.

## Motion fixes (#309)

- **Tabard:** the panels rise above the breastplate's rim and also clear the breastplate's own surface (keel and rim) by 18 mm. Only the strips that bridge the shoulders open for the neck, so no slot shows across the chest. The lower folds are deeper and slightly irregular, and the hem rises and falls with them.
- **Soldier greaves:** fitted only to vertices fully on the calf, starting below the knee, with 8 mm clearance. The bending knee and the boot cuff no longer push them off the shin in the walk.
- **Sash:** like the tabard, it ignores arm and shoulder joints, and it rides `spine_03` over the shoulder, so the arm swing doesn't lift it.

## Cloth drape (#314)

- **Tabard:** the drape is a Blender cloth simulation, baked into the rest shape. The panels are cut wider (23 columns) and stay pinned where they ride the breastplate. Just below the breastplate's rim they are gathered to 78% of their width at the hips, while the springs keep the cut lengths, so the skirt below buckles into real folds as it settles over the body and the breastplate (72 frames, colliders only during the build). The settled positions are rounded to 0.01 mm. The skinned weights and the clearance over the breastplate are unchanged. Per-pose corrections (shape keys) are not baked yet.

## Resident outfits (#376)

The same recipe dresses the named Greyhaven residents ([humanoid-ranger.md](humanoid-ranger.md#resident-presets)). These are plain clothes over the Peasant outfit, scripted originals with factor-only materials: `smock` (plant-dyed green), `linen` (off-white), `habit` (dark brown wool) and `rope`.

| Kit | Cloth | Plates | Hides |
| --- | --- | --- | --- |
| `farmer` | `farmer.smock`: the Peasant shirt pushed 10 mm out, with a fitted skirt to above the knee | `farmer.belt` (rope) | the shirt |
| `innkeeper` | `innkeeper.apron`: a bib from the chest to the waist, then a wider skirt to mid-thigh that hangs straight, with soft folds | `innkeeper.belt` (leather, over the apron) | nothing |
| `monk` | `monk.habit`: the shirt pushed 12 mm out, with a skirt to the ankle that widens toward the hem | `monk.belt` (rope) | the shirt |

- **Skirts in motion:** the skirts blend their weights toward `pelvis` from the waist down to the hem (`SETTLE`: smock and apron 30 %, habit 60 %), then each side follows the thigh on its side (`STRIDE`: smock 100 %, apron 80 %, habit 60 % at the hem), so a striding knee does not push through; only a strip 3–5 cm either side of the middle blends between the thighs. The apron, like the tabard, ignores arm and shoulder joints.
- **Facial hair:** the #376 beard kit is gone; the hand-modelled beards and moustaches of `adapters/blender/hair_beards.py` replace it under the same names ([Male variety](humanoid-ranger.md#male-variety-380)).
- **Straw hat:** the farmer's hat is a [headwear](humanoid-ranger.md#contents) piece (`hat.straw` in `adapters/blender/headwear.py`), so any outfit can wear it.

## Redbrand bandit (#389)

mmorpg's Redbrand bandits get their own outfit (`outfit.redbrand`, male figure) instead of the soldier's gambeson with a red sash. It follows the Greyhaven Marshal's style: a long coat, straight trousers and functional boots.

| Kit | Cloth | Plates | Hides |
| --- | --- | --- | --- |
| `redbrand` | `redbrand.coat`: the shirt pushed 14 mm out in rough dark oxblood wool (`coat.redbrand`), with a skirt to mid-calf (0.32 m) that widens toward a ragged hem and is open at the front below the belt, the split widening toward the hem; `redbrand.sleeves`: long sleeves in the coat's wool; `redbrand.trousers`: the straight brown work trousers over the boot shafts; `redbrand.scarf` and `redbrand.scarf-end`: a thick wrap rolled round the neck with its loose end down the left of the chest, in the `faction` slot | `redbrand.belt`, `redbrand.bracer_l`, `redbrand.bracer_r` (leather) | the shirt, the legs |

- **Band colour:** the scarf is the outfit's `faction` slot (default `ARMOR_FACTION`), so mmorpg's `REDBRAND_RED` recolours it like the soldier's sash; the coat stays oxblood.
- **Coat in motion:** the skirt settles 60 % toward the pelvis down to its hem and each side follows its thigh by up to 70 % (`SETTLE`, `STRIDE`).
- **Headwear:** any [headwear](humanoid-ranger.md#contents) piece; the crossbowmen can keep the kettle-hat look with `equipment.helm.ironcrest` or go bareheaded.

## Tanner (#378)

Tanner Hilda Brook is the female figure's resident (decision C on #376): the pack's `Female_Peasant` outfit (bodice, cream sleeves, work gloves, slim trousers and boots), promoted to the catalog like `Male_Peasant`, with the kit `tanner` over it. The recipe fits the female base when the kit is a female kit (`FEMALE_KITS`; `use_figure` switches the base mesh names to `Female_Peasant_*` and the head to `Superhero_Female`).

| Kit | Cloth | Plates | Hides |
| --- | --- | --- | --- |
| `tanner` | `tanner.skirt`: an ankle-length work skirt (green-grey wool) fitted round the hips like the monk's habit, with a wider hem; `tanner.apron`: a long tan leather apron from the chest to mid-shin, over the skirt | `tanner.belt` (leather, over the apron) | nothing |

- **Skirt:** the slim trousers stay under it (owner style rules: no short skirts or leggings; only the boots show). It uses the habit's `SETTLE` and `STRIDE` weights.
- **Apron:** the innkeeper's apron cut (`apron_surface`) with a lower hem, a 20 cm half-width below the waist, and the skirt's surface as an extra clearance target. Three smoothing passes even out the depth across each row, so the leather shows broad folds instead of the legs under it. Below the waist it settles 40 % toward the pelvis and each side follows its thigh by up to 60 %.
- **Materials:** `skirt.wool` (linear 0.045, 0.055, 0.04) and `leather.tan` (0.16, 0.075, 0.03); the belt is the shared `leather`.

## Class starter outfits (#379)

Each mmorpg class starts in its own outfit, in the Greyhaven Marshal's style (owner decisions on #379, 2026-10-25). The kits are `class.warden`, `class.ranger`, `class.arcanist`, `class.necromancer`, `class.rogue`, `class.cleric` and `class.druid`, all over the Peasant base, with factor-only materials. Every kit has a recolourable `class` material whose default is the class colour (the cloth receipt's `classTrim`). It sits on a piece that armour drops would not replace, so the class still reads: the Warden's tabard, the Ranger's and Rogue's sashes, the Arcanist's and Necromancer's mantles, the Cleric's tabard edging and the Druid's leaves.

| Kit | Cloth | Plates | Hides |
| --- | --- | --- | --- |
| `class.warden` | the knight's tabard in the class colour | the knight's plate, bascinet included | nothing |
| `class.ranger` | hip-length jerkin, straight work trousers, long sleeves, class sash, hood, hooded cloak open at the chest | leather belt and bracers | shirt, legs |
| `class.arcanist` | long robe, bell sleeves, mantle | gold sash belt, high collar | shirt |
| `class.necromancer` | long robe with a tattered hem, tattered sleeves, tattered mantle, peaked hood | belt, bone-bead collar, shoulder spikes, skull clasp | shirt |
| `class.rogue` | charcoal jerkin, work trousers, long sleeves, class sash, cowl hood, one-shoulder cape | belt, half-mask, two-tone forearm wraps | shirt, legs |
| `class.cleric` | ivory robe, fitted sleeves, white tabard edged in the class colour | gold belt, spaulders, cuffs and sun | shirt |
| `class.druid` | moss robe, frayed sleeves, bark mantle with leaf cards | rope belt, antler circlet | shirt |

The owner's rules for the set: no short skirts or leggings on anyone, only plain functional boots (the Peasant boots, or the knight's sabatons), and long robes that differ by sleeves, overcoats, hoods, collars, belts, colour and props.

- **Robes** are the monk habit's cut (the shirt pushed 12 mm out, a skirt to the ankle) with the same `SETTLE` and `STRIDE` weights.
- **Jerkins and trousers:** the jerkin is the shirt pushed out with a skirt to the hip. The trousers are the Peasant legs pushed 8 mm out. Below the knee they widen into a straight tube around the boot shaft, and they lengthen to 13 cm above the ground, so they fall over the boots instead of tucking in.
- **Sleeves** are cut from the Peasant arms between the shoulder and the wrist and pushed out, so they keep the arms' own weights. The cuff is extruded past the wrist and opens by a flare. A tattered cuff ends in uneven points.
- **Mantles, the cloak and the cape** (`drape_surface`) are rings around the torso from the neckline to a hem that runs from a front height to a back height. Each ring clears the torso and shoulder caps. Going down, a ring never narrows faster than a slope, so the cloth falls from the shoulders and shoulder blades instead of following the small of the back. The rings are widened over the spine's groove before the clearance is added. An arc leaves the chest open (the Ranger's cloak) or keeps one shoulder (the Rogue's cape), and the cloth over the sides stays outside the hanging arms. They ride the torso, `spine_03` above the chest, and ignore the arm joints below the clavicle. The cloak's back settles toward the pelvis below the waist.
- **Hoods** (`hood_surface`) are soft domes fitted to the head's extents, with a peak that falls back over the crown, an open face from the chin to the brow and a drape that rests on the shoulders. They ride `Head` above the chin and blend into the neck and chest below it. Each hood is listed as an `outfit.hood` part node, so hair that needs the hood off hides under it.
- **The Cleric's tabard** is the knight's tabard cut and settled over the robe instead of a breastplate (the robe is a collider). Its side columns and hems take the `class` material.
- **The Necromancer** also has a pale grey skin, `outfit.class.necromancer.skin.grey`: the Light body and outfit skin textures turned to a cool grey by luminance, so their painted shading stays.

The renders of the set are made with [`examples/class-outfits/review.py`](../examples/class-outfits/review.py) from a built bundle. It renders the line-up at the mmorpg game camera (12 m, 0.42 rad pitch, 50° vertical field of view, pivot 0.6 m), a front close-up per class and a walk frame per class from the front and from behind.

## Fitting

The recipe's declared input `target` is the base character at rest: the Peasant outfit composed with the head subset on the shared 65-joint skeleton. Each piece is fitted to the real geometry under it:

- It selects the rest-pose vertices skinned to its joints. For example, the greave uses the vertices skinned to `calf_l`, which include the boot.
- It samples them in rings around an axis between two joints and keeps the outermost radius in each angular sector.
- It fills empty sectors, dilates and smooths the radii, and adds a clearance.
- It builds a closed plate: the fitted outer surface, an inner surface offset by the plate thickness, and a band on every open edge. Open edges come from partial angular ranges (front greaves, cuisses, sabatons) or masks (the bascinet's face opening, the breastplate's armholes).

## Outputs

`arguments` is `{schemaVersion: 1, kit: "soldier" | "knight", output: "plates" | "cloth"}`.

- **`plates`** (Q2 = A, rigid pieces on single joints): one static GLB with one mesh node per piece, named `<kit>.<piece>`, for example `knight.pauldron_l`, each with an identity transform. Geometry is in the character's rest model space (metres, +Y up, facing +Z). Each piece rides one joint through that joint's `<joint>.armor` socket. The socket is the inverse of the joint's rest transform, the same idea as the hair's `head.hair` socket ([humanoid-sockets.md](humanoid-sockets.md#armour-sockets)), so a piece sits where it was fitted and then follows its joint.
- **`cloth`**: the garments that must deform with the body, skinned to the target's own joints:
  - the soldier's gambeson: the Peasant shirt's surface and skin weights pushed 12 mm out, plus a quilted skirt;
  - the soldier's sash;
  - the knight's tabard: front and back panels hanging over the breastplate and the cuisses. Below the waist they widen, are gathered at the hips and settle into folds in a cloth simulation (#314).

  The skirt, sash and tabard are fitted surfaces. Each vertex blends the weights of the nearest base vertices, and the tabard ignores arm and shoulder joints so that it rides the torso over the rigid breastplate. The build composes the cloth into the outfit variant with `scene.compose.skinned.gltf@1`.

The receipt observations list every piece with its kind (`rigid` or `skinned`), joint, triangle count, bounds, materials and the base mesh nodes it hides.

## Hidden body regions

Each piece declares which base mesh nodes it completely covers (Q12). The build leaves those nodes out of the outfit variant with `scene.subset.skinned.gltf@1`.

| Piece | Hides |
| --- | --- |
| `soldier.gambeson` | `Male_Peasant_Body` (the shirt; the gambeson replaces it, sleeves included) |
| all other pieces | nothing |

The plates sit over the Peasant clothing with 1–2.5 cm of clearance instead of hiding it. Hiding the legs or arms under jointed plates would open holes at the knees and elbows, where no rigid plate covers the bend.

## In the Ranger bundle

The Ranger bundle ([humanoid-ranger.md](humanoid-ranger.md#contents)) builds the soldier and knight like this:

1. It composes the fitting target from `Male_Peasant` and the head subset.
2. It runs both outputs for every outfit kit (soldier, knight, the [resident kits](#resident-outfits-376) and the class kits).
3. It composes each outfit variant: the Peasant base without its hidden nodes, then the head and the kit's cloth. The variant gets the same retargeted clips; the build checks that its joints match the Ranger rig before embedding them.
4. It ships the variants as `humanoid.ranger.male/outfit.<kit>`.
5. It ships the plates as the entries `armor.<kit>`. The outfit variants and their plates carry the age and build morph targets ([Male variety](humanoid-ranger.md#male-variety-380)).

The `humanoid-appearance` attachment gains `outfits`. Each outfit lists its character variant, its armour entry with every node and its socket, its garments, the hidden base nodes and (soldier and knight) the faction slot.

## Finishing

Under Atlas Decision 5.1.6, every rigid plate goes through Blender finishing before export (`finish_plate`):

- a 4 mm, three-segment **bevel** on edges sharper than 40°, so rims catch light instead of reading as knife edges;
- **weighted normals** that keep sharp edges, so large faces shade flat and clean.

- **ambient occlusion** (owner answer on #120, option A): a Smart-UV unwrap and pack (2 % island margin), then a 512 px AO bake in Cycles (64 samples, 8 cm distance, fixed seed). The other plates and the body under the plate occlude it. The map is bound as the glTF `occlusionTexture`, through the exporter's `glTF Material Output` group, on a per-piece copy of the material, for example `steel.knight.pauldron_l`.

The modifiers are applied, and the observations report the finished triangle count. Blender's own renderer ignores glTF occlusion, so the AO shows in glTF viewers and in three.js (`aoMap`), not in the Blender sheets. Armour sheets light the scene with a procedural sky (`--armor`). Steel reflects its environment and reads as metal only against one with contrast; a flat grey world made it look white.

## Review

The pose sheets are rendered with `examples/weapons/socket-sheets.py` and its `--armor=<armor.gltf>,<appearance.json>,<outfit id>` option. The poses are idle, walk, `Sword_Regular_C` (raised arm), `Crouch_Idle_Loop` (deep knee), `Idle_Shield_Loop` (shield) and `Spell_Simple_Idle_Loop` (both arms forward). The free libraries have no bow draw clip (#277), so a bow pose can't be shown yet.

Known limits of this first candidate:

- The sabatons ride `foot_*` only, so the toe plate does not bend with the toes.
- The mitten gauntlets follow the fingers' rest pose, which is spread. The bone maps never move the fingers, so the shells fit, but the hands look wide.
