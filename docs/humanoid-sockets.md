# humanoid-sockets-v1

A `humanoid-sockets-v1` descriptor declares the attachment frames of one humanoid character. It ships with the character bundle. Weapons and shields are separate bundle entries that a consumer parents to the character at runtime (owner answer Q3 on [#113](https://github.com/moritzbrantner/asset-tooling/issues/113)). Games keep equip legality, combat reach and blocking regions. A socket only says where an item's grip sits.

```json
{
  "schema": "humanoid-sockets-v1",
  "character": "humanoid.ranger.male",
  "unit": "meter",
  "axes": "right-handed-y-up",
  "attachFrame": "grip",
  "sockets": [
    {"id": "hand_r.weapon", "joint": "hand_r",
     "translation": [-0.0365, 0.0839, -0.0043], "rotation": [0.415728, 0.576917, 0.446029, 0.543503],
     "accepts": ["one-hand-weapon"]}
  ]
}
```

- **`joint`** names a joint of the character's skin. Joint names in this rig are UE-style: `hand_r`, `hand_l`, `spine_03`, `pelvis` and so on.
- **`translation`, `rotation` (x, y, z, w) and optional `scale`** form the socket's local transform in that joint's glTF frame, in metres. An item's **grip frame** is placed at `jointWorld × T × R × S`. For recipe weapons the grip frame is the GLB's origin (the `grip` node, see [style-humanlike.md](style-humanlike.md#conventions)), so a consumer can parent the weapon's scene root under the joint with exactly this TRS.
- **`accepts`** lists the item roles the socket takes. The weapon recipes declare `one-hand-weapon` (`sword.arming`) and `shield` (`shield.heater`).
- **`id`** is `<joint-ish>.<purpose>`, for example `hand_l.shield` or `back.stowed`, and is unique within the descriptor.

[`schemas/humanoid-sockets-v1.schema.json`](../schemas/humanoid-sockets-v1.schema.json) is the JSON schema. `asset-tooling/humanoid/sockets` provides the following helpers:

- `validateHumanoidSocketDescriptor(value, {joints})` rejects unknown fields and joints that are not in `joints`, for example a skin's joint names. It also rejects duplicate ids, non-finite or out-of-range values, non-unit quaternions, non-positive scales and empty or duplicate roles.
- `createHumanoidSocketDescriptor` builds a validated descriptor in canonical field order.
- `humanoidSocketsAccepting` lists the sockets that accept a role.
- `humanoidSocketMatrix` returns a socket's column-major 4 × 4 matrix.

## Ranger sockets

[`assets/descriptors/humanoid.ranger.male.sockets.json`](../assets/descriptors/humanoid.ranger.male.sockets.json) is the descriptor for `humanoid.ranger.male` ([humanoid-ranger.md](humanoid-ranger.md)). The Ranger bundle ships it as the `humanoid-sockets` attachment of the character entry, next to the equipment entries. The numbered releases keep the descriptors they shipped. The recipe no longer rebuilds them (Atlas Decision 7.1.5).

| Socket | Joint | Accepts | Placement |
| --- | --- | --- | --- |
| `hand_r.weapon` | `hand_r` | `one-hand-weapon` | The grip centre is in the palm, 3 cm below the knuckle plane and 80 % of the way from the hand joint to the knuckles. The grip runs along the knuckle line and the blade leaves the fist on the thumb side. The edges point along the fingers, and the flats face the palm and the back of the hand. |
| `hand_l.shield` | `hand_l` | `shield` | The handle centre is at the same grip point of the left hand. The face points out of the back of the hand and the top toward the thumb, so the point hangs below the little finger and the forearm crosses the board. |
| `back.stowed` | `spine_03` | `shield` | The shield is centred between the shoulder blades, face out and point down. |
| `hip_l.stowed` | `pelvis` | `one-hand-weapon` | The hilt is at the front left hip, with the flats facing outward and the blade running down and back. |

| Socket | Translation (before → after) | Rotation x, y, z, w (before → after) |
| --- | --- | --- |
| `hand_r.weapon` | `[-0.035, 0.09, -0.005]` → `[-0.0365, 0.0839, -0.0043]` | `[0.298837, 0.640856, 0.298837, 0.640856]` → `[0.415728, 0.576917, 0.446029, 0.543503]` |
| `hand_l.shield` | `[0.03, 0.085, -0.005]` → `[0.0365, 0.0839, -0.0043]` | `[0.707107, 0, -0.707107, 0]` → `[0.415728, -0.576917, -0.446029, 0.543503]` |

### Archery sockets

The descriptor declares four archery sockets (#113 bow slice).

| Socket | Joint | Accepts | Placement |
| --- | --- | --- | --- |
| `hand_l.bow` | `hand_l` | `bow` | The riser sits at the grip point of the left hand. The limbs (+Y) run along the knuckle line and the arrow direction (+Z) along the fingers. |
| `hand_r.arrow` | `hand_r` | `arrow` | The nock sits at the grip point of the right hand, and the shaft (+Z) runs along the knuckle line toward the index finger. |
| `back.quiver` | `spine_03` | `quiver` | The quiver sits on the back with its mouth over the right shoulder, from the rest-pose world intent: centre `[-0.07, 1.3, -0.22]`, mouth along `[-0.35, 1, 0]`, back against the body. |
| `back.bow.stowed` | `spine_03` | `bow` | The bow is slung diagonally across the back outside the quiver, its upper limb over the left shoulder and its string toward the body: centre `[0.02, 1.22, -0.3]`, limbs along `[0.75, 1, 0]`. |

`stowedSocket` in `examples/weapons/derive-sockets.ts` converts such a rest-pose world intent into the joint's frame. The held and stowed archery socket sheets are attached to the `humanoid-ranger-male-v7` release.

### Armour sockets

The descriptor declares one `<joint>.armor` socket for each joint that a rigid [armour piece](armor-recipes.md) rides: `head.armor`, `spine_03.armor`, `pelvis.armor`, and the `clavicle`, `upperarm`, `lowerarm`, `hand`, `thigh`, `calf` and `foot` sockets on both sides. Each accepts the role `armor`. Armour is fitted in the character's rest model space, so each socket is the inverse of its joint's rest-world transform, like `head.hair` (`deriveArmorSockets` in `examples/weapons/derive-sockets.ts`). The female descriptor declares the same sockets, derived from her own rig.

### How the hand sockets are derived

The first hand sockets (numbered releases v2 and v3) were tuned for a hanging arm. The blade leaned 40° toward the fingers so that it looked right at rest, and the shield's vertical axis followed the forearm. In the combat clips, the sword then pointed sideways at hip height in `Sword_Idle`, and the shield lay on its side in the `Idle_Shield_Loop` guard. The current hand sockets are not tuned for any pose. [`examples/weapons/derive-sockets.ts`](../examples/weapons/derive-sockets.ts) derives them from the rig's rest pose in each hand joint's own frame:

```sh
bun examples/weapons/derive-sockets.ts            # writes assets/descriptors/humanoid.ranger.male.sockets.json
bun examples/weapons/derive-sockets.ts --check    # exits 1 if the committed file differs
bun examples/weapons/derive-sockets.ts --rig <rig.gltf> --out <sockets.json> --weapon-hand l
```

1. **Hand frame.** From the rest positions of `index_01`, `middle_01`, `ring_01`, `pinky_01` and `thumb_03`, expressed in the `hand_*` joint frame, the script takes three directions:
   - **fingers:** the direction from the hand joint to `middle_01`;
   - **knuckle line:** the direction from `pinky_01` to `index_01`, which points toward the thumb side;
   - **palm normal:** the direction perpendicular to both, on the side where the thumb tip lies.

   For the Ranger the fingers run along +Y and the knuckle line along +Z, leaning about 15° toward the fingers. The palm faces −X on the right hand and +X on the left.
2. **Grip point.** The grip point is 80 % of the way from the hand joint to the knuckle centroid, then 3 cm toward the palm (`GRIP` in the script). That is where a fist's finger rings close around a grip.
3. **One-hand weapon.** In the weapon's grip frame ([weapon-recipes.md](weapon-recipes.md)), +Y runs along the knuckle line, +Z (the flats) faces the back of the hand, and +X = Y × Z (the edges) runs along the fingers. A closed fist holds a grip along its knuckle line. In UAL1's fist poses, the circle centres of the curled fingers lie on a line within 1° of the knuckle line. That is why the blade leans with the knuckle line, not 40°.
4. **Shield.** The handle centre is at the shield hand's grip point. +Z (the face) points out of the back of the hand, +Y (the top) points along the knuckle line toward the thumb, and +X = Y × Z. In the `Idle_Shield_Loop` guard, the fist is held thumb up in front of the chest, so the shield stands upright with its face forward and its point down. The forearm crosses the board as on enarmes.
5. **Output.** The script writes the hand sockets after the unchanged stowed sockets of `RANGER_STOWED_SOCKETS`, validates the descriptor against the rig's skin joints, and writes it in the committed layout. Translations are rounded to 0.1 mm and quaternions to six decimals. `deriveHandSockets(gltf, {weaponHand})` and `handFrame(worlds, side)` take any rig with UE-style `hand_*`, `*_01_*` and `thumb_03_*` joint names. `--weapon-hand l` derives `hand_l.weapon` and `hand_r.shield` for a left-handed character.

`test/humanoid-sockets.test.ts` checks the following:

- the derived axes of the committed sockets;
- that the derivation does not depend on where the rig is placed in the world;
- that the script reproduces the committed file byte for byte from the canonical `Male_Ranger.gltf` (skipped without Git LFS);

The sockets were checked visually in Blender with `examples/weapons/socket-sheets.py` (or `bun examples/weapons/build.ts --sheets <default.gltf>`). The script does the following:

- It imports the bundle's `default.gltf` and recovers each glTF joint's world transform through the importer's bone correction.
- It places the weapon GLBs with the socket TRS.
- It renders front, side, back and close-up sheets at rest, at the middle of `Idle_Loop`, and at a quarter and the middle of `Walk_Loop`.
- `--poses=<clip>@<fraction>,…` renders other poses instead, one `sheet-<clip>-<percent>.png` per pose.

The per-pose findings for v4 are in [humanoid-ranger.md](humanoid-ranger.md#visual-check-of-the-v4-sockets).

Known limits:

- The Ranger's fingers keep their open rest pose because finger retargeting is #115. The fingers therefore lie along the grip and do not wrap it.
- The shield recipe's forearm strap sits 16 cm along the shield's +Y, because the recipe assumes the forearm runs along the shield's vertical axis. With the enarmes-style socket, the forearm crosses the board instead, so the strap floats beside the wrist behind the board. Only the back and close-up views show it. A strap placed for a crossing forearm is a weapon-recipe change.
- With a hanging arm (`Idle_Loop`, `Walk_Loop`), the shield's top tilts forward with the thumb, and the sword points forward from the hip.
- The stowed sockets are unchanged. During `Walk_Loop` the left hand brushes the stowed sword's hilt, and the shield's top corner comes close to the left pauldron.
- Two-handed poses are follow-up work.
