import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { writeIfChanged } from "../examples/reconcile-file.js";

// Preserve the exact producer dependency lock; verification never creates or repairs this file.
const destination = new URL("../adapters/dependency.lock", import.meta.url);
await writeIfChanged(fileURLToPath(destination), await readFile(new URL("../bun.lock", import.meta.url)));
