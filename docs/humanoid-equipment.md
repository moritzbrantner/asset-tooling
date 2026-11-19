# Humanoid equipment kit

The humanoid equipment kit (#517) ships the items the Ranger figures hold or wear. Each item is built once and published as the rolling `humanoid-equipment` release. Before this kit, each figure's bundle carried its own copies: 22 items in the male bundle and 19 in the female one, byte-identical between the two.

## Contents

The entries keep the keys they had in the [Ranger bundles](humanoid-ranger.md#contents). A consumer that reads them by key and variant only changes where it downloads them from.

- **Weapons** ([weapon recipes](weapon-recipes.md)):
  - `equipment.sword.arming` and `equipment.shield.heater`;
  - the class set: `equipment.dagger.blackened`, `equipment.staff.bone`, `equipment.staff.gilded` and `equipment.staff.gnarled`;
  - the class starter props: `equipment.staff.crystal`, `equipment.book.tome` and `equipment.mace.flanged`.
- **Throwables (#467):** `equipment.throwing-knife`, `equipment.venom-flask` and `equipment.blasting-bomb`, each with `lod1` and `lod2` variants.
- **Archery** ([archery](weapon-recipes.md#archery)): `equipment.bow.long` and the Fenwarden's Bow `equipment.bow.fenwarden` (a `bow.recurve`, #760), both skinned to `grip` and `nock`, `equipment.arrow`, `equipment.quiver.back` and `equipment.crossbow`.
- **Headwear (#336, fitted to the male head):** `equipment.cap.ranger`, `equipment.helm.ironcrest` and `equipment.hat.straw`.
- **Held items ([#661](https://github.com/moritzbrantner/asset-tooling/issues/661)):** weapon variety and the hand tools residents carry, below.

### Held items

[`adapters/blender/held_items.py`](../adapters/blender/held_items.py) builds 61 fixed-design items on the weapon recipes' grip contract ([weapon-recipes.md](weapon-recipes.md)), with the weapon recipes' material names and colours; only the hunter's spear's `wood.ash` is its own (#760). Each item's first role is one the Ranger sockets already accept, which names its socket; a second role (`two-hand-weapon`, `spear`, `tool`, `carried`) only describes it. Two-handed pieces declare a `grip.offhand` frame (identity rotation) for the other hand's IK target.

- **One-handed (`hand_r.weapon`):** the business end runs along +Y, edges and striking faces along +X, flats ±Z, as for the arming sword. The lantern, bucket and basket hang from the fist along +X with their bail along Y; the tankard's body sits on the +X side of its handle.
- **Staff (`hand_r.staff`):** the shaft runs along +Y through the grip with its foot 0.8 m below (0.85 m for the walking stick), so it stands beside the leg in the idle. The shovel's, broom's and scythe's working ends are at the foot.
- **Shield and book (`hand_l.shield`):** as the heater shield and the tome.
- **Carried loads (`chest.carry`, role `load`, [#735](https://github.com/moritzbrantner/asset-tooling/issues/735)):** the origin is the middle of the load's face against the chest, +Y up and +Z out of the chest ([humanoid-sockets.md](humanoid-sockets.md)). `Carry_Idle_Loop` and `Carry_Walk_Loop` put the palms on the load's sides at (±0.18, −0.08, 0.12), so each load is 0.36 m wide there and only flares above the forearms (hay, basket rim) or runs out from the chest (firewood).
- **Handedness ([#679](https://github.com/moritzbrantner/asset-tooling/issues/679), [#687](https://github.com/moritzbrantner/asset-tooling/issues/687)):** hang the lantern, bucket, basket and tankard (role `carried`) from `hand_r.carry` or `hand_l.carry`, with the `Grip_Weapon_R` or `Grip_Weapon_L` grip. The Ranger's `hand_l.weapon` socket, the mirror of `hand_r.weapon`, turns an item 180° about its +Y axis, so item +X points down in the right hand but up in the left: a symmetric blade looks the same in either hand, but a hanging item rises above the left fist. `hand_l.carry` keeps +X down and flips ±Z instead, the true mirror for these items, which are symmetric about their XY plane; `hand_r.carry` is `hand_r.weapon`'s frame. `hand_l.weapon` and the clips are unchanged (the off-hand dagger and the crossbow crank use it).

The [review renders](../review/humanoid-equipment/) show the items on the Ranger in its idle clips, composed by the socket contract (`jointWorld × socket × inverse(grip)`): swords, axes and the maul in `Sword_Idle` beside the arming sword they follow, the staff-socket tools in `Idle_Loop` beside the gnarled staff, and the hand tools close up. The grips sit in the fist and the sizes read true against the Ranger; the left-hand hanging items are the one problem.

| Key | Socket | Length (m) | Triangles | Notes |
| --- | --- | --- | --- | --- |
| `equipment.sword.footman` | `hand_r.weapon` | 0.90 | 126 | Straight 0.72 m blade, bar guard, ball pommel. |
| `equipment.sword.falchion` | `hand_r.weapon` | 0.78 | 126 | Single-edged blade widening and curving toward the tip. |
| `equipment.sword.longsword` | `hand_r.weapon` | 1.27 | 126 | 0.95 m blade, long grip, wheel pommel; `grip.offhand` at y −0.13. |
| `equipment.sword.bastard` | `hand_r.weapon` | 1.11 | 126 | Hand-and-a-half; `grip.offhand` at y −0.10. |
| `equipment.dagger.plain` | `hand_r.weapon` | 0.38 | 126 | 0.24 m blade, small guard. |
| `equipment.dagger.seax` | `hand_r.weapon` | 0.43 | 126 | Single-edged, dark wood grip, brass fittings. |
| `equipment.axe.battle` | `hand_r.weapon` | 0.78 | 98 | Broad crescent head toward +X. |
| `equipment.axe.bearded` | `hand_r.weapon` | 0.74 | 88 | Bearded head, dark haft. |
| `equipment.axe.hand` | `hand_r.weapon` | 0.42 | 64 | Small hatchet. |
| `equipment.mace.studded` | `hand_r.weapon` | 0.64 | 136 | Iron ball head with six studs. |
| `equipment.mace.morningstar` | `hand_r.weapon` | 0.72 | 166 | Spiked ball head. |
| `equipment.warhammer.horseman` | `hand_r.weapon` | 0.78 | 76 | Hammer face to +X, back spike, top spike. |
| `equipment.warhammer.maul` | `hand_r.weapon` | 1.05 | 76 | Heavy block head; `grip.offhand` at y −0.22. |
| `equipment.spear.leaf` | `hand_r.staff` | 2.29 | 96 | Leaf head at the top, iron butt cap; `grip.offhand` at y 0.45. |
| `equipment.spear.boar` | `hand_r.staff` | 2.26 | 98 | Broad head with lugs; `grip.offhand` at y 0.45. |
| `equipment.staff.quarter` | `hand_r.staff` | 1.80 | 96 | Iron-shod quarterstaff with a leather grip band. |
| `equipment.staff.crook` | `hand_r.staff` | 1.63 | 160 | Shepherd's crook. |
| `equipment.shield.round` | `hand_l.shield` | 0.61 | 286 | 0.6 m round plank shield, red face, iron rim and boss. |
| `equipment.shield.buckler` | `hand_l.shield` | 0.35 | 174 | Domed steel buckler with a brass rim. |
| `equipment.shield.kite` | `hand_l.shield` | 0.94 | 128 | Blue kite shield with a red cross. |
| `equipment.tool.lantern` | `hand_r.carry` | 0.33 | 150 | Hanging lantern; glass panes, glowing `ember` candle. |
| `equipment.tool.torch` | `hand_r.weapon` | 0.74 | 98 | Wrapped head with a glowing `ember` flame. |
| `equipment.tool.pitchfork` | `hand_r.staff` | 2.04 | 88 | Three tines up; `grip.offhand` at y 0.5. |
| `equipment.tool.hoe` | `hand_r.staff` | 1.54 | 68 | Blade at the top toward +Z; `grip.offhand` at y 0.5. |
| `equipment.tool.shovel` | `hand_r.staff` | 1.32 | 112 | Blade at the foot, D-handle on top; `grip.offhand` at y 0.47. |
| `equipment.tool.fishing-rod` | `hand_r.staff` | 2.62 | 106 | Cork butt, tapered rod, line and red float; butt 0.32 m below the grip. |
| `equipment.tool.wood-axe` | `hand_r.weapon` | 0.78 | 64 | Heavy splitting head; `grip.offhand` at y −0.12. |
| `equipment.tool.hammer` | `hand_r.weapon` | 0.39 | 52 | Round face toward +X. |
| `equipment.tool.bucket` | `hand_r.carry` | 0.43 | 134 | Hooped wooden bucket on an iron bail. |
| `equipment.tool.basket` | `hand_r.carry` | 0.37 | 198 | Wicker basket under an arched handle, with two apples. |
| `equipment.tool.tankard` | `hand_r.carry` | 0.14 | 134 | Brass-hooped wooden tankard. |
| `equipment.book.ledger` | `hand_l.shield` | 0.22 | 60 | 0.16 × 0.22 m leather book with a brass clasp. |
| `equipment.tool.broom` | `hand_r.staff` | 1.45 | 100 | Bound bristles at the foot; `grip.offhand` at y 0.45. |
| `equipment.tool.walking-stick` | `hand_r.staff` | 1.09 | 52 | Knobbed stick with an iron ferrule. |
| `equipment.tool.pickaxe` | `hand_r.weapon` | 0.80 | 100 | Two-sided iron pick head, points curving toward the hand; `grip.offhand` at y −0.12. |
| `equipment.tool.sickle` | `hand_r.weapon` | 0.27 | 110 | Crescent blade over the top toward +X, edge inside; wooden handle. |
| `equipment.tool.skinning-knife` | `hand_r.weapon` | 0.25 | 112 | Short blade curving toward +X, antler (`bone`) handle. |
| `equipment.tool.hand-saw` | `hand_r.weapon` | 0.57 | 120 | Open pistol handle; tapering blade with its teeth along +X. |
| `equipment.tool.mallet` | `hand_r.weapon` | 0.48 | 80 | Wooden carpenter's mallet, end-grain faces toward ±X. |
| `equipment.tool.rake` | `hand_r.staff` | 1.79 | 110 | Hay rake, nine wooden teeth toward +Z; `grip.offhand` at y 0.5. |
| `equipment.tool.scythe` | `hand_r.staff` | 1.53 | 152 | Snath with two nibs toward +Z, long blade at the foot along +X; `grip.offhand` on the upper nib (0, 0.55, 0.07). |
| `equipment.sword.great` | `hand_r.weapon` | 1.60 | 178 | Zweihänder: 0.92 m blade, upswept guard, leather-wrapped ricasso with parrying lugs; `grip.offhand` at y −0.22. |
| `equipment.axe.great` | `hand_r.weapon` | 1.46 | 142 | Long-hafted bearded great axe, wide head toward +X, back and top spikes; `grip.offhand` at y −0.22. |
| `equipment.hammer.great` | `hand_r.weapon` | 1.56 | 166 | Lucerne hammer: four-pronged face toward +X, fluke behind, top spike; `grip.offhand` at y −0.22. |
| `equipment.polearm.halberd` | `hand_r.staff` | 2.24 | 178 | Axe blade toward +X, back hook, top spike, langets; `grip.offhand` at y 0.45. |
| `equipment.polearm.glaive` | `hand_r.staff` | 2.15 | 126 | Single-edged blade curving toward its +X edge, back spur, dark haft; `grip.offhand` at y 0.45. |
| `equipment.spear.pike` | `hand_r.staff` | 2.87 | 120 | Tapering ash shaft, small leaf head on long langets; `grip.offhand` at y 0.45. |
| `equipment.load.crate` | `chest.carry` | 0.36 | 540 | Slatted crate, 0.36 × 0.26 × 0.26 m like the clips' reference crate, dark corner posts, seven apples heaped above the rim. |
| `equipment.load.sack` | `chest.carry` | 0.46 | 254 | Slumped burlap grain sack, 0.46 m tall, gathered and tied at the neck with a tuft above the cord. |
| `equipment.load.firewood` | `chest.carry` | 0.51 | 208 | Nine split and round logs, ends out from the chest with pale end grain, tied with two ropes. |
| `equipment.load.hay` | `chest.carry` | 0.69 | 316 | Armful of hay: a ragged 0.57 m bulge above the forearms with tufts of stalks fanning out. |
| `equipment.load.basket-large` | `chest.carry` | 0.53 | 764 | Oval wicker harvest basket, 0.45 m at the rim, two loop handles, apples and turnips. |
| `equipment.load.water-jug` | `chest.carry` | 0.43 | 362 | Big clay jug: round belly, two pale slip bands, stoppered neck, strap handle on the far side. |
| `equipment.sword.garricks-cleaver` | `hand_r.weapon` | 0.79 | 354 | Garrick's Cleaver (#760): Garrick Redbrand's broad falchion, a straight iron-shod back, two notches in the edge, a clipped point, a red-wrapped grip under a short heavy guard. |
| `equipment.spear.hollowpine-hunter` | `hand_r.staff` | 2.47 | 546 | Hollowpine Hunter's Spear (#760): pale ash shaft, broad leaf blade over two bound boar tusks, feather tufts on leather thongs; `grip.offhand` at y 0.45. |
| `equipment.mace.millbrook-smith` | `hand_r.weapon` | 0.75 | 450 | Millbrook Smith's Mace (#760): seven stepped steel flanges on an iron core with a short finial, a brass plate struck with the smithy's anvil mark, a haft leather-wrapped from pommel to collar. |
| `equipment.shield.redbrand` | `hand_l.shield` | 0.59 | 624 | Redbrand shield (#773): a battered round plank shield, its outline nicked and its iron rim broken at the two deepest nicks, dark plank seams and iron nails, a raised iron boss on a red ring under the red brand (a bar over a downward chevron). |
| `equipment.tool.signal-horn` | `hand_r.weapon` | 0.47 | 378 | Redbrand signal horn (#773): a curved ox horn, dark at the narrow end and pale toward the bell, with a brass mouthpiece 0.088 m up +Y from the grip (frame `horn.mouthpiece`), two brass bands joined by a leather cord and a brass-rimmed bell curving toward +X. |

The heavy weapons (#719) are fitted to the Ranger's heavy clips. The great sword, axe and hammer ride `hand_r.weapon` with the maul's `grip.offhand` (0.22 m below the main grip), so the left hand lands where `TwoHand_Swing_A`/`B`/`C` put it on the maul (within a few millimetres in the swings). The polearms ride `hand_r.staff` like the spears: the left hand slides 0.15–0.5 m up the shaft through `Spear_Thrust_A`/`B`. They were reviewed on the male Ranger in the live Blender. The guard loops (`TwoHand_Guard_Loop`, `Spear_Guard_Loop`) were not yet published, so they were not checked.

The carried loads (#735) were fitted on the male Ranger in the live Blender through both clips, the figure posed by the published `Carry_Idle_Loop` and `Carry_Walk_Loop`. The arms, palms and chest stay within 1.3 cm of each load's surface (the clips' own reference crate: 1.7 cm). The clips' cupped fingers and thumbs sink up to 0.1 m into any load as wide as that crate, the reference crate included; that is the clips' finger pose, not the loads.

The Redbrand shield and signal horn (#773) are held by the Ranger's `guard` and `signal` clips ([humanoid-ranger.md](humanoid-ranger.md#redbrand-shield-guard-and-signal-horn-clips-773)). The horn's `one-hand-weapon` role puts it on `hand_r.weapon`: its narrow end sits in the fist and the mouthpiece reaches the lips when `Signal_Call_Loop` holds it there. Both use existing materials only. [`review/redbrand-773/Props.jpg`](../review/redbrand-773/Props.jpg) shows them.

The named finds (#760) follow their family's sockets and roles: Garrick's Cleaver and the Millbrook Smith's Mace ride `hand_r.weapon`, the Hollowpine Hunter's Spear `hand_r.staff`, and the Fenwarden's Bow `hand_l.bow` with the longbow's draw contract. Each differs from its base weapon in silhouette and material, with no glow. [`named-finds-760.jpg`](../review/humanoid-equipment/named-finds-760.jpg) shows each beside its base weapon (falchion, leaf spear, flanged mace, longbow) on the male Ranger at a game-camera distance, posed by `Sword_Idle`, `Idle_Loop` and `Bow_Hold_Loop` and composed by the socket contract, then upright and broadside below. The Ranger there is untextured, because Blender cannot read its KTX2 textures. In `Sword_Idle` the blades point toward the camera, so the cleaver and the mace read mostly by their grip and head colours at that distance.

Length is the item's longest extent. The numbers are from the build of 2026-11-16 (the loads' of 2026-11-17). A rebuild is byte-identical: the recipe builds explicit vertex lists and triangulates them itself, in a fixed order.

Every item is a recipe preset whose origin is its grip frame. Its `humanoid-item` attachment (`humanoid-item-v2`) names its role and its `grip` frame. The throwables' attachments also list their levels and switch points. A consumer parents an item under the socket its role names, using the figure's sockets descriptor ([humanoid-sockets.md](humanoid-sockets.md)). The male figure's `humanoid-appearance.headwear` list still names the headwear entries and the parts each hides.

The items ship no textures, only flat-colour materials. Held items load one at a time on a socket rather than being batched as scenery, so the one-atlas rule of the [kit standard](kit-standard.md) does not apply. The kit's 33 materials are its budget instead (`releases/humanoid-equipment.json`).

## Release files

- `humanoid.equipment.tar`, its `.sha256` and `export.ref.json`: the `gltf-resources-v1` bundle.
- `humanoid-equipment.index.json` and the per-entry downloads (`<key>.<variant>.gltf`, `.bin` and `.humanoid-item.json`), written by [`pack-downloads.ts`](../scripts/pack-downloads.ts) like the figures'. They are byte-identical to the equipment files the figure releases serve, so a consumer that fetches per-entry downloads finds the same file names in the new release.
- `lineage.json`: the AssetRef of each item.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-humanoid-equipment.ts --out <directory>
```

[`scripts/humanoid-equipment.ts`](../scripts/humanoid-equipment.ts) holds the item lists and builders. The kit needs only Blender: no LFS payloads and no processor. With the shared generation cache, a rebuild that leaves the recipes alone takes a few seconds. The test is [`test/blender/kits/humanoid-equipment.test.ts`](../test/blender/kits/humanoid-equipment.test.ts).

## The figures' copies, retired

Following the 2026-11-09 decision on #517, the figure releases kept their equipment entries until mmorpg (mmorpg#798), arpg (arpg#282) and 3d-lab (3d-lab#188) read them from this release. After that, the figure bundles dropped them. Both figures' `humanoid-appearance` names this kit as `equipmentKit`. The male figure's `headwear` list still names its headwear entries, which live here. The item checks of the Ranger test moved to this kit's test.
