function sortJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not support non-finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new TypeError(`canonical JSON does not support undefined at ${key}`);
      }
      result[key] = sortJson(child);
    }
    return result;
  }

  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export function stablePrettyJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}
