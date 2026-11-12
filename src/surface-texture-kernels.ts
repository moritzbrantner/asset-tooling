// Pure, browser-safe parts of the tileable surface recipe (docs/surface-textures.md): recipe validation, the height
// mixture, the scalar color ramp and the frozen presets. `surface-texture-recipes.ts` wraps them as content-addressed
// operations; the texture workbench (#127, docs/texture-workbench.md) runs the same functions in a Web Worker, so a
// preview and a CLI build of one recipe produce the same canonical pixels.
import type { DeepReadonly } from "./operations.js";
import type { Rgba8Image } from "./image-rgba8.js";
import { generatePatternRgba8 } from "./procedural-image.js";
import { boxBlurRgba8 } from "./image-convolution.js";
import { cropRgba8, resizeRgba8Nearest, rotateRgba8QuarterTurns } from "./image-geometry.js";
import type { TileableHeightParameters } from "./procedural-textures.js";

export type FurrowParameters = {axis:"x"|"y";count:number;depth:number;softness:number};
export type SurfaceHeightParameters = {
  seed: string; width: number; height: number; gridX: number; gridY: number;
  detailGridX: number; detailGridY: number; detailWeight: number;
  heightMin: number; heightMax: number;
  furrows?: FurrowParameters;
};
export type RgbBytes = [number, number, number];
export type ScalarColorRampParameters = { low: RgbBytes; high: RgbBytes };
export type SurfaceTextureRecipe = SurfaceHeightParameters & ScalarColorRampParameters & {
  schemaVersion: 1; seamMode: "repeat"; normalStrength: number;
  roughnessMin: number; roughnessMax: number;
};

/** Parameter keys of `image.procedural.height.surface@1`, in schema order. */
export const SURFACE_HEIGHT_KEYS = ["seed","width","height","gridX","gridY","detailGridX","detailGridY","detailWeight",
  "heightMin","heightMax","furrows"] as const;

function object(value: unknown, keys: readonly string[], location: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${location} must be a plain object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`${location} contains unknown field '${key}'`);
  for (const key of keys) if (!optional.includes(key) && !Object.hasOwn(result, key)) throw new Error(`${location} is missing '${key}'`);
  return result;
}
export { object as surfaceRecipeObject };
function integer(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
  return value;
}
export function surfaceHeightParameters(value: unknown): SurfaceHeightParameters {
  const p = object(value, SURFACE_HEIGHT_KEYS, "surface height parameters", ["furrows"]);
  if (typeof p.seed !== "string" || !/^(0|[1-9][0-9]*)$/.test(p.seed)) throw new Error("seed must be a non-negative decimal integer string");
  const width = integer(p.width, "width",1,4096), height = integer(p.height,"height",1,4096);
  const heightMin = integer(p.heightMin,"heightMin",0,255), heightMax = integer(p.heightMax,"heightMax",0,255);
  if (heightMin > heightMax) throw new Error("heightMin must not exceed heightMax");
  let furrows:FurrowParameters|undefined;
  if(Object.hasOwn(p,"furrows")) {
    const f=object(p.furrows,["axis","count","depth","softness"],"furrows");
    if(f.axis!=="x" && f.axis!=="y") throw new Error("furrow axis must be x or y");
    const extent=f.axis==="x"?width:height;
    if(extent<2) throw new Error("furrow axis requires at least two texels");
    furrows={axis:f.axis,count:integer(f.count,"furrow count",1,Math.min(64,Math.floor(extent/2))),
      depth:integer(f.depth,"furrow depth",0,255),softness:integer(f.softness,"furrow softness",0,3)};
  }
  return { seed: p.seed, width, height,
    gridX: integer(p.gridX,"gridX",1,Math.min(256,width)), gridY: integer(p.gridY,"gridY",1,Math.min(256,height)),
    detailGridX: integer(p.detailGridX,"detailGridX",1,Math.min(256,width)), detailGridY: integer(p.detailGridY,"detailGridY",1,Math.min(256,height)),
    detailWeight: integer(p.detailWeight,"detailWeight",0,255), heightMin, heightMax, ...(furrows?{furrows}:{}) };
}
function rgb(value: unknown, key: string): RgbBytes {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${key} must contain three RGB bytes`);
  return [integer(value[0],`${key}[0]`,0,255), integer(value[1],`${key}[1]`,0,255), integer(value[2],`${key}[2]`,0,255)];
}
export function scalarColorRampParameters(value: unknown): ScalarColorRampParameters {
  const p = object(value,["low","high"],"scalar color ramp parameters");
  return { low: rgb(p.low,"low"), high: rgb(p.high,"high") };
}

export function normalizeSurfaceTextureRecipe(value: unknown): SurfaceTextureRecipe {
  const p = object(value,["schemaVersion","seamMode", ...SURFACE_HEIGHT_KEYS,"low","high","normalStrength","roughnessMin","roughnessMax"],"surface recipe",["furrows"]);
  if (p.schemaVersion !== 1 || p.seamMode !== "repeat") throw new Error("surface recipe requires schemaVersion 1 and repeat seamMode");
  const height = surfaceHeightParameters(Object.fromEntries(SURFACE_HEIGHT_KEYS.filter(k=>Object.hasOwn(p,k)).map(k=>[k,p[k]])));
  const roughnessMin = integer(p.roughnessMin,"roughnessMin",0,255), roughnessMax = integer(p.roughnessMax,"roughnessMax",0,255);
  if (roughnessMin > roughnessMax) throw new Error("roughnessMin must not exceed roughnessMax");
  return { schemaVersion: 1, seamMode: "repeat", ...height, ...scalarColorRampParameters({ low: p.low, high: p.high }),
    normalStrength: integer(p.normalStrength,"normalStrength",1,1024), roughnessMin, roughnessMax };
}

/** The height-operation parameters of a normalized recipe (the recipe's other fields never enter the height build). */
export function surfaceRecipeHeightParameters(recipe: SurfaceTextureRecipe): SurfaceHeightParameters {
  return Object.fromEntries(SURFACE_HEIGHT_KEYS.filter(k=>Object.hasOwn(recipe,k)).map(k=>[k,recipe[k]])) as SurfaceHeightParameters;
}

/** Coarse (seed N) and, with a non-zero detail weight, detail (seed N+1) tileable-height invocations. */
export function surfaceHeightComponentParameters(p: SurfaceHeightParameters): TileableHeightParameters[] {
  return [{ seed: p.seed, width: p.width, height: p.height, gridX: p.gridX, gridY: p.gridY },
    ...(p.detailWeight > 0 ? [{ seed:(BigInt(p.seed)+1n).toString(),width:p.width,height:p.height,gridX:p.detailGridX,gridY:p.detailGridY }] : [])];
}

function furrowProfile(p:FurrowParameters,width:number,height:number) {
  const period=p.count*16;
  const repeated=generatePatternRgba8({width:period*3,height:1,pattern:"stripes-vertical",size:8,
    colors:[[0,0,0,255],[255,255,255,255]]});
  const softened=p.softness===0?repeated:boxBlurRgba8(boxBlurRgba8(repeated,p.softness),p.softness);
  // Both blur passes stay inside repeated data, away from the kernel's clamp border.
  const row=cropRgba8(softened,{x:period,y:0,width:period,height:1});
  switch(p.axis) {
    case "x": return resizeRgba8Nearest(row,width,height);
    case "y": return resizeRgba8Nearest(rotateRgba8QuarterTurns(row,1),width,height);
    default: {const unreachable:never=p.axis;throw new Error(`unsupported furrow axis ${unreachable}`);}
  }
}

/** Mixes the coarse/detail components, the optional furrow profile and the height range into opaque grayscale. */
export function composeSurfaceHeightRgba8(p: SurfaceHeightParameters, coarse: Rgba8Image, detail: Rgba8Image = coarse): Rgba8Image {
  const furrows=p.furrows;
  const profile=furrows?furrowProfile(furrows,p.width,p.height):undefined;
  const pixels = new Uint8Array(p.width*p.height*4);
  for (let i=0;i<pixels.length;i+=4) {
    const grain = Math.round((coarse.pixels[i]!*(255-p.detailWeight)+detail.pixels[i]!*p.detailWeight)/255);
    const mixed = profile && furrows?Math.round((grain*(255-furrows.depth)+profile.pixels[i]!*furrows.depth)/255):grain;
    const value = p.heightMin + Math.round(mixed*(p.heightMax-p.heightMin)/255);
    pixels[i]=pixels[i+1]=pixels[i+2]=value; pixels[i+3]=255;
  }
  return { width: p.width, height: p.height, pixels };
}

/** Interpolates RGB endpoints by an opaque scalar's byte value; the result is opaque. */
export function scalarColorRampRgba8(image: Rgba8Image, p: ScalarColorRampParameters): Rgba8Image {
  const pixels = new Uint8Array(image.pixels.length);
  for (let i=0;i<pixels.length;i+=4) {
    for (let c=0;c<3;c++) pixels[i+c]=Math.round((p.low[c]!*(255-image.pixels[i]!)+p.high[c]!*image.pixels[i]!)/255);
    pixels[i+3]=255;
  }
  return { width: image.width, height: image.height, pixels };
}

function preset(overrides: Partial<SurfaceTextureRecipe>): SurfaceTextureRecipe {
  return { schemaVersion: 1, seamMode: "repeat", seed: "42", width: 256, height: 256,
    gridX: 8, gridY: 8, detailGridX: 64, detailGridY: 64, detailWeight: 80,
    heightMin: 0, heightMax: 255, low: [38,23,12], high: [145,102,58],
    normalStrength: 2, roughnessMin: 180, roughnessMax: 240, ...overrides };
}
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  // Recursion above freezes every nested object and array before exposure.
  return value as DeepReadonly<T>;
}
// Immutable content presets. Replace palette arrays when creating editable variants.
export const SURFACE_TEXTURE_PRESETS = deepFreeze({
  "soil-fine": preset({ gridX: 16, gridY: 16, detailWeight: 100 }),
  "soil-coarse": preset({ gridX: 6, gridY: 6, detailWeight: 130, normalStrength: 4 }),
  "soil-directional": preset({ gridX: 3, gridY: 24, detailWeight: 60, normalStrength: 3 }),
  "soil-tilled-shallow": preset({furrows:{axis:"x",count:4,depth:140,softness:3},normalStrength:2}),
  "soil-tilled-deep": preset({furrows:{axis:"x",count:4,depth:200,softness:3},normalStrength:4}),
  "soil-tilled-crosswise": preset({furrows:{axis:"y",count:8,depth:180,softness:3},normalStrength:3}),
  "rock-smooth": preset({ low: [55,59,62], high: [160,164,166], detailWeight: 30, normalStrength: 1, roughnessMin: 110, roughnessMax: 180 }),
  "rock-grainy": preset({ low: [55,59,62], high: [160,164,166], detailWeight: 160, normalStrength: 4 }),
  "rock-layered": preset({ low: [62,54,44], high: [171,152,126], gridX: 24, gridY: 2, detailWeight: 50, normalStrength: 3 }),
  "wood-long-grain": preset({low:[52,27,12],high:[179,115,55],gridX:24,gridY:1,detailGridX:96,detailGridY:2,
    detailWeight:40,normalStrength:1,roughnessMin:130,roughnessMax:210}),
  "wood-short-grain": preset({low:[52,27,12],high:[179,115,55],gridX:24,gridY:6,detailGridX:96,detailGridY:12,
    detailWeight:40,normalStrength:1,roughnessMin:130,roughnessMax:210}),
  "wood-cross-grain": preset({low:[52,27,12],high:[179,115,55],gridX:1,gridY:24,detailGridX:2,detailGridY:96,
    detailWeight:40,normalStrength:1,roughnessMin:130,roughnessMax:210}),
  "paper-fine": preset({low:[231,226,215],high:[247,244,237],gridX:16,gridY:16,detailGridX:128,detailGridY:128,
    detailWeight:180,normalStrength:1,roughnessMin:220,roughnessMax:245}),
  "paper-coarse": preset({low:[231,226,215],high:[247,244,237],gridX:8,gridY:8,detailGridX:32,detailGridY:32,
    detailWeight:180,normalStrength:1,roughnessMin:220,roughnessMax:245}),
  "paper-fibers": preset({low:[231,226,215],high:[247,244,237],gridX:2,gridY:32,detailGridX:4,detailGridY:128,
    detailWeight:180,normalStrength:1,roughnessMin:220,roughnessMax:245}),
  "bark-ridged": preset({low:[46,34,26],high:[122,98,74],gridX:12,gridY:2,detailGridX:48,detailGridY:8,detailWeight:90,
    furrows:{axis:"x",count:12,depth:160,softness:2},normalStrength:4,roughnessMin:190,roughnessMax:250}),
  "bark-deep": preset({low:[46,34,26],high:[122,98,74],gridX:12,gridY:2,detailGridX:48,detailGridY:8,detailWeight:90,
    furrows:{axis:"x",count:8,depth:220,softness:1},normalStrength:6,roughnessMin:190,roughnessMax:250}),
  "bark-fine": preset({low:[46,34,26],high:[122,98,74],gridX:12,gridY:2,detailGridX:48,detailGridY:8,detailWeight:90,
    furrows:{axis:"x",count:24,depth:120,softness:2},normalStrength:3,roughnessMin:190,roughnessMax:250}),
  "grass-short": preset({low:[52,82,34],high:[118,156,70],gridX:16,gridY:16,detailGridX:128,detailGridY:128,
    detailWeight:150,normalStrength:2,roughnessMin:200,roughnessMax:245}),
  "grass-dense": preset({low:[52,82,34],high:[118,156,70],gridX:24,gridY:24,detailGridX:128,detailGridY:128,
    detailWeight:200,normalStrength:3,roughnessMin:200,roughnessMax:245}),
  "grass-windswept": preset({low:[52,82,34],high:[118,156,70],gridX:4,gridY:32,detailGridX:8,detailGridY:128,
    detailWeight:140,normalStrength:2,roughnessMin:200,roughnessMax:245}),
  "sand-fine": preset({low:[176,150,108],high:[226,204,160],gridX:16,gridY:16,detailGridX:128,detailGridY:128,
    detailWeight:60,normalStrength:1,roughnessMin:200,roughnessMax:240}),
  "sand-rippled": preset({low:[176,150,108],high:[226,204,160],gridX:8,gridY:8,detailGridX:128,detailGridY:128,
    detailWeight:60,furrows:{axis:"y",count:12,depth:120,softness:3},normalStrength:2,roughnessMin:200,roughnessMax:240}),
  "sand-coarse": preset({low:[176,150,108],high:[226,204,160],gridX:8,gridY:8,detailGridX:64,detailGridY:64,
    detailWeight:140,normalStrength:2,roughnessMin:200,roughnessMax:240}),
} satisfies Record<string,SurfaceTextureRecipe>);
