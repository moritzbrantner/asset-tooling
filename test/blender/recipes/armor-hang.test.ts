// #440: the armour recipe's hanging rows (sleeve cuffs, trouser legs) are built in boundary-edge order. Blender's
// extrude operator created them in the order of a pointer-keyed hash map, so the class, Redbrand and other kits with
// sleeves or trousers exported their triangles in a different order on every run and the male Ranger tar never
// repeated. With Blender, this hangs two rows from an open tube and checks the order and winding of the new faces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ARMOR = fileURLToPath(new URL("../../../adapters/blender/armor.py", import.meta.url));
const blender = process.env.ASSET_TOOLING_BLENDER;

const SCRIPT = `
import importlib.util, json, sys
import bmesh, bpy
spec = importlib.util.spec_from_file_location("armor", sys.argv[sys.argv.index("--") + 1])
armor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(armor)
bpy.ops.wm.read_factory_settings(use_empty=True)
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=False, segments=48, radius1=.1, radius2=.1, depth=.4)
mesh = bpy.data.meshes.new("tube")
bm.to_mesh(mesh)
bm.free()
tube = bpy.data.objects.new("tube", mesh)
bpy.context.scene.collection.objects.link(tube)
tube.vertex_groups.new(name="pelvis").add(list(range(len(mesh.vertices))), 1.0, "REPLACE")
garment = armor.Derived(tube, lambda p: True, .01, [])
low = lambda p: p.y < 0
garment.bm.verts.index_update()
before, kept = len(garment.bm.faces), len(garment.bm.verts)
edges = [sorted(v.index for v in e.verts) for e in garment.bm.edges if e.is_boundary and all(low(garment.at(v)) for v in e.verts)]
garment.hang(low, [lambda p: p - armor.Vector((0, .05, 0)), lambda p: p - armor.Vector((0, .1, 0))])
garment.bm.faces.ensure_lookup_table()
grown = [garment.bm.faces[i] for i in range(before, len(garment.bm.faces))]
first = [sorted(v.index for v in f.verts if v.index < kept) for f in grown[:len(edges)]]
# Every edge shared by two faces runs in opposite directions in them: one consistent winding across the new rows.
consistent = all(len(e.link_loops) != 2 or e.link_loops[0].vert is not e.link_loops[1].vert for e in garment.bm.edges)
print("HANG " + json.dumps({"edges": edges, "first": first, "grown": len(grown), "consistent": consistent}))
`;

test("#440: hung garment rows grow in boundary-edge order with one winding", { skip: !blender, timeout: 120000 }, () => {
  const run = Bun.spawnSync([blender!, "--background", "--factory-startup", "--python-exit-code", "1", "--python-expr", SCRIPT, "--", ARMOR], { stdout: "pipe", stderr: "pipe" });
  assert.equal(run.exitCode, 0, run.stderr.toString());
  const line = run.stdout.toString().split("\n").find((text) => text.startsWith("HANG "));
  assert.ok(line, run.stdout.toString());
  const { edges, first, grown, consistent } = JSON.parse(line.slice(5));
  assert.equal(edges.length, 48);
  assert.equal(grown, 2 * edges.length);
  assert.deepEqual(first, edges);
  assert.ok(consistent);
});
