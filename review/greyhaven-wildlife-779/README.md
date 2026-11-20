# Wildlife organic surface review (#779)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m, zoomed onto the animal), rendered in EEVEE under a
sun and a grey sky in headless Blender 5.2.2 from GLBs the `greyhaven-wildlife` recipe builds on `main` (before) and on
this branch (after), idle.

- `before-after-game-camera.jpg`: wolf, boar, bear, spider, stag, marsh lurker, lynx, marsh adder, crow and fox from the
  front three-quarter (yaw 60°), before and after side by side.
- `before-after-rear-quarter.jpg`: wolf, boar, bear, spider, stag and marsh lurker from the rear quarter (yaw 150°).

The same before/after line-up was also checked in a live Blender at the full game camera framing.

EEVEE under a plain grey sky shows little of the metallic factor itself, so the wolf's, fox's and stag's change here is
mostly their coat texture; a PBR renderer with image-based lighting also loses their dull metal sheen. The authored
animals change most: smooth shading and the fur, hide and chitin detail replace flat, faceted colour.

`build.py` builds one animal through the recipe's `generate()`
(`blender -b --factory-startup -P build.py -- <repo> <animal> <out.glb> [source.glb]`), `shots.py` writes the shot
list over `before/` and `after/` GLBs, `render.py` renders it (copied from `review/greyhaven-wildlife-782`) and
`sheet.py` tiles the stills.
