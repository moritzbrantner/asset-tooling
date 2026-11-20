"""shots.py <glb_dir> <set> > shots.json: the shot lists render.py takes for the #784 review sheets.

<glb_dir> holds cave-bat.glb and wolf.glb (for scale). The bat's clips are in place about its centre, so each shot lifts
the root into the air and adds back a plausible flight path: the dive drops 2.4 m along a 35-degree line to the contact
(the descriptor's rootTravel), the recovery climbs away, the launch drops from the roost and the dead bat falls to the
ground by landSeconds. Sets: "dive" (Dive_Windup -> Dive_Contact -> Dive_Recover, side and three-quarter), "roost"
(Perch, Launch, Land), "clips" (Idle, Fly, Hit, Death), "lineup" (beside the timber wolf, zoomed and at the full game
camera framing) and "close" (the face, the folded and spread wing)."""
import json
import math
import sys

glbs, which = sys.argv[1], sys.argv[2]
BAT = f"{glbs}/cave-bat.glb"
DIVE = math.radians(35)
HIGH = 2.2  # the root's height as the dive starts
shots = []


def clamp(x):
    return min(max(x, 0.0), 1.0)


def path(clip, f):
    """(forward, lift) of the root at frame ``f`` of ``clip``."""
    if clip == "Dive_Windup":
        return 0.0, HIGH + 0.08 * clamp(f / 3) - 0.08 * clamp((f - 8) / 4)
    if clip == "Dive_Contact":
        d = 2.4 * clamp(f / 8)
        return d * math.cos(DIVE) + 0.15 * clamp((f - 8) / 4), HIGH - d * math.sin(DIVE) + 0.05 * clamp((f - 8) / 4)
    if clip == "Dive_Recover":
        x0, y0 = 2.4 * math.cos(DIVE) + 0.15, HIGH - 2.4 * math.sin(DIVE) + 0.05
        return x0 + 0.9 * f / 20, y0 - 0.06 * math.sin(math.pi * clamp(f / 10)) + 0.7 * clamp((f - 6) / 14)
    if clip == "Launch":
        return 0.5 * clamp((f - 6) / 10), HIGH - 0.35 * clamp((f - 3) / 8)
    if clip == "Land":
        return 0.5 * clamp(f / 10), HIGH - 0.35 + 0.35 * clamp(f / 12)
    if clip == "Death":
        return 0.0, HIGH - (HIGH - 0.07) * clamp((f - 3) / 11) ** 2
    return 0.0, 1.4


def strip(clips, span, views=(("side", 0), ("q", 35))):
    for clip, frames in clips.items():
        for f in frames:
            fwd, lift = path(clip, f)
            for view, yaw in views:
                shots.append({"glb": BAT, "clip": clip, "frame": f, "yaw": yaw, "forward": fwd, "lift": lift, "span": span,
                              "center": [0, -fwd, lift], "name": f"bat-{clip}-{f:03d}-{view}"})


if which == "dive":
    strip({"Dive_Windup": (0, 2, 3, 6, 9, 12), "Dive_Contact": (0, 3, 6, 7, 8, 9, 12), "Dive_Recover": (0, 4, 8, 12, 16, 20)}, 1.5)
elif which == "roost":
    strip({"Perch": (0, 30, 60), "Launch": (0, 3, 5, 7, 9, 12, 16), "Land": (0, 3, 5, 7, 9, 11, 13, 16)}, 1.3)
elif which == "clips":
    strip({"Idle": (0, 3, 6, 9), "Fly": (0, 2, 4, 6, 8), "Hit": (0, 2, 5), "Death": (0, 3, 6, 9, 12, 14, 16, 22, 30)}, 1.5)
elif which == "close":
    for clip, f, view, yaw, pitch in (("Perch", 0, "front", 90, 0.2), ("Perch", 0, "q", 40, 0.2), ("Fly", 3, "top", 60, 1.2),
                                      ("Fly", 3, "front", 90, 0.15), ("Dive_Windup", 6, "front", 70, 0.3), ("Dive_Contact", 8, "q", 40, 0.3)):
        shots.append({"glb": BAT, "clip": clip, "frame": f, "yaw": yaw, "pitch": pitch, "lift": 1.2, "span": 0.9 if clip != "Fly" else 1.5,
                      "center": [0, 0, 1.2], "name": f"close-{clip}-{f:03d}-{view}"})
elif which == "lineup":
    for view, yaw in (("side", 0), ("q", 35)):
        for tag, span in (("", 3.4), ("-full", 9.0)):
            shots.append({"glb": [f"{glbs}/wolf.glb", BAT], "clip": ["Idle", "Fly"], "frame": 3, "yaw": yaw, "offset": [[0, 1.0], [0, -0.6]],
                          "lift": [0.0, 1.4], "span": span, "center": [0, 0, 0.7], "name": f"lineup-{view}{tag}"})
json.dump(shots, sys.stdout)
