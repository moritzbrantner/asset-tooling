"""merge_many.py <figure.gltf> <out_dir> <clips.glb>... : the figure with every clip file's animations (as review/tinker-775/merge.py)."""
import json, os, shutil, struct, sys
gltf, out_dir, *glbs = sys.argv[1:]
d = json.load(open(gltf))
for buf in d["buffers"]:
    "uri" in buf and shutil.copy(os.path.join(os.path.dirname(gltf), buf["uri"]), os.path.join(out_dir, buf["uri"]))
d["animations"] = []
names = {x.get("name"): i for i, x in enumerate(d["nodes"])}
for gi, glb in enumerate(glbs):
    b = open(glb, "rb").read(); n = struct.unpack_from("<I", b, 12)[0]; j = json.loads(b[20:20 + n])
    off = 20 + n; bn = struct.unpack_from("<I", b, off)[0]
    uri = f"clips{gi}.bin"
    open(os.path.join(out_dir, uri), "wb").write(b[off + 8:off + 8 + bn])
    nb, nv, na = len(d["buffers"]), len(d["bufferViews"]), len(d["accessors"])
    for k, buf in enumerate(j["buffers"]):
        if k == 0:
            buf["uri"] = uri
        d["buffers"].append(buf)
    for v in j["bufferViews"]:
        v["buffer"] += nb
        e = v.get("extensions", {}).get("EXT_meshopt_compression")
        if e: e["buffer"] += nb
        d["bufferViews"].append(v)
    for a in j["accessors"]:
        if "bufferView" in a: a["bufferView"] += nv
        d["accessors"].append(a)
    for an in j["animations"]:
        for s in an["samplers"]:
            s["input"] += na; s["output"] += na
        for c in an["channels"]:
            c["target"]["node"] = names[j["nodes"][c["target"]["node"]]["name"]]
        d["animations"].append(an)
for key in ("textures", "images", "samplers"):
    d.pop(key, None)
for m in d.get("materials", []):
    for k in [k for k in m if k.endswith("Texture")]:
        del m[k]
    pbr = m.get("pbrMetallicRoughness", {})
    for k in [k for k in pbr if k.endswith("Texture")]:
        del pbr[k]
    m.pop("extensions", None)
for key in ("extensionsUsed", "extensionsRequired"):
    if key in d:
        d[key] = [e for e in d[key] if e != "KHR_texture_basisu"]
json.dump(d, open(os.path.join(out_dir, "ranger.gltf"), "w"))
