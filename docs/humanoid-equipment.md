# Humanoid equipment kit

The humanoid equipment kit (#517) ships the items the Ranger figures hold or wear. Each item is built once and published as the rolling `humanoid-equipment` release. Before this kit, each figure's bundle carried its own copies: 22 items in the male bundle and 19 in the female one, byte-identical between the two.

## Contents

The entries keep the keys they had in the [Ranger bundles](humanoid-ranger.md#contents). A consumer that reads them by key and variant only changes where it downloads them from.

- **Weapons** ([weapon recipes](weapon-recipes.md)):
  - `equipment.sword.arming` and `equipment.shield.heater`;
  - the class set: `equipment.dagger.blackened`, `equipment.staff.bone`, `equipment.staff.gilded` and `equipment.staff.gnarled`;
  - the class starter props: `equipment.staff.crystal`, `equipment.book.tome` and `equipment.mace.flanged`.
- **Throwables (#467):** `equipment.throwing-knife`, `equipment.venom-flask` and `equipment.blasting-bomb`, each with `lod1` and `lod2` variants.
- **Archery** ([archery](weapon-recipes.md#archery)): `equipment.bow.long` (skinned to `grip` and `nock`), `equipment.arrow`, `equipment.quiver.back` and `equipment.crossbow`.
- **Headwear (#336, fitted to the male head):** `equipment.cap.ranger`, `equipment.helm.ironcrest` and `equipment.hat.straw`.
- **Held items ([#661](https://github.com/moritzbrantner/asset-tooling/issues/661)):** weapon variety and the hand tools residents carry, below.

### Held items

[`adapters/blender/held_items.py`](../adapters/blender/held_items.py) builds 41 fixed-design items on the weapon recipes' grip contract ([weapon-recipes.md](weapon-recipes.md)), with the weapon recipes' material names and colours, so the kit's material count is unchanged. Each item's first role is one the Ranger sockets already accept, which names its socket; a second role (`two-hand-weapon`, `spear`, `tool`, `carried`) only describes it. Two-handed pieces declare a `grip.offhand` frame (identity rotation) for the other hand's IK target.

- **One-handed (`hand_r.weapon`):** the business end runs along +Y, edges and striking faces along +X, flats ±Z, as for the arming sword. The lantern, bucket and basket hang from the fist along +X with their bail along Y; the tankard's body sits on the +X side of its handle.
- **Staff (`hand_r.staff`):** the shaft runs along +Y through the grip with its foot 0.8 m below (0.85 m for the walking stick), so it stands beside the leg in the idle. The shovel's, broom's and scythe's working ends are at the foot.
- **Shield and book (`hand_l.shield`):** as the heater shield and the tome.
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

Length is the item's longest extent. The numbers are from the build of 2026-11-16. A rebuild is byte-identical: the recipe builds explicit vertex lists and triangulates them itself, in a fixed order.

Every item is a recipe preset whose origin is its grip frame. Its `humanoid-item` attachment (`humanoid-item-v2`) names its role and its `grip` frame. The throwables' attachments also list their levels and switch points. A consumer parents an item under the socket its role names, using the figure's sockets descriptor ([humanoid-sockets.md](humanoid-sockets.md)). The male figure's `humanoid-appearance.headwear` list still names the headwear entries and the parts each hides.

The items ship no textures, only flat-colour materials. Held items load one at a time on a socket rather than being batched as scenery, so the one-atlas rule of the [kit standard](kit-standard.md) does not apply. The kit's 31 materials are its budget instead (`releases/humanoid-equipment.json`).

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
