import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildMedievalCharacterKitManifest,
  generateMedievalCharacterKit,
} from "../../src/medieval-character-kit.js";
import {
  buildMedievalCharacterMaterialManifest,
  buildMedievalCharacterPackageManifest,
} from "../../src/medieval-character-materials.js";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const destination = path.join(root, "build", "medieval-character-kit");
await mkdir(destination, { recursive: true });

for (const asset of generateMedievalCharacterKit()) {
  await writeFile(path.join(destination, `${asset.archetype}.obj`), asset.bytes);
}
for (const [fileName, document] of [
  ["manifest.json", buildMedievalCharacterKitManifest()],
  ["materials.json", buildMedievalCharacterMaterialManifest()],
  ["package.json", buildMedievalCharacterPackageManifest()],
]) {
  await writeFile(path.join(destination, fileName), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ status: "generated", destination: "build/medieval-character-kit" }));
