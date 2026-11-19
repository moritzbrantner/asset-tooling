"""Runs adapters/blender/ride_clips.py's own ``generate`` on a target Ranger as the Ranger build does (the arguments as
src/mounts.ts gives them, in arguments.json) and lists the exported clips:

    blender -b --factory-startup -P gen.py -- <target.gltf> <out.glb> <arguments.json>
"""
import json
import os
import struct
import sys

target, out, arguments = sys.argv[sys.argv.index("--") + 1:][:3]
recipe = {"__name__": "ride_clips"}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "adapters", "blender", "ride_clips.py")
exec(compile(open(path).read(), path, "exec"), recipe)
observed = recipe["generate"](out, json.load(open(arguments)), {"target": target})
data = open(out, "rb").read()
doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
print("EXPORTED", [a["name"] for a in doc["animations"]])
print("OBSERVED", json.dumps({c: {k: v for k, v in o.items() if k != "secondaryPose"} for c, o in observed["clips"].items()}))
