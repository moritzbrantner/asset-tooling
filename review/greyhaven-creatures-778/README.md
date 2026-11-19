# Forest lynx and marsh adder review (#778)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the animal except where marked full),
rendered with Workbench in headless Blender 5.2.2 from the `greyhaven-wildlife` release GLBs built on this branch.

- `lynx-pounce-strip.jpg`: wind-up → strike → recovery, side (top) and three-quarter (bottom): `Pounce_Windup` 0, 6,
  9, 12 (sinks onto its haunches, treads, wiggles), `Pounce_Lunge` 3 (take-off), 5 (flight), 8 (contact, 0.333 s), 10,
  12 (hind paws land), `Pounce_Recover` 4, 10, 14, 20 (low over the catch, then gathers and rises). The root's 1.37 m
  `rootTravel` is added back, so the lynx moves across the frame as it would in game.
- `adder-strike-strip.jpg`: `Warn_Hiss_Loop` 0, 12, `Strike` 0, 2 (cocked), 4, 5 (contact, 0.208 s), 7, 10,
  `Strike_Recover` 6, 12, 20 (back in the warning S), side and three-quarter.
- `lynx-clips.jpg`, `adder-clips.jpg`: the other clips (idle, gaits, hit and death).
- `gaits-travel.jpg`: six frames across one loop of the lynx's `Walk`, `Crouch_Stalk_Loop` and `Run` and the adder's
  `Slither_Loop`, each with its `travelSpeed` added back.
- `lineup-game-camera.jpg`: the timber wolf, the lynx and the coiled adder side by side, zoomed and at the full game
  camera framing, from the side, three-quarter and front.

The scripts: `build.py` builds one authored animal through the recipe's `generate()`; `shots.py` writes the shot lists
and `render.py` renders them; `sheet.py` tiles the stills; `check.py` measures the clips with their root motion added
back (paw slide, the adder's path stray and self-clearance, ground penetration), the numbers quoted in
`docs/greyhaven-wildlife.md`.
