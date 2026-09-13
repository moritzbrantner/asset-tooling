import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildMedievalCharacterKitManifest,
  generateMedievalCharacterKit,
} from "../../src/medieval-character-kit.js";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const destination = path.join(root, "build", "medieval-character-kit");
await mkdir(destination, { recursive: true });

for (const asset of generateMedievalCharacterKit()) {
  await writeFile(path.join(destination, `${asset.archetype}.obj`), asset.bytes);
}
await writeFile(
  path.join(destination, "manifest.json"),
  `${JSON.stringify(buildMedievalCharacterKitManifest(), null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({ status: "generated", destination: "build/medieval-character-kit" }));
