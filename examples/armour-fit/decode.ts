// Decode a published gltf-resources bundle file (meshopt, quantized, KTX2) into a plain GLB that Blender imports, for
// the armour fit probe (#814): bun examples/armour-fit/decode.ts <in.gltf|in.glb> <out.glb>. Needs `ktx` (KTX-Software).
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dequantize } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const [input, output] = process.argv.slice(2);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(input!);
const dir = path.dirname(input!);
const tmp = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "decode-"));
for (const texture of doc.getRoot().listTextures()) {
  const uri = texture.getURI();
  if (texture.getMimeType() !== "image/ktx2") continue;
  const png = path.join(tmp, path.basename(uri).replace(/\.ktx2$/, ".png"));
  execFileSync("ktx", ["extract", "--transcode", "rgba8", path.join(dir, uri), png]);
  texture.setImage(new Uint8Array(readFileSync(png))).setMimeType("image/png").setURI(path.basename(png));
}
for (const ext of doc.getRoot().listExtensionsUsed()) {
  if (["EXT_meshopt_compression", "KHR_texture_basisu", "KHR_mesh_quantization"].includes(ext.extensionName)) ext.dispose();
}
await doc.transform(dequantize());
await io.write(output!, doc);
