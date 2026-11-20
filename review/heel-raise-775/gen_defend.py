"""blender -b --factory-startup -P gen_defend.py -- <recipe.py> <target.gltf> <sockets.json> <out.glb> <clip>...

Runs a stance recipe's own ``generate`` as the Ranger build's stanceFamily does and prints the observations."""
import json
import struct
import sys

recipe_path, target, sockets_path, out, *clips = sys.argv[sys.argv.index("--") + 1:]
recipe = {"__name__": "recipe"}
exec(compile(open(recipe_path).read(), recipe_path, "exec"), recipe)
desc = {s["id"]: s for s in json.load(open(sockets_path))["sockets"]}
at = lambda i: {k: desc[i][k] for k in ("joint", "translation", "rotation")}
sockets = {"weapon": at("hand_r.weapon"), "offhand": at("hand_l.weapon"), "shield": at("hand_l.shield"),
           "staff": at("hand_r.staff"), "staffLeft": at("hand_l.staff")}
observed = recipe["generate"](out, {"schemaVersion": 1, "clips": clips, "sockets": sockets}, {"target": target})
data = open(out, "rb").read()
doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
print("EXPORTED", [a["name"] for a in doc["animations"]])
