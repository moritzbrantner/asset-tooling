"""shots.py <glb_dir> <set> > shots.json: the shot lists render.py takes for the #778 review sheets.

Sets: "clips" (every clip of both creatures at a few frames, side and three-quarter), "strips" (each creature's wind-up
-> strike -> recovery, with the pounce's root travel added back), "lineup" (both beside the timber wolf at the full game
camera), "gaits" (the lynx's gaits and the adder's slither over a loop with travel added back, to judge planting)."""
import json
import sys

glbs, which = sys.argv[1], sys.argv[2]
lynx, adder, wolf = f"{glbs}/lynx.glb", f"{glbs}/marsh-adder.glb", f"{glbs}/wolf.glb"
FPS = 24
shots = []
if which == "clips":
    for glb, clips in ((lynx, {"Idle": (0, 24, 60), "Walk": (0, 6, 12, 18), "Run": (0, 3, 5, 8), "Crouch_Stalk_Loop": (0, 9, 18, 27),
                               "Hit": (0, 2, 5), "Death": (0, 8, 14, 20, 32)}),
                       (adder, {"Idle_Coil_Loop": (0, 30), "Slither_Loop": (0, 6, 12, 18), "Warn_Hiss_Loop": (0, 8, 16, 24), "Hit": (0, 2, 5),
                                "Death": (0, 6, 12, 18, 30)})):
        tag = "lynx" if glb == lynx else "adder"
        for clip, frames in clips.items():
            for f in frames:
                for view, yaw in (("side", 0), ("q", 35)):
                    shots.append({"glb": glb, "clip": clip, "frame": f, "yaw": yaw, "name": f"{tag}-{clip}-{f:03d}-{view}"})
elif which == "strips":
    # Lynx: Pounce_Windup (12) -> Pounce_Lunge (12; the root travels 1.368 m from 3 to 8) -> Pounce_Recover (20).
    travel, t0, t1 = 1.3682, 3, 8
    for clip, frames in (("Pounce_Windup", (0, 6, 9, 12)), ("Pounce_Lunge", (3, 5, 8, 10, 12)), ("Pounce_Recover", (4, 10, 14, 20))):
        for f in frames:
            fwd = 0.0 if clip == "Pounce_Windup" else travel * min(max((f - t0) / (t1 - t0), 0), 1) if clip == "Pounce_Lunge" else travel
            for view, yaw in (("side", 0), ("q", 35)):
                shots.append({"glb": lynx, "clip": clip, "frame": f, "yaw": yaw, "forward": fwd, "span": 2.4,
                              "center": [0, -0.7, 0.3], "name": f"lynx-{clip}-{f:03d}-{view}"})
    for clip, frames in (("Warn_Hiss_Loop", (0, 12)), ("Strike", (0, 2, 4, 5, 7, 10)), ("Strike_Recover", (6, 12, 20))):
        for f in frames:
            for view, yaw in (("side", 0), ("q", 35)):
                shots.append({"glb": adder, "clip": clip, "frame": f, "yaw": yaw, "span": 1.8, "center": [0, -0.2, 0.15],
                              "name": f"adder-{clip}-{f:03d}-{view}"})
elif which == "gaits":
    for glb, tag, clip, frames, speed in ((lynx, "lynx", "Walk", 24, 0.5885), (lynx, "lynx", "Crouch_Stalk_Loop", 36, 0.208),
                                          (lynx, "lynx", "Run", 10, 2.9188), (adder, "adder", "Slither_Loop", 24, 0.46)):
        for k in range(6):
            f = round(k * frames / 6)
            shots.append({"glb": glb, "clip": clip, "frame": f, "yaw": 0, "forward": speed * f / FPS, "span": 2.0,
                          "center": [0, -speed * frames / FPS / 2, 0.3], "name": f"{tag}-{clip}-travel-{k}"})
elif which == "lineup":
    for view, yaw in (("side", 0), ("q", 35), ("front", 70)):
        shots.append({"glb": [wolf, lynx, adder], "clip": ["Idle", "Idle", "Idle_Coil_Loop"], "frame": 0, "yaw": yaw,
                      "offset": [[0, 1.6], [0, 0], [0, -1.3]] if yaw != 70 else [[-1.4, 0], [0, 0], [1.3, 0]],
                      "span": 4.2, "center": [0, 0.2, 0.3], "name": f"lineup-{view}"})
        shots.append({"glb": [wolf, lynx, adder], "clip": ["Idle", "Idle", "Idle_Coil_Loop"], "frame": 0, "yaw": yaw,
                      "offset": [[0, 1.6], [0, 0], [0, -1.3]] if yaw != 70 else [[-1.4, 0], [0, 0], [1.3, 0]],
                      "span": 9.0, "center": [0, 0, 0.3], "name": f"lineup-{view}-full"})
json.dump(shots, sys.stdout)
