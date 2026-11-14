# Humanoid equipment kit

The humanoid equipment kit (#517) ships the items the Ranger figures hold or wear. Each item is built once and published as the rolling `humanoid-equipment` release. Until now every figure's bundle carried its own copies: 22 items in the male bundle and 19 in the female one, byte-identical between the two.

## Contents

The entries keep the keys they had in the [Ranger bundles](humanoid-ranger.md#contents). A consumer that reads them by key and variant only changes where it downloads them from.

- **Weapons** ([weapon recipes](weapon-recipes.md)):
  - `equipment.sword.arming` and `equipment.shield.heater`;
  - the class set: `equipment.dagger.blackened`, `equipment.staff.bone`, `equipment.staff.gilded` and `equipment.staff.gnarled`;
  - the class starter props: `equipment.staff.crystal`, `equipment.book.tome` and `equipment.mace.flanged`.
- **Throwables (#467):** `equipment.throwing-knife`, `equipment.venom-flask` and `equipment.blasting-bomb`, each with `lod1` and `lod2` variants.
- **Archery** ([archery](weapon-recipes.md#archery)): `equipment.bow.long` (skinned to `grip` and `nock`), `equipment.arrow`, `equipment.quiver.back` and `equipment.crossbow`.
- **Headwear (#336, fitted to the male head):** `equipment.cap.ranger`, `equipment.helm.ironcrest` and `equipment.hat.straw`.

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

[`scripts/humanoid-equipment.ts`](../scripts/humanoid-equipment.ts) holds the item lists and builders. The Ranger build uses the same builders for as long as the figures still carry the items. The kit needs only Blender: no LFS payloads and no processor. With the shared generation cache, a rebuild that leaves the recipes alone takes a few seconds. The test is [`test/blender/kits/humanoid-equipment.test.ts`](../test/blender/kits/humanoid-equipment.test.ts).

## Retiring the figures' copies

Following the 2026-11-09 decision on #517, the figure releases keep their equipment entries until mmorpg, arpg and 3d-lab read them from this release. After that, the figure bundles drop them.
