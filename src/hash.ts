import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

export async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}
