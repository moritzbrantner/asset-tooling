import path from "node:path";
import { buildSelectedBundle, consumeSelectedBundle } from "asset-tooling/examples/selected-bundle";

const root = path.resolve(".");
const bundle = await buildSelectedBundle(root);
const acceptance = await consumeSelectedBundle(bundle.directory, bundle.manifest, path.join(root, ".artifacts", "consumer"));
console.log(JSON.stringify({ ...acceptance, expectedManifest: bundle.manifest, files: bundle.files, bytesWritten: bundle.bytesWritten, manifestStatus: bundle.manifestStatus }));
