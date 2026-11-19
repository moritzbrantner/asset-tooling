"""Runs adapters/blender/tinker_clips.py's own ``generate`` on a target GLB, as the Ranger build does, and lists the
exported clips:

    blender -b --factory-startup -P gen.py -- <target.gltf> <sockets.json> <out.glb>
"""
import json
import os
import struct
import sys

target, sockets_path, out = sys.argv[sys.argv.index("--") + 1:][:3]
recipe = {"__name__": "tinker_clips"}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "adapters", "blender", "tinker_clips.py")
exec(compile(open(path).read(), path, "exec"), recipe)
socket = next(s for s in json.load(open(sockets_path))["sockets"] if s["id"] == "hand_r.weapon")
sockets = {"weapon": {k: socket[k] for k in ("joint", "translation", "rotation")}}
observed = recipe["generate"](out, {"schemaVersion": 1, "clips": list(recipe["CLIPS"]), "sockets": sockets}, {"target": target})
data = open(out, "rb").read()
doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
print("EXPORTED", [a["name"] for a in doc["animations"]])
print("OBSERVED", json.dumps({c: {k: v for k, v in o.items() if k != "secondaryPose"} for c, o in observed["clips"].items()}))
