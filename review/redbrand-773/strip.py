import json, sys
p = sys.argv[1]
d = json.load(open(p))
for k in ("images", "textures", "samplers"):
    d.pop(k, None)
for key in ("extensionsUsed", "extensionsRequired"):
    if key in d:
        d[key] = [e for e in d[key] if e != "KHR_texture_basisu"]
        if not d[key]: d.pop(key)
def scrub(o):
    if isinstance(o, dict):
        for k in list(o):
            if k.endswith("Texture"): o.pop(k)
            else: scrub(o[k])
    elif isinstance(o, list):
        for x in o: scrub(x)
scrub(d.get("materials", []))
json.dump(d, open(p, "w"))
