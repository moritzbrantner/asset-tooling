"""blender -b --factory-startup -P build.py -- <recipe.py> <animal> <out.glb> [source]"""
import sys
recipe, animal, out, *source = sys.argv[sys.argv.index("--") + 1:]
module = {"__name__": "farm"}
exec(compile(open(recipe).read(), recipe, "exec"), module)
print("OBS", module["generate"](out, {"schemaVersion": 1, "animal": animal}, {"source": source[0]} if source else {})["materials"])
