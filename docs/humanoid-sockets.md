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
     "translation": [-0.035, 0.09, -0.005], "rotation": [0.298837, 0.640856, 0.298837, 0.640856],
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

[`assets/descriptors/humanoid.ranger.male.sockets.json`](../assets/descriptors/humanoid.ranger.male.sockets.json) is the versioned descriptor for `humanoid.ranger.male` ([humanoid-ranger.md](humanoid-ranger.md)). The Ranger bundle v2 ships it as the `humanoid-sockets` attachment of the character entry, next to the `equipment.sword.arming` and `equipment.shield.heater` entries.

| Socket | Joint | Accepts | Placement |
| --- | --- | --- | --- |
| `hand_r.weapon` | `hand_r` | `one-hand-weapon` | The grip lies across the palm at the finger roots, 9 cm along the fingers and 3.5 cm to the palm side. The blade leaves the fist past the thumb and leans 40° toward the fingers, so the sword points forward and down from a hanging arm. |
| `hand_l.shield` | `hand_l` | `shield` | The handle is in the palm. The face points away from the back of the hand, and the forearm axis runs back toward the elbow. With the arm hanging, the shield is upright on the outside of the forearm with its point down. |
| `back.stowed` | `spine_03` | `shield` | The shield is centred between the shoulder blades, face out and point down. |
| `hip_l.stowed` | `pelvis` | `one-hand-weapon` | The hilt is at the front left hip, with the flats facing outward and the blade running down and back. |

How the values were authored: the hand sockets are set in joint-local terms. In the Ranger's T-pose, `hand_*` +Y runs along the fingers and +Z toward the thumb. The palm faces −X on the right hand and +X on the left. The stowed sockets were set from rest-pose world intents and converted into the joint frames. All four were checked visually in Blender with `examples/weapons/socket-sheets.py` (or `bun examples/weapons/build.ts --sheets <default.gltf>`). The script imports the bundle's `default.gltf`, recovers each glTF joint's world transform through the importer's bone correction, places the weapon GLBs with the socket TRS, and renders front, side, back and close-up sheets at rest, at the middle of `Idle_Loop`, and at a quarter and the middle of `Walk_Loop`. `--poses=<clip>@<fraction>,…` renders other poses instead, one `sheet-<clip>-<percent>.png` per pose.

Known limits of this slice:

- The Ranger's fingers keep their open rest pose because finger retargeting is #115. The fingers therefore lie along the grip and do not wrap it.
- During `Walk_Loop`, the left hand brushes the stowed sword's hilt, and the shield's top corner comes close to the left pauldron.
- The combat clips of the [Ranger bundle v2](humanoid-ranger.md#visual-check-of-the-v2-clips) show where the hand sockets fall short. The sword points sideways in `Sword_Idle`, and in the `Idle_Shield_Loop` guard the shield sits on its side because its vertical axis follows the forearm. Guard-specific sockets, or a revised `hand_l.shield`, are follow-up work, as are two-handed poses.
