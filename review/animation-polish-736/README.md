# Animation polish review (#736)

Before/after stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the figure), rendered
with Workbench in headless Blender 5.2.2 from the recipes on this branch.

- `Boar_Attack_A.jpg`: the gore, three-quarter and low views, frames 0, 4, 7, 9 (contact), 11, 14. Before: the whole
  boar lifts off its hind feet and the forelegs swing out straight, showing their flat tops at the shoulders. After:
  the hind feet stay planted (two-bone leg solve), the forelegs tuck under the rearing chest and land a stride ahead,
  and a rounded shoulder or haunch on each leg closes the joint.
- `Gather_Mine_Loop.jpg`: before the hammer-era one-handed swing; after the pickaxe in both hands, struck into an ore
  rock (the grey proxy) low ahead. Frames 0, 0.3, 0.44 (contact), 0.58, 0.8 of the loop.
- `Gather_Skin_Loop.jpg`: the skinning knife (before shows the old motion with the same knife), a longer draw, a
  higher lift and more chest; the proxy stands where the carcass lies.
- `Carry.jpg`: `Carry_Idle_Loop` and `Carry_Walk_Loop` with the 0.36 m reference crate. Hand vertices inside the load:
  0.0995 m before (the thumbs), 0.0016 m after.
- `Bow_Ready_Set.jpg`: `Bow_Draw_Weapon`'s last frame, the new `Bow_Idle_Loop` (frames 0 and 45) and `Bow_Guard_Loop`.

The scripts: `merge.py` joins the published male figure (`humanoid.ranger.male.default.gltf`, textures stripped) with
`humanoid.ranger.male.clips.glb`; `drive.py <config.json>` authors a recipe's clips on it, renders the stills and
measures the hands inside the load; `boar_build.py` builds one wildlife animal through the recipe and `boar.py`
renders a clip of it; `sheet.py` tiles the stills.
