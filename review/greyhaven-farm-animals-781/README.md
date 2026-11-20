# Farm animals material-quality review (#781)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m), rendered in EEVEE under a sun and a grey sky in
headless Blender 5.2.2 from GLBs the `greyhaven-farm-animals` recipe builds on `main` (before) and on this branch (after).

- `before-after-game-camera.jpg`: cow, sheep, goat, chicken, horse, donkey and pig, idle, zoomed onto each animal, before
  (top) and after (bottom).
- `lineup-game-camera.jpg`: all seven at the full game camera framing, before and after.

What drove the metallic look, read from the shipped GLBs rather than the renders:

- The pig's and sheep's exported materials were empty (no `pbrMetallicRoughness`), so glTF's defaults applied: white
  and fully metallic. Farm Animals keeps a Diffuse BSDF on its all-renderer output beside an EEVEE Principled one, and
  the exporter wrote neither. They now ship pink skin and grey-white wool with a black face, as the pack intends.
- The cow, horse and donkey sources author metallic 0.4 and roughness 0.415 on every material. They now ship metallic 0.
- Every coat, wool, skin, feather and horn material multiplies its colour by a small generated detail texture, and the
  pig, goat and chicken shade smooth below 75° creases.

EEVEE without an environment map shows little of the metallic factor itself, so the before/after difference for the
cow, horse and donkey is mostly the coat texture here. A PBR renderer with image-based lighting (the browser's
`LitMaterial.fromGltf`) also loses their dull metal sheen.

`build.py` builds one animal from a recipe file (`blender -b --factory-startup -P build.py -- <farm_animals.py> <animal>
<out.glb> [source]`), `shots.json` lists the shots over `before/` and `after/` GLBs, `render.py` renders them (copied
from `review/greyhaven-wildlife-782`) and `sheet.py` tiles the stills.
