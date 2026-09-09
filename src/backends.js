import { readFile } from "node:fs/promises";
import { resolveSpecPath } from "./schema.js";
import { STABLE_DIFFUSION_BACKEND } from "./model-backends.js";

const MASK_64 = (1n << 64n) - 1n;

function assertExactParameterKeys(parameters, allowed, backendId) {
  for (const key of Object.keys(parameters)) {
    if (!allowed.has(key)) {
      throw new Error(`${backendId} does not accept parameter '${key}'`);
    }
  }
}

function assertInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  }
}

function assertColor(value, name) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/.test(value)) {
    throw new Error(`${name} must be a lowercase #rrggbb color`);
  }
}

function splitMix64(seed) {
  let state = BigInt(seed) & MASK_64;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK_64;
    let value = state;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return (value ^ (value >> 31n)) & MASK_64;
  };
}

function randomInteger(next, exclusiveMaximum) {
  return Number(next() % BigInt(exclusiveMaximum));
}

const COPY_BACKEND = {
  id: "builtin.copy",
  version: "1",
  kind: "utility",
  exactCapable: true,
  async environmentComponents() {
    return [];
  },
  validate({ spec }) {
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
  },
  async generate(document) {
    this.validate(document);
    const { spec, root } = document;
    return {
      bytes: await readFile(resolveSpecPath(root, spec.inputs.source.path)),
      observations: {
        operation: "copy",
        sourceInput: "source",
      },
    };
  },
};

const PROCEDURAL_SVG_SCATTER_BACKEND = {
  id: "builtin.procedural.svg-scatter",
  version: "1",
  kind: "procedural",
  exactCapable: true,
  async environmentComponents() {
    return [
      {
        id: "asset-tooling.prng",
        algorithm: "splitmix64-v1",
        integerDomain: "uint64",
      },
    ];
  },
  validate({ spec }) {
    if (Object.keys(spec.inputs).length !== 0) {
      throw new Error(`${this.id} does not accept inputs`);
    }
    if (Object.keys(spec.models).length !== 0) {
      throw new Error(`${this.id} does not accept models`);
    }
    if (spec.randomness.mode !== "seeded") {
      throw new Error(`${this.id} requires randomness.mode='seeded'`);
    }

    const parameters = spec.parameters;
    assertExactParameterKeys(
      parameters,
      new Set(["width", "height", "count", "minRadius", "maxRadius", "background", "palette"]),
      this.id,
    );
    assertInteger(parameters.width, "parameters.width", 1, 4096);
    assertInteger(parameters.height, "parameters.height", 1, 4096);
    assertInteger(parameters.count, "parameters.count", 1, 10000);
    assertInteger(parameters.minRadius, "parameters.minRadius", 1, 2048);
    assertInteger(parameters.maxRadius, "parameters.maxRadius", parameters.minRadius, 2048);
    if (parameters.maxRadius * 2 > Math.min(parameters.width, parameters.height)) {
      throw new Error("parameters.maxRadius must fit inside both canvas dimensions");
    }
    assertColor(parameters.background, "parameters.background");
    if (!Array.isArray(parameters.palette) || parameters.palette.length < 1 || parameters.palette.length > 32) {
      throw new Error("parameters.palette must contain 1..32 colors");
    }
    parameters.palette.forEach((color, index) => assertColor(color, `parameters.palette[${index}]`));
  },
  async generate(document) {
    this.validate(document);
    const { parameters, randomness } = document.spec;
    const next = splitMix64(randomness.seed);
    const lines = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${parameters.width}" height="${parameters.height}" viewBox="0 0 ${parameters.width} ${parameters.height}">`,
      `  <rect width="${parameters.width}" height="${parameters.height}" fill="${parameters.background}"/>`,
    ];

    for (let index = 0; index < parameters.count; index += 1) {
      const radius = parameters.minRadius + randomInteger(next, parameters.maxRadius - parameters.minRadius + 1);
      const x = radius + randomInteger(next, parameters.width - radius * 2 + 1);
      const y = radius + randomInteger(next, parameters.height - radius * 2 + 1);
      const color = parameters.palette[randomInteger(next, parameters.palette.length)];
      lines.push(`  <circle cx="${x}" cy="${y}" r="${radius}" fill="${color}"/>`);
    }
    lines.push("</svg>");
    return {
      bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
      observations: {
        algorithm: "svg-scatter-v1",
        prng: "splitmix64-v1",
        generatedElementCount: parameters.count,
      },
    };
  },
};

const BACKENDS = [COPY_BACKEND, PROCEDURAL_SVG_SCATTER_BACKEND, STABLE_DIFFUSION_BACKEND];

export function getBackend(generator) {
  const backend = BACKENDS.find(
    (candidate) => candidate.id === generator.id && candidate.version === generator.version,
  );
  if (backend) return backend;
  throw new Error(`unsupported generator '${generator.id}' version '${generator.version}'`);
}
