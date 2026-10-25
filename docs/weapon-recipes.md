# Weapon recipes

`asset-tooling/recipes/weapons` authors original humanlike-family equipment through the pinned Blender script backend ([blender-script.md](blender-script.md), `external.blender.script@1`) with [`adapters/blender/weapon.py`](../adapters/blender/weapon.py). It is slice 1 of [#113](https://github.com/moritzbrantner/asset-tooling/issues/113): a sword and a shield, scripted rather than sourced (owner answer Q1, Atlas Decision 1.1.7). The pieces follow the [humanlike style spec](style-humanlike.md), and they attach to characters through [humanoid-sockets-v1](humanoid-sockets.md).

```ts
import {WEAPON_PRESETS, WEAPON_ROLES, createWeaponAssetSpec, readWeaponRecipeSource} from "asset-tooling/recipes/weapons";

const source = await readWeaponRecipeSource();
const spec = createWeaponAssetSpec({assetId: "weapon.sword.arming", parameters: WEAPON_PRESETS["sword.arming"],
  scriptSha256: source.sha256, blenderVersion: source.blenderVersion});
WEAPON_ROLES["sword.arming"]; // "one-hand-weapon"
```

## Pieces

| Piece | Role | Geometry | Preset triangles | Budget |
| --- | --- | --- | --- | --- |
| `sword.arming` | `one-hand-weapon` | The blade has bevelled edges, a fuller in each flat, a distal taper and an ogive point. The crossguard is a bevelled bar with tapered, slightly forward-swept quillons. The grip has a helical leather wrap, and the pear pommel has a peen button. The sword is 0.95 m overall. | 1,304 | 2,500 |
| `dagger.blackened` | `one-hand-weapon` | The sword build at dagger proportions ([#372](https://github.com/moritzbrantner/asset-tooling/issues/372), mmorpg's Rogue): a 0.35 m blade with a short fuller, a slim charcoal crossguard and pommel, and a dark-leather wrapped grip. The dagger is 0.49 m overall. | 1,016 | 1,500 |
| `staff.bone` | `staff` | The Necromancer staff (#372): a bone-white shaft with knuckled joints, a flared bone collar and four short bone spurs cradling a glowing green orb. | 948 | 2,500 |
| `staff.gilded` | `staff` | The Cleric staff (#372): a smooth ivory shaft with a gold ferrule, a gold band above the hand and a flared gold cap whose four tines hold a glowing gold orb. | 1,120 | 2,500 |
| `staff.gnarled` | `staff` | The Druid staff (#372): a crooked dark-wood branch with swelling bark and two knots, splitting at the top into three prongs that curl over a glowing moss-green orb. | 1,098 | 2,500 |
| `staff.crystal` | `staff` | The Arcanist staff (#379): a slim silver shaft with a ferrule and a band at the hand, and three prongs holding a long six-sided pale-blue crystal, point up. | 930 | 2,500 |
| `mace.flanged` | `one-hand-weapon` | The Cleric's mace (#379): a dark-wood haft with a leather grip and a gold pommel, and a round gold head ringed by six bevelled flanges. 0.67 m overall. | 442 | 1,500 |
| `book.tome` | `book` | The Arcanist's tome (#379): two oxblood covers over a parchment block, a spine and gold corner plates. 0.17 × 0.23 m, 5.5 cm thick. | 96 | 400 |
| `shield.heater` | `shield` | The board is a heater outline curved around its vertical axis, with a painted face and a wooden back and edge. It has a bevelled iron rim, a central boss, a leather hand handle and a forearm strap. The shield is 0.57 × 0.75 m including the rim. | 1,706 | 3,000 |

Each GLB has one mesh node named after the piece and an empty node **`grip`** at the origin. Both have identity transforms, and the asset origin is the grip frame:

- **sword and dagger:** the grip frame is the centre of the hand's contact on the grip. The blade points along +Y, the edges along ±X and the flats face ±Z. The mace is held the same way, its haft along +Y.
- **tome:** held like the shield, in `hand_l.shield` (which accepts `book`): the grip frame is the middle of the back cover, the spine runs along +Y (the forearm), the covers face ±Z and the book stands off the hand toward +Z.
- **staff:** the grip frame is the centre of the hand's contact on the shaft, which runs along +Y from the foot (`footLength` below) to the head and orb. The shaft axis passes through the grip.
- **shield:** the grip frame is the centre of the hand handle, which runs along Y, across the palm in the hand sockets. The face points to +Z, the point to −Y and the left forearm runs across the board along +X to the forearm strap (#285).

`WEAPON_GRIP_CONTRACT` states the same conventions. Materials are factor-only PBR (`steel`, `iron`, `leather`, `wood`, `paint`, and for the class set `charcoal`, `leather.dark`, `bone`, `ivory`, `gold`, `wood.dark`, `silver`, `cover`, `parchment`) with no UVs or textures. The orbs and the crystal (`orb.green`, `orb.gold`, `orb.moss`, `crystal.blue`, `WEAPON_EMISSIVE_MATERIALS`) glow: their glTF emissive factor equals their base colour.

The class colours follow mmorpg's procedural looks (`mmorpg-presentation` `player.rs`): bone-white shaft and green orb for the Necromancer, white shaft with gold for the Cleric, dark wood with a moss-green orb for the Druid, and steel over charcoal and dark leather for the Rogue. The staff presets share that look's proportions: a 1.85 m staff held 0.8 m above its foot, with a 7.5 cm orb. Items cannot be scaled at runtime, so these sizes are final on the Ranger.

## Controls

All pieces take `schemaVersion: 1`, `piece` and `maxTriangles`. `maxTriangles` runs from 12 to the piece's budget.

- **`sword.arming`:** `bladeLength` (0.5–1), `bladeWidth` (0.03–0.07), `bladeThickness` (0.004–0.012), `fullerLength` (0–0.8 of the blade, where 0 means no fuller), `guardWidth` (0.12–0.3), `gripLength` (0.08–0.22), `pommelRadius` (0.015–0.04) and integer `radialSegments` (6–24). The blade must be at least three times as wide as it is thick, and the guard at least twice as wide as the blade.
- **`dagger.blackened`:** the sword's controls with dagger ranges: `bladeLength` (0.2–0.45), `bladeWidth` (0.02–0.045), `bladeThickness` (0.003–0.01), `fullerLength` (0–0.8), `guardWidth` (0.05–0.14), `gripLength` (0.07–0.13), `pommelRadius` (0.01–0.025) and integer `radialSegments` (6–24), with the sword's proportion rules.
- **`mace.flanged`:** `haftLength` (0.35–0.7, grip to head), `gripLength` (0.08–0.2, at most half the haft), `headRadius` (0.03–0.07) and integers `flanges` (4–8) and `radialSegments` (6–16).
- **`book.tome`:** `width` (0.12–0.26), `height` (0.16–0.34, at least the width) and `thickness` (0.03–0.09, at most half the width).
- **`staff.bone`, `staff.gilded`, `staff.gnarled`, `staff.crystal`:** `length` (1.5–2.2, foot to shaft top), `footLength` (0.5–1, grip to foot, at most half the length), `shaftRadius` (0.014–0.03), `orbRadius` (0.04–0.1, at least twice the shaft radius) and integer `radialSegments` (6–16).
- **`shield.heater`:** `width` (0.36–0.8), `height` (0.45–1), `curvature` (0–0.12), `thickness` (0.008–0.04), `rimWidth` (0.008–0.05), `bossRadius` (0.03–0.12) and integer `outlineSegments` (6–32). A heater is at least as tall as it is wide, with `bossRadius ≤ width/4`, `rimWidth ≤ width/8` and `curvature ≤ width/4`.

Python and TypeScript reject the same controls before the scene changes. Generation declares `randomness: none` and exact reproducibility, and the script fails if the triangulated mesh exceeds `maxTriangles`. The receipt observations record the piece, role, grip node, units, axes, triangle count, bounds, materials and a geometry hash.

## Example and tests

`bun examples/weapons/build.ts` generates and exactly verifies every preset into the ignored `.artifacts/weapons/`. With `--sheets <humanoid.ranger.male default.gltf>`, it also renders the [Ranger socket sheets](humanoid-sockets.md#ranger-sockets) through `examples/weapons/socket-sheets.py`: held, stowed, and each staff in `hand_r.staff` with the dagger in `hand_l.weapon`.

`bun test test/weapon-recipes.test.ts` checks control bounds and the spec pins. With `ASSET_TOOLING_BLENDER` set, it also runs:

- the Python and TypeScript control parity check;
- exact replay and a cache hit for both presets;
- the structural GLB checks: the triangle count against the receipt and the budget, the `grip` and mesh nodes at identity, finite positions, bounds in metres matching the receipt, the sword's 0.95 m length and guard width, the dagger's length and guard width, each staff's foot and head heights, the shield's size and face direction, the material names, factor-only materials and the orbs' emissive factors, and a `scene.import.gltf` round trip;
- grip and socket alignment for every held piece: the hand's contact band is a ring centred on the grip axis, and in its Ranger socket (`hand_r.weapon` or `hand_r.staff`) the grip lands on the socket's grip point, a blade leaves the fist on the thumb side and a staff's head rises past the wrist;
- rejection of an over-budget `maxTriangles` without touching the previous output.

Blender installed as a snap can only read and write under `$HOME`, so set `TMPDIR` to a directory there. `test/humanoid-sockets.test.ts` checks the Ranger descriptor and the validator. When the Git LFS outfit is hydrated, it also checks the descriptor against the Male_Ranger rig's 65 joints.

## Archery

`src/archery-recipes.ts` (`ARCHERY_PRESETS`, `createArcheryAssetSpec`, `readArcheryRecipeSource`) authors the #113 bow slice with [`adapters/blender/archery.py`](../adapters/blender/archery.py), through the same backend and style spec (owner answer Q1 = A, 2026-10-17).

| Piece | Role | Geometry | Preset triangles | Budget |
| --- | --- | --- | --- | --- |
| `bow.long` | `bow` | A 1.5 m braced longbow. It has a riser with a leather grip, tapered chamfered limbs that bend toward the string, horn nocks and a string with a serving at the nock point. The brace height is 0.18 m. | 840 | 2,500 |
| `arrow` | `arrow` | A 0.76 m shaft with a nock block, a flat broadhead and three vanes. | 142 | 800 |
| `quiver.back` | `quiver` | A 0.5 m leather tube with a wooden base, iron bands, two strap loops and five arrow tails. | 532 | 6,000 |

Frames (`ARCHERY_GRIP_CONTRACT`):

- **bow:** the origin is the centre of the hand's contact on the riser. The limbs run along ±Y, the arrow leaves toward +Z and the string is on the −Z side.
- **arrow:** the origin is the nock, and the shaft runs toward +Z.
- **quiver:** the origin is the tube's centre. The mouth points to +Y and the back faces −Z.

**Draw (`BOW_DRAW_CONTRACT`):** the bow is the one skinned item. Its skin has two joints: `grip` is the root at the origin, and `nock` sits at the string's middle, at rest at `[0, 0, -braceHeight]`. Each string vertex is weighted linearly from `grip` at the tip to `nock` at the middle, so translating `nock` toward −Z in the bow frame draws the string, and both halves stay straight. The limbs follow `grip` only and do not bend. The arrow and quiver are static and have an empty `grip` node at the origin. Controls:

- **bow:** `length` (1.2–1.9), `braceHeight` (0.12–0.24), `limbWidth` (0.02–0.05) and integer `limbSegments` (6–24);
- **arrow:** `length` (0.55–0.95), `shaftRadius` (0.003–0.007) and integer `radialSegments` (5–12);
- **quiver:** `length` (0.35–0.7), `radius` (0.035–0.08), integer `arrows` (0–8) and integer `radialSegments` (8–24).

`bun test test/archery-recipes.test.ts` checks the control bounds. With `ASSET_TOOLING_BLENDER` set, it also generates the presets and checks:

- the budgets;
- the bow's `grip`/`nock` skin and its nock rest;
- that only string vertices follow `nock`;
- the static `grip` frames of the arrow and quiver.

The 3d-lab item loader (`adaptImportedItemBundle`) accepts static items only, so consumers cannot load the skinned bow there yet.

Not yet covered: bow draw and release clips (split out of #114), a spear, staff cast clips, textured or heraldic variants, and the consumer smoke in arpg. The combat clips and the weapon bundle entries are part of the [Ranger bundle](humanoid-ranger.md#contents).
