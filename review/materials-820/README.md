# Shared slot materials (#820)

Each sheet shows the live release before this change (top) and this branch's build (bottom), in three.js r187
(`MeshStandardMaterial` with `aoMap` and `vertexColors`, KTX2 textures, a sun and a sky hemisphere) in the bind pose.

- `male-game-camera.jpg`, `female-game-camera.jpg`: the 12 m, 0.42 rad pitch, 50° Greyhaven camera.
- `male-6m.jpg`: the male class and plate outfits at 6.5 m.
- `male-close-knight-cleric-tinker.jpg`, `female-close.jpg`: close-ups at 3.4 m.

Before, every plate had its own material copy with a 512 px occlusion texture. After, the plates keep the shared slot
materials and carry the bake in `COLOR_0` at 60 % strength. At the game camera the two match. Close up, the knight's
greaves lose the black blotches of the old texture bake; the dark spots left there are the trousers showing between the
plates, in both.
