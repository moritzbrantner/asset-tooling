"""Build one wildlife animal through the recipe's generate(): blender -b --factory-startup -P build.py -- <repo> <animal> <out.glb> [source.glb]"""
import json
import os
import sys

repo, animal, out, *source = sys.argv[sys.argv.index("--") + 1:]


def load(name):
    path = os.path.join(repo, "adapters", "blender", name)
    module = {"__name__": name}
    exec(compile(open(path).read(), path, "exec"), module)
    return module


farm, wild = load("farm_animals.py"), load("wildlife.py")


class Inputs(dict):
    def load_source(self, name):
        return farm


inputs = Inputs(farm="farm", **({"source": source[0]} if source else {}))
print("OBS", json.dumps(wild["generate"](out, {"schemaVersion": 1, "animal": animal}, inputs)["clips"]))
