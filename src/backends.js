import { readFile } from "node:fs/promises";
import { resolveSpecPath } from "./schema.js";

const COPY_BACKEND = {
  id: "builtin.copy",
  version: "1",
  exactCapable: true,
  async environmentComponents() {
    return [];
  },
  async generate({ spec, root }) {
    const inputNames = Object.keys(spec.inputs);
    if (inputNames.length !== 1 || inputNames[0] !== "source") {
      throw new Error("builtin.copy requires exactly one input named 'source'");
    }
    if (Object.keys(spec.models).length !== 0) {
      throw new Error("builtin.copy does not accept models");
    }
    if (Object.keys(spec.parameters).length !== 0) {
      throw new Error("builtin.copy does not accept parameters");
    }
    if (spec.randomness.mode !== "none") {
      throw new Error("builtin.copy requires randomness.mode='none'");
    }
    return readFile(resolveSpecPath(root, spec.inputs.source.path));
  },
};

export function getBackend(generator) {
  if (generator.id === COPY_BACKEND.id && generator.version === COPY_BACKEND.version) {
    return COPY_BACKEND;
  }
  throw new Error(`unsupported generator '${generator.id}' version '${generator.version}'`);
}
