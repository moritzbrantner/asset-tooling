"""shots.py <glb_dir> <set> > shots.json: the shot lists render.py takes for the #782 review sheets.

<glb_dir> holds stag.glb, highland-ram.glb, wolf.glb, goat.glb (the farm goat, the ram's source) and stag-before.glb
(the stag as main built it). Sets: "before" (the stag before and after at the same camera, idle), "stag" and "ram" (each
one's attacks wind-up -> contact -> recovery with the charge's root travel added back, alert, hit, death and gaits),
"lineup" (stag, ram, goat and wolf side by side at the full game camera)."""
import json
import sys

glbs, which = sys.argv[1], sys.argv[2]
FPS = 24
CHARGE = {"stag": (8, 15, 2.0), "highland-ram": (6, 13, 1.6)}  # the descriptor's Attack_B rootTravel: frames and metres
shots = []


def strip(animal, clips, span, centre):
    for clip, frames in clips.items():
        for f in frames:
            fwd = 0.0
            if clip == "Attack_B":
                t0, t1, metres = CHARGE[animal]
                fwd = metres * min(max((f - t0) / (t1 - t0), 0.0), 1.0)
            for view, yaw in (("side", 0), ("q", 35)):
                shots.append({"glb": f"{glbs}/{animal}.glb", "clip": clip, "frame": f, "yaw": yaw, "forward": fwd, "span": span,
                              "center": [0, -(CHARGE[animal][2] / 2 if clip == "Attack_B" else 0.0), centre],
                              "name": f"{animal}-{clip}-{f:03d}-{view}"})


if which == "before":
    for tag, glb in (("before", "stag-before"), ("after", "stag")):
        for view, yaw in (("side", 0), ("q", 35), ("front", 70)):
            shots.append({"glb": f"{glbs}/{glb}.glb", "clip": "Idle", "frame": 0, "yaw": yaw, "span": 2.6, "center": [0, 0, 0.9],
                          "name": f"stag-{tag}-{view}"})
elif which == "stag":
    strip("stag", {"Attack_A": (0, 5, 8, 10, 11, 13, 17, 22), "Attack_B": (0, 5, 8, 11, 14, 15, 16, 20, 26, 32),
                   "Alert": (0, 4, 9, 11, 13, 17, 22), "Hit": (0, 2, 5), "Death": (0, 6, 10, 13, 16, 26), "Run": (0, 3, 6, 9)}, 2.6, 0.9)
elif which == "ram":
    strip("highland-ram", {"Attack_A": (0, 4, 7, 9, 10, 11, 13, 16, 22), "Attack_B": (0, 3, 6, 9, 12, 13, 15, 18, 22, 30),
                           "Alert": (0, 5, 8, 11, 14, 17, 20), "Hit": (0, 2, 5), "Death": (0, 6, 12, 18, 24, 32), "Run": (0, 4, 7, 11),
                           "Eat": (0, 24), "Walk": (0, 7, 14, 21)}, 1.6, 0.5)
elif which == "lineup":
    names = ["wolf", "stag", "highland-ram", "goat"]
    for view, yaw in (("side", 0), ("q", 35)):
        for tag, span in (("", 6.4), ("-full", 9.0)):
            shots.append({"glb": [f"{glbs}/{n}.glb" for n in names], "clip": ["Idle"] * 4, "frame": 0, "yaw": yaw,
                          "offset": [[0, 2.8], [0, 0.9], [0, -0.9], [0, -2.4]], "span": span, "center": [0, 0, 0.6],
                          "name": f"lineup-{view}{tag}"})
json.dump(shots, sys.stdout)
