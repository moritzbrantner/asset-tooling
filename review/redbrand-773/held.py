import sys, json
args = sys.argv[sys.argv.index("--") + 1:]
recipe, item, out = args
ns = {"__name__": "held"}
exec(compile(open(recipe).read(), recipe, "exec"), ns)
obs = ns["generate"](out, {"schemaVersion": 1, "item": item}, {})
print("OBS", json.dumps({k: obs[k] for k in ("triangleCount", "bounds", "materials")}))
