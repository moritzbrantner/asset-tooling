import json, struct, sys
glb, gltf, out_dir = sys.argv[1:4]
b = open(glb, "rb").read(); n = struct.unpack_from("<I", b, 12)[0]; j = json.loads(b[20:20 + n])
off = 20 + n; bn = struct.unpack_from("<I", b, off)[0]
open(out_dir + "/clips.bin", "wb").write(b[off + 8:off + 8 + bn])
d = json.load(open(gltf))
nb, nv, na = len(d["buffers"]), len(d["bufferViews"]), len(d["accessors"])
for k, buf in enumerate(j["buffers"]):
    if k == 0:
        buf["uri"] = "clips.bin"
    d["buffers"].append(buf)
for v in j["bufferViews"]:
    v["buffer"] += nb
    e = v.get("extensions", {}).get("EXT_meshopt_compression")
    if e: e["buffer"] += nb
    d["bufferViews"].append(v)
for a in j["accessors"]:
    if "bufferView" in a: a["bufferView"] += nv
    d["accessors"].append(a)
names = {x.get("name"): i for i, x in enumerate(d["nodes"])}
d["animations"] = []
for an in j["animations"]:
    for s in an["samplers"]:
        s["input"] += na; s["output"] += na
    for c in an["channels"]:
        c["target"]["node"] = names[j["nodes"][c["target"]["node"]]["name"]]
    d["animations"].append(an)
json.dump(d, open(out_dir + "/ranger.gltf", "w"))
