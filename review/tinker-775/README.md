# The Tinker's devices, clips and effects (#775)

Rendered in headless Blender 5.2.2 from this branch's recipes, on the published male Ranger (`humanoid.ranger.male`,
textures stripped).

- `Place_Trap.jpg`, `Throw_Flask.jpg`, `Throw_Bomb.jpg`, `Ready_Loop.jpg`: each clip from
  `adapters/blender/tinker_clips.py` at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the
  figure), labelled `<clip>@<frame> <view>` (30 fps), from the three-quarter front (`34`) and the figure's right
  (`side`), Workbench. The devices sit on `hand_r.weapon` by the socket contract; the trap stays where it was set from
  `placeSeconds` (its `ground` frame dropped on to the ground, as a consumer leaves it) and shows `armed` from
  `armSeconds`; the bomb shows `lit` from `lightSeconds`; the flask leaves the hand at `releaseSeconds` and a fresh one
  is drawn at `drawSeconds`.
- `Props.jpg`: the flask (held, thrown), the bomb (default, lit) and the trap (closed, armed, triggered, each set on
  its `ground` frame), built by `adapters/blender/held_items.py`'s own `generate`.
- `Effects.jpg`: `bomb-blast`, `chemical-ignite`, `flask-splash` and `trap-snap` at a few moments of their clips
  (labelled in milliseconds), beside the Ranger at the game camera, EEVEE.

Measured by `drive.py` on the clips:

| Clip | Foot drift while planted (left / right, m) | Lowest ball, ankle or wrist (m) | Device inside the body (m) |
| --- | --- | --- | --- |
| `Tinker_Place_Trap` | 0.058 / 0.203 | 0.02 | 0 |
| `Tinker_Throw_Flask` | 0.04 / 0.005 | 0.02 | 0 |
| `Tinker_Throw_Bomb` | 0.017 / 0.006 | 0.02 | 0 |
| `Tinker_Ready_Loop` | 0.002 / 0.001 | 0.02 | 0 |

Drift is the worst summed ball travel while the ball stays under 3 cm. The throws' left drift is the stepping foot's
last centimetres in and out. In `Tinker_Place_Trap` the right ball stays within 1.5 cm across and 3.6 cm along while the
foot turns in on its ball to kneel; the small back-and-forth sums to the 0.2 m. "Inside the body" is the deepest device
vertex under the body mesh with the hands and forearms left out, every second frame. Clipping and sliding were also
checked by eye on these sheets.

The scripts: `merge.py` joins the published figure with `humanoid.ranger.male.clips.glb`; `drive.py <config.json>`
authors the clips on it, renders the stills and measures them; `gen.py` runs the recipe's own `generate` as the Ranger
build does and lists the exported clips; `props.py` and `effects.py` render the props and effects sheets; `sheet.py`
tiles the stills.
