// Review images for the zoo-animals release (docs/zoo-animals.md), rendered from the packaged bundle itself:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/review-zoo-animals.ts --bundle <out>/bundle --key zoo.animal.zebra --out <directory>
// Each pose is sampled from the packaged glTF clips by the profile's own sampler (withClipPose) and written as a
// static posed GLB; adapters/blender/zoo_animals_review.py lays them out at Zoo's camera (yaw −38°, pitch 46°, 36°
// vertical field of view) and renders the park and watch views, two orbit angles, pose strips and a walk loop.
// The images are evidence for the owner's review, not approval, and no build reads them.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { NodeIO, type Document } from "@gltf-transform/core";
import { parseGltfResourcesBundleManifest, readAssetBundleGltf } from "../src/asset-bundle.js";
import { withClipPose } from "../src/quadruped-rigid.js";

type Pose = { id: string; key: string; variant: string; clip: string | null; time: number };

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) { console.error(`Usage: bun scripts/review-zoo-animals.ts --bundle <bundle dir> --key <key> --out <directory> [--compare <key/variant>]`); process.exit(2); }
  return value;
}

/** A static copy of `document` in the pose of `clip` at `time` (seconds), with its clips removed. */
async function posed(io: NodeIO, document: Document, clip: string | null, time: number): Promise<Uint8Array> {
  const copy = await io.readBinary(await io.writeBinary(document));
  const animation = copy.getRoot().listAnimations().find((candidate) => candidate.getName() === clip);
  const bake = () => {
    const nodes = copy.getRoot().listNodes().map((node) => [node, node.getTranslation(), node.getRotation(), node.getScale()] as const);
    return nodes;
  };
  const frozen = animation ? withClipPose(copy, animation, time, bake) : bake();
  for (const [node, translation, rotation, scale] of frozen) node.setTranslation(translation).setRotation(rotation).setScale(scale);
  for (const each of copy.getRoot().listAnimations()) each.dispose();
  return io.writeBinary(copy);
}

const seconds = (document: Document, clip: string) => Math.max(...document.getRoot().listAnimations().find((a) => a.getName() === clip)!
  .listSamplers().map((sampler) => { const times = sampler.getInput()!.getArray()!; return times[times.length - 1]!; }));

const bundleDir = path.resolve(option("bundle"));
const key = option("key");
const variant = option("variant", "expressive");
const compare = option("compare", "zoo.animal.zebra/default");
const out = path.resolve(option("out"));
await mkdir(path.join(out, "poses"), { recursive: true });

const io = new NodeIO();
const manifest = parseGltfResourcesBundleManifest(await readFile(path.join(bundleDir, "manifest.json")));
const load = async (entryKey: string, entryVariant: string) => {
  const { gltf, resources } = await readAssetBundleGltf(bundleDir, manifest, entryKey, entryVariant);
  return io.readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) });
};
const candidate = await load(key, variant);
const [compareKey, compareVariant] = compare.split("/") as [string, string];
const current = await load(compareKey, compareVariant);

const poses: Pose[] = [{ id: "current-idle", key: compareKey, variant: compareVariant, clip: "idle", time: 0 },
  { id: "current-walk", key: compareKey, variant: compareVariant, clip: "walk", time: seconds(current, "walk") * 0.25 }];
for (const clip of ["idle", "walk", "feed", "rest"]) {
  const length = seconds(candidate, clip);
  const steps = clip === "walk" ? 12 : 4;
  for (let step = 0; step < steps; step += 1) poses.push({ id: `${clip}-${step}`, key, variant, clip, time: (length * step) / steps });
}
for (const pose of poses) {
  const document = pose.key === key && pose.variant === variant ? candidate : current;
  await writeFile(path.join(out, "poses", `${pose.id}.glb`), await posed(io, document, pose.clip, pose.time));
}
const plan = { title: `${key}/${variant}`, poses: poses.map(({ id, clip, time }) => ({ id, clip, time: +time.toFixed(3) })) };
await writeFile(path.join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

const blender = process.env.ASSET_TOOLING_BLENDER;
if (!blender) { console.error("set ASSET_TOOLING_BLENDER to Blender 5.2.2"); process.exit(2); }
const script = path.resolve(import.meta.dir, "../adapters/blender/zoo_animals_review.py");
const run = spawnSync(blender, ["-b", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", out], { stdio: ["ignore", "ignore", "inherit"] });
if (run.status !== 0) process.exit(run.status ?? 1);

// The walk frames sample one stride evenly, so they loop as a GIF at the clip's own pace, with one shared palette.
const walkFrames = poses.filter((pose) => pose.clip === "walk" && pose.key === key).length;
const fps = walkFrames / seconds(candidate, "walk");
const gif = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(out, "walk-frames", "%02d.jpg"),
  "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0", path.join(out, "walk.gif")], { stdio: ["ignore", "ignore", "inherit"] });
if (gif.status !== 0) { console.error("ffmpeg could not write walk.gif (bun scripts/install-ffmpeg.ts installs it)"); process.exit(gif.status ?? 1); }
console.log(JSON.stringify({ out, poses: poses.length }, null, 2));
