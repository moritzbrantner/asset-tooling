"""Run armor.py's generate() headless against a fit target, outside the asset pipeline (#814 fit probe).

    blender -b --factory-startup --python examples/armour-fit/build.py -- \\
        adapters/blender/armor.py <target.glb> <out dir> <kit>:<output> ...

Writes ``<out dir>/<kit>-<output>.glb`` and its observations as ``.glb.json``, the inputs of ``review.py``.
"""
import importlib.util
import json
import os
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
script, target, out = argv[:3]
spec = importlib.util.spec_from_file_location("armor", script)
armor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(armor)
os.makedirs(out, exist_ok=True)
for job in argv[3:]:
    kit, output = job.split(":")
    path = os.path.join(out, f"{kit}-{output}.glb")
    observations = armor.generate(path, {"schemaVersion": 1, "kit": kit, "output": output}, {"target": target})
    with open(path + ".json", "w") as handle:
        json.dump(observations, handle, indent=1, default=str)
    print("BUILT", path)
