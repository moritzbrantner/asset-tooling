import { createHash, type BinaryLike } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Bytes(bytes: BinaryLike): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

export async function sha256File(filePath: string | URL): Promise<string> {
  return sha256Bytes(await readFile(filePath));
}
