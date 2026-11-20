"""python3 shots.py out.json: before/after shots, idle, at the game camera's pitch, zoomed per animal, from two yaws."""
import json, sys
H = {"wolf": 0.9, "boar": 0.95, "bear": 1.3, "spider": 0.45, "stag": 2.0, "marsh-lurker": 0.3, "lynx": 0.8, "marsh-adder": 0.25, "crow": 0.3, "fox": 0.5}
REST = {"marsh-adder": "Idle_Coil_Loop"}
shots = []
for tag in ("before", "after"):
    for a, h in H.items():
        span = max(h * 1.7, 0.9 if a == "marsh-adder" else 0.6)
        for yaw in (60, 150):
            shots.append({"glb": f"{tag}/{a}.glb", "clip": REST.get(a, "Idle"), "frame": 0, "yaw": yaw, "name": f"{tag}-{a}-{yaw}",
                          "span": round(span, 3), "center": [0, 0, round(h / 2, 3)]})
json.dump(shots, open(sys.argv[1], "w"))
