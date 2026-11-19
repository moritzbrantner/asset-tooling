# Redbrand shield guard, signal horn call and their props (#773)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the figure), rendered with Workbench
in headless Blender 5.2.2 from `adapters/blender/defend_clips.py` on this branch, on the published male Ranger
(textures stripped: Blender cannot read KTX2). The items ride their sockets by the socket contract: the
`equipment.shield.redbrand` on `hand_l.shield` and Garrick's cleaver on `hand_r.weapon` for the guard clips, and the
`equipment.tool.signal-horn` on `hand_r.weapon` for the horn clips. Six evenly spaced frames per clip, labelled
`<clip>@<frame>` (30 fps).

- `Guard.jpg`: `Shield_Guard_Loop`, `Shield_Block_Impact`, `Shield_Guard_Bash` and `Guard_Broken_Stagger`, three-quarter front.
- `Guard_Turns.jpg`: `Shield_Guard_Turn_L` and `_R`, three-quarter front.
- `Signal_Call.jpg`: the horn call's start, loop, interruption and end, from the side.
- `Closeups.jpg`: the guard, the bash at contact, the call and the horn knocked loose, from four sides.
- `Props.jpg`: the shield and the horn from the front, three-quarter and back.

Measured over every frame (`drive.py`):

- **Foot slide:** the summed ball travel while a ball stays under 3 cm. The worst is 0.011 m (`Guard_Broken_Stagger`).
  Every other clip is under 0.01 m. Each step lifts the foot before it travels and sets it down after.
- **Ground:** no ball or ankle goes below 2 cm.
- **Clearance:** the deepest item vertex inside the body capsules of `src/combat-clip-checks.ts` (torso, head,
  thighs), not counting the 12 cm around either hand. The shield and blade stay clear in every guard clip. The worst
  is the impact's 0.003 m, where the shield is driven back to the chin. The horn's 0.05–0.06 m in the head capsule is
  the mouthpiece at the lips. After `dropSeconds` the consumer drops the horn, so the check ends there.

Shaped by these renders and checked in the live Blender: the built clips on the figure, with the shield and cleaver
on their sockets through the bash. Not yet viewed in the game.

The scripts:

- `strip.py` drops the textures from the merged figure. The merge itself is `review/ranger-clips-767/merge.py`
  (`humanoid.ranger.male.default.gltf` with `humanoid.ranger.male.clips.glb`).
- `held.py` builds one held item with `adapters/blender/held_items.py`.
- `drive.py <config.json>` authors the clips on the figure, renders the stills and measures.
- `props.py` renders the items.
- `sheet.py` and `sheets.sh` tile the stills.
