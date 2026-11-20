# Badger, river crayfish and bog toad review (#783)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the animal except where marked full),
rendered in EEVEE under a sun in headless Blender 5.2.2 from the GLBs the `greyhaven-wildlife` recipe builds on this
branch. Each strip is side (top row) and three-quarter (bottom row); frames at 24 fps.

- `badger-attack-a-strip.jpg`: the quick bite: 0, 3, 5 (gathered back, jaw open), 6, 7 (contact, 0.292 s), 9 (head
  shake), 12, 16.
- `badger-attack-b-strip.jpg`: the claw rake: 0, 4, 7, 9 (reared, right paw cocked wide), 10, 11 (contact, 0.458 s),
  13 (left paw down), 16, 22.
- `river-crayfish-attack-a-strip.jpg`: the committed pinch: 0, 5, 10, 14 (claws raised and gaping, trembling), 16, 17,
  18 (contact, 0.75 s, the crusher shut), 20, 24, 30.
- `river-crayfish-attack-b-strip.jpg`: the scissor clamp: 0, 4, 8 (claws wide), 10, 11, 12 (contact, 0.5 s), 14, 18, 24.
- `bog-toad-attack-a-strip.jpg`: the spit: 0, 4, 8, 10 (drawn back, throat swollen), 11, 12, 13 (contact, 0.542 s, jaw
  gaping), 15, 19, 24.
- `bog-toad-attack-b-strip.jpg`: the hop-bite with its 0.6 m `rootTravel` added back: 0, 4 (crouch), 6, 8, 10 (flight),
  12, 13, 14 (contact, 0.583 s, landing bite), 18, 24.
- `badger-clips.jpg`, `river-crayfish-clips.jpg`, `bog-toad-clips.jpg`: alert, hit, death, gaits and eat, side.
- `lineup-game-camera.jpg`: timber wolf, badger, river crayfish and bog toad, zoomed and at the full game camera framing.

The scripts: `build.py` builds one animal through the recipe's `generate()` and prints its idle size (pass the source
GLB for a Quaternius animal), `shots.py` writes the shot lists, `render.py` renders them, `sheet.py` tiles the stills and
`check.py` measures each clip's ground contact, the numbers quoted in `docs/greyhaven-wildlife.md`.
