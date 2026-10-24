// Shared checks for the baked effect flipbook tests (zoo-effects, combat-effects).
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

/** The JSON Schema subset the descriptor schema uses: const, enum, type, pattern, required, additionalProperties, items, $ref. */
export function conforms(schema: any, value: any, root: any, at = "$"): string[] {
  if (schema.$ref) return conforms(root.$defs[schema.$ref.split("/").pop()], value, root, at);
  if ("const" in schema) return value === schema.const ? [] : [`${at} is not ${schema.const}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at} is not one of ${schema.enum}`];
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && (schema.type === "number" || Number.isInteger(value)) ? [] : [`${at} is not a ${schema.type}`];
  if (schema.type === "boolean") return typeof value === "boolean" ? [] : [`${at} is not a boolean`];
  if (schema.type === "string") return typeof value === "string" && (!schema.pattern || new RegExp(schema.pattern).test(value)) ? [] : [`${at} is not a matching string`];
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${at} is not an array`];
    if ((schema.minItems ?? 0) > value.length || (schema.maxItems ?? Infinity) < value.length) return [`${at} has the wrong length`];
    return value.flatMap((item, i) => conforms(schema.items, item, root, `${at}[${i}]`));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${at} is not an object`];
    const errors = (schema.required ?? []).filter((key: string) => !(key in value)).map((key: string) => `${at}.${key} is missing`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...conforms(schema.properties[key], child, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`);
    }
    return errors;
  }
  return [];
}

/** Decode an 8-bit RGBA, non-interlaced PNG with only filter-0 rows (what the recipe writes). */
export function decodePng(png: Uint8Array) {
  const bytes = Buffer.from(png);
  assert.equal(bytes.toString("latin1", 1, 4), "PNG");
  let offset = 8, width = 0, height = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("latin1", offset + 4, offset + 8), data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]); }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0);
    pixels.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, pixels };
}
