"""Build one authored wildlife animal through the recipe's generate(): blender -b --factory-startup -P build.py -- <repo> <animal> <out.glb>"""
import json
import os
import sys

repo, animal, out = sys.argv[sys.argv.index("--") + 1:][:3]


def load(name):
    path = os.path.join(repo, "adapters", "blender", name)
    module = {"__name__": name}
    exec(compile(open(path).read(), path, "exec"), module)
    return module


farm, wild = load("farm_animals.py"), load("wildlife.py")


class Inputs(dict):
    def load_source(self, name):
        return farm


print("OBS", json.dumps(wild["generate"](out, {"schemaVersion": 1, "animal": animal}, Inputs(farm="farm"))["clips"]))
