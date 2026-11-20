# Stag combat clips and highland ram review (#782)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the animal except where marked full),
rendered in EEVEE under a sun in headless Blender 5.2.2 from the GLBs the `greyhaven-wildlife` recipe builds on this
branch, so the new textured, nonmetallic coats show (the #778 sheets are Workbench flat colour).

- `stag-before-after.jpg`: the stag as `main` builds it (top) and with its hair and antler detail textures (bottom),
  idle, at the same cameras: side, three-quarter and front.
- `stag-attack-a-strip.jpg`: the antler sweep, side (top) and three-quarter (bottom): 0, 5, 8 (cocked right, weight
  back), 10, 11 (contact, 0.458 s), 13, 17, 22.
- `stag-attack-b-strip.jpg`: the charge with its 2.0 m `rootTravel` added back: 0, 5 (antlers lowered, forefoot
  scrape), 8, 11, 14 (lowered-head gallop), 15 (contact, 0.625 s, braced), 16 (hook), 20, 26, 32.
- `highland-ram-attack-a-strip.jpg`: the rear-and-butt: 0, 4, 7 (reared), 9, 10, 11 (contact, 0.458 s), 13, 16, 22.
- `highland-ram-attack-b-strip.jpg`: the short charge with its 1.6 m `rootTravel` added back: 0, 3 (scrape), 6, 9, 12,
  13 (contact, 0.542 s), 15 (rebound), 18, 22 (dazed), 30.
- `stag-clips.jpg`, `highland-ram-clips.jpg`: alert, hit, death and gaits from the side (the ram's eat and walk too).
- `lineup-game-camera.jpg`: timber wolf, stag, highland ram and the farm goat it was adapted from, zoomed and at the
  full game camera framing.

The scripts: `build.py` builds one animal through the recipe's `generate()` (pass the source GLB for the stag),
`shots.py` writes the shot lists, `render.py` renders them, `sheet.py` tiles the stills and `check.py` measures each
clip's ground contact, the numbers quoted in `docs/greyhaven-wildlife.md`.
