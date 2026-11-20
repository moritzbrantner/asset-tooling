# Cave bat review (#784)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the bat except where marked full),
rendered in EEVEE under a sun in headless Blender 5.2.2 from the GLB the `greyhaven-wildlife` recipe builds on this
branch. The bat's clips are in place about its centre, so each still lifts the root into the air and adds back a
plausible flight path (`shots.py`): the dive drops 2.4 m along a 35° line to the contact, the recovery climbs away, the
launch drops from the roost and the dead bat falls to the ground by `landSeconds`. Each strip is side (top row) and
three-quarter (bottom row); frames at 24 fps.

- `dive-windup-strip.jpg`: the telegraph: 0, 2, 3 (flared upright, wings spread wide, hissing), 6, 9 (held,
  trembling), 12 (tipped nose-down, wings half-folded back).
- `dive-contact-strip.jpg`: the stoop: 0, 3, 6, 7, 8 (contact, 0.333 s: wings flung forward, feet raking, jaw shut), 9,
  12 (braking downstroke).
- `dive-recover-strip.jpg`: the exposed recovery: 0, 4, 8, 12, 16, 20 (back in the flight wingbeat).
- `launch-strip.jpg`, `land-strip.jpg`: the drop from the roost into flight, and the flare, half cartwheel and wing
  fold back onto it.
- `perch-strip.jpg`, `idle-strip.jpg`, `fly-strip.jpg`, `hit-strip.jpg`, `death-strip.jpg`: the roost loop (0, 30,
  60: the wing stretch), the hover, the wingbeat, the flinch and the death fall, landing and stillness.
- `close.jpg`: the folded roost from the front and three-quarter, the spread wing from above and in front, the
  telegraph from the target's side and the contact.
- `lineup-game-camera.jpg`: the bat in flight beside the timber wolf, zoomed and at the full game camera framing.

The scripts: `build.py` builds one animal through the recipe's `generate()` and prints its idle size and the bat's
`flight`, `shots.py` writes the shot lists, `render.py` renders them, `sheet.py` tiles the stills and `check.py`
measures each clip's lowest point (copied from #783's).
