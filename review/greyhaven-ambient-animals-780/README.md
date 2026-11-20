# Ambient animals organic surface review (#780)

Stills at the mmorpg game camera's angle (0.42 rad pitch from 12 m), rendered in EEVEE under a sun and a grey sky in a
live Blender 5.3 from GLBs the `greyhaven-ambient-animals` recipe builds on `main` (before) and on this branch (after).
The GLBs were built headless with the pinned Blender 5.2.2.

- `before-after-game-camera.jpg`: the cat, dog and rodent, idle, zoomed onto each animal, from the front
  three-quarter (yaw 60°) and the rear quarter (yaw 150°), before and after.
- `before-after-walk.jpg`: the same animals at Walk frame 8, head-on, before (top) and after (bottom); the welded dog
  and rodent skin and pose as before.
- `lineup-game-camera.jpg`: all six at the full game camera framing (50° field of view), before in front.

What drove the metallic, faceted look, read from the shipped GLBs:

- The dog's and rodent's materials passed the Quaternius sources' metallic 0.4 and roughness 0.415 through. The cat
  was already nonmetallic (roughness 0.8) since #799. No material was empty (the farm pig's and sheep's cause, #781).
- The dog's and rodent's meshes were fully flat-shaded: every triangle had its own three vertices.
- All three were plain colours without UVs, and the cat's near-black fur (0.07) showed no surface at all.

EEVEE under a plain grey sky shows little of the metallic factor itself; a PBR renderer with image-based lighting (the
browser's `LitMaterial.fromGltf`) also loses the dog's and rodent's dull metal sheen.
