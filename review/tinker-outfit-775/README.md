# The Tinker's class outfit (#775)

`class.tinker` from `adapters/blender/armor.py`, fitted to both Ranger figures' Peasant fit targets (the Peasant outfit
composed with the head, as the Ranger build composes it) and rendered in headless Blender 5.2.2.

- `Lineup.jpg`: the Rogue, the male Tinker, the Ranger and the female Tinker in `Idle_Loop` at the mmorpg game camera's
  angle (0.42 rad pitch from 12 m), zoomed onto the figures, and below at the game camera's own 50 degree field. The
  Rogue and the Ranger are the published male outfits with their textures stripped (their skin shows white); the
  Tinkers are untextured where the Peasant base is hidden. The woad shirt, the ochre split apron and the bare head with
  goggles read apart from the Rogue's charcoal and red cowl and the Ranger's green hood and cloak.
- `Male.jpg`, `Female.jpg`: each figure in the class clips, labelled `<clip>@<frame> <view>` (30 fps), from the
  three-quarter front (`34`) and the figure's right (`side`): idle, `Run_Fwd_Loop` (the knee at its highest), the
  `TwoHand_Swing_B` wind-up and follow-through, `Tinker_Throw_Bomb` (the fuse lit, the release, the draw),
  `Tinker_Throw_Flask` and `Tinker_Place_Trap` kneeling. Each figure plays its own published clips.

Checked in the live Blender as well, frame by frame in the run, sprint, swing, throws, ready loop and trap: the split
apron's leg panels ride their thighs (a raised knee lifts its panel flat over the thigh, like a tasset, instead of
passing through it), the shirt stays under the apron and the belt, the rolled sleeves stay on the arms through the
elbow bends, and the flasks, tools, satchel and goggles stay on their joints clear of the cloth. The arms still pass
in front of the flasks and the apron where a clip reaches across the chest or draws at the hip, as they do over any
outfit.

The scripts: `merge_many.py` joins a published figure glTF with clip GLBs (its textures stripped); `gen_armor.py` runs
`armor.py`'s own `generate` for both outputs on a fit target; `render_review.py <config.json>` binds the cloth and the
plates to the figure's rig, plays its clips and renders the stills.
