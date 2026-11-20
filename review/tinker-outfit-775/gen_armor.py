"""blender -b --factory-startup -P gen_armor.py -- <armor.py> <target.glb> <kit> <out_dir>

Runs armor.py's own ``generate`` for both outputs, as the Ranger build does, and writes <out_dir>/{plates,cloth}.{glb,json}."""
import json
import os
import sys

recipe_path, target, kit, out_dir = sys.argv[sys.argv.index("--") + 1:][:4]
for output in ("plates", "cloth"):
    recipe = {"__name__": "recipe"}
    exec(compile(open(recipe_path).read(), recipe_path, "exec"), recipe)
    observed = recipe["generate"](os.path.join(out_dir, f"{output}.glb"), {"schemaVersion": 1, "kit": kit, "output": output}, {"target": target})
    json.dump(observed, open(os.path.join(out_dir, f"{output}.json"), "w"), indent=1)
    print("PIECES", output, [(p["node"], p["triangleCount"], p["hides"]) for p in observed["pieces"]])
