# Movement spells, control reactions and the tanner (#767)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, three-quarter front, zoomed onto the figure),
rendered with Workbench in headless Blender 5.2.2 from `adapters/blender/move_clips.py` on this branch, on the
published male Ranger. Six evenly spaced frames per clip, labelled `<clip>@<frame>` (30 fps). The upper-body clips
(`Rooted_Struggle_Loop`, `Rooted_Struggle_Frozen_Loop`, `Grapple_Throw`, `Pull_Yank`) are shown over the idle's legs, as
the game layers them.

- `Control.jpg`: the rooted struggle and its frozen variant, the pit fall, being pulled and slipping on ice.
- `Blink_Leap.jpg`: the blink out and in, and the leap's launch, air loop and slam.
- `Dash_Grapple.jpg`: the dash, the grappling hook's throw and the yank.
- `Tanner.jpg`: the fleshing loop and stretching a hide.

Foot slide (the worst summed ball travel while it stays under 3 cm, metres, left/right): 0 or under 0.011 for every
clip but the two that slide on purpose: `Pulled_Drag` 0.085/0.121 (the toes trail while the body is hauled) and
`Slip_Ice_Loop` 0.534/0.171 (the feet skate). In the slam, dash, drag, pit fall, launch, blink-in and both tanner
clips the lowest ball, ankle or wrist stays at or above 7 mm (measured in the live Blender). Clipping was
checked by eye on these sheets and from front, side and three-quarter views in the live Blender: no arm passes
through the body.

The scripts: `merge.py` joins the published figure (`humanoid.ranger.male.default.gltf`, textures stripped) with
`humanoid.ranger.male.clips.glb`; `drive.py <config.json>` authors the recipe's clips on it, renders the stills and
measures the foot slide; `gen.py` runs the recipe's own `generate` as the Ranger build does and lists the exported
clips; `sheet.py` tiles the stills.
