"""Runs adapters/blender/move_clips.py's own ``generate`` on a target GLB, as the Ranger build does, and lists the
exported clips:

    blender -b --factory-startup -P gen.py -- <target.gltf> <out.glb>
"""
import json
import os
import struct
import sys

target, out = sys.argv[sys.argv.index("--") + 1:][:2]
recipe = {"__name__": "move_clips"}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "adapters", "blender", "move_clips.py")
exec(compile(open(path).read(), path, "exec"), recipe)
observed = recipe["generate"](out, {"schemaVersion": 1, "clips": list(recipe["CLIPS"])}, {"target": target})
data = open(out, "rb").read()
doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
print("EXPORTED", [a["name"] for a in doc["animations"]])
print("OBSERVED", json.dumps({c: {k: v for k, v in o.items() if k not in ("secondaryPose", "joints")} for c, o in observed["clips"].items()}))
