# Soldier and knight armour, resident clothes and beards

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
- **Beard kit:** `kit: "beard"` takes `output: "plates"` only. It fits `beard.full`, `beard.short` and `beard.moustache` to the head: each is a shell around the lower face whose radius follows the head's outermost vertices at each height and angle plus a clearance, hangs below the chin (it loses at most `slope` of radius per metre of height), and runs between a hem and a top edge that rise from the front to the sideburns. The moustache is a band over the upper lip whose ends droop past the mouth's corners. Every piece rides `Head` through the `head.armor` socket and has the `beard` material, which a consumer tints like the hair.
- **Straw hat:** the farmer's hat is a [headwear](humanoid-ranger.md#contents) piece (`hat.straw` in `adapters/blender/headwear.py`), so any outfit can wear it.

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
2. It runs both outputs for every outfit kit (soldier, knight and the [resident kits](#resident-outfits-376)), and the plates of the beard kit.
3. It composes each outfit variant: the Peasant base without its hidden nodes, then the head and the kit's cloth. The variant gets the same retargeted clips; the build checks that its joints match the Ranger rig before embedding them.
4. It ships the variants as `humanoid.ranger.male/outfit.<kit>`.
5. It ships the plates as the entries `armor.<kit>`, and the beards as `facial-hair.beards`.

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
