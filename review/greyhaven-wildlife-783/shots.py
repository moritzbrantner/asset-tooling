"""shots.py <glb_dir> <set> > shots.json: the shot lists render.py takes for the #783 review sheets.

<glb_dir> holds badger.glb, river-crayfish.glb, bog-toad.glb and wolf.glb (for scale). Sets: "badger", "crayfish" and
"toad" (each one's attacks wind-up -> contact -> recovery, the toad's hop with its root travel added back, alert, hit,
death and gaits, side and three-quarter), "lineup" (the three beside the timber wolf, zoomed and at the full game camera
framing)."""
import json
import sys

glbs, which = sys.argv[1], sys.argv[2]
HOP = {"bog-toad": (6, 14, 0.6)}  # the descriptor's Attack_B rootTravel: frames and metres
shots = []


def strip(animal, clips, span, centre):
    for clip, frames in clips.items():
        for f in frames:
            fwd = 0.0
            if clip == "Attack_B" and animal in HOP:
                t0, t1, metres = HOP[animal]
                fwd = metres * min(max((f - t0) / (t1 - t0), 0.0), 1.0)
            for view, yaw in (("side", 0), ("q", 35)):
                shots.append({"glb": f"{glbs}/{animal}.glb", "clip": clip, "frame": f, "yaw": yaw, "forward": fwd, "span": span,
                              "center": [0, -(HOP[animal][2] / 2 if clip == "Attack_B" and animal in HOP else 0.0), centre],
                              "name": f"{animal}-{clip}-{f:03d}-{view}"})


if which == "badger":
    strip("badger", {"Attack_A": (0, 3, 5, 6, 7, 9, 12, 16), "Attack_B": (0, 4, 7, 9, 10, 11, 13, 16, 22),
                     "Alert": (0, 4, 8, 11, 15, 20), "Hit": (0, 2, 5), "Death": (0, 5, 10, 15, 21, 32), "Run": (0, 3, 6, 9),
                     "Walk": (0, 6, 12, 18), "Eat": (0, 6)}, 1.2, 0.18)
elif which == "crayfish":
    strip("river-crayfish", {"Attack_A": (0, 5, 10, 14, 16, 17, 18, 20, 24, 30), "Attack_B": (0, 4, 8, 10, 11, 12, 14, 18, 24),
                             "Alert": (0, 5, 10, 15, 20), "Hit": (0, 2, 5), "Death": (0, 6, 11, 15, 20, 30), "Run": (0, 3, 6, 9),
                             "Walk": (0, 6, 12, 18), "Eat": (0, 12)}, 1.6, 0.16)
elif which == "toad":
    strip("bog-toad", {"Attack_A": (0, 4, 8, 10, 11, 12, 13, 15, 19, 24), "Attack_B": (0, 4, 6, 8, 10, 12, 13, 14, 18, 24),
                       "Alert": (0, 5, 10, 15, 20), "Hit": (0, 2, 5), "Death": (0, 5, 9, 14, 21, 30), "Run": (0, 4, 7, 10),
                       "Walk": (0, 7, 14, 21), "Eat": (0, 8, 17, 26), "Idle": (0, 3)}, 1.2, 0.18)
elif which == "lineup":
    names = ["wolf", "badger", "river-crayfish", "bog-toad"]
    for view, yaw in (("side", 0), ("q", 35)):
        for tag, span in (("", 3.2), ("-full", 9.0)):
            shots.append({"glb": [f"{glbs}/{n}.glb" for n in names], "clip": ["Idle"] * 4, "frame": 0, "yaw": yaw,
                          "offset": [[0, 2.0], [0, 0.75], [0, -0.55], [0, -1.8]], "span": span, "center": [0, 0, 0.3],
                          "name": f"lineup-{view}{tag}"})
json.dump(shots, sys.stdout)
