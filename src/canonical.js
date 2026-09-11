function assertDataProperty(object, key, location) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`canonical JSON requires enumerable data properties at ${location}`);
  }
  return descriptor.value;
}

function sortJson(value, location = "$") {
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
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new TypeError(`canonical JSON does not support symbol properties at ${location}`);
      }
      if (key === "length") continue;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
        throw new TypeError(`canonical JSON does not support extra array properties at ${location}.${key}`);
      }
    }

    const result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`canonical JSON does not support sparse arrays at ${location}[${index}]`);
      }
      const child = assertDataProperty(value, String(index), `${location}[${index}]`);
      if (child === undefined) {
        throw new TypeError(`canonical JSON does not support undefined at ${location}[${index}]`);
      }
      result[index] = sortJson(child, `${location}[${index}]`);
    }
    return result;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`canonical JSON requires plain objects at ${location}`);
    }

    const result = Object.create(null);
    const keys = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new TypeError(`canonical JSON does not support symbol properties at ${location}`);
      }
      keys.push(key);
    }

    for (const key of keys.sort()) {
      const child = assertDataProperty(value, key, `${location}.${key}`);
      if (child === undefined) {
        throw new TypeError(`canonical JSON does not support undefined at ${location}.${key}`);
      }
      result[key] = sortJson(child, `${location}.${key}`);
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
