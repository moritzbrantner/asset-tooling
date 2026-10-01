import path from "node:path";
import { canonicalJson, compareCodeUnitStrings } from "./canonical.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { encodeRgba8Image, parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "./image-rgba8.js";
import {
  createAssetOperationBuildIdentity, createAssetOperationRegistry, createAssetRef, parseAssetRef,
  normalizeAssetOperationResult, type AssetRef, type AssetOperationBuildIdentity,
} from "./operations.js";
import { captureToolIdentity } from "./tool.js";

export const SPRITE_ATLAS_MEDIA_TYPE = "application/vnd.moritzbrantner.sprite-atlas+json";
const MAX_DIMENSION = 4096;
const MAX_SPRITES = 512;
const MAX_SOURCE_PIXELS = 16 * 1024 * 1024;
const tokenPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export type SpriteFrame = {
  sequence: string;
  index: number;
  timeMs: number;
  durationMs: number;
  loop: boolean;
};
export type SpriteDeclaration = {
  id: string;
  pivot: { x: number; y: number };
  frame?: SpriteFrame;
};
export type SpriteAtlasParameters = {
  width: number;
  maxHeight: number;
  padding: number;
  extrusion: number;
  trim: boolean;
  sprites: SpriteDeclaration[];
};
export type SpriteAtlasEntry = SpriteDeclaration & {
  source: AssetRef;
  sourceSize: { width: number; height: number };
  rect: { x: number; y: number; width: number; height: number };
  trimOffset: { x: number; y: number };
  empty: boolean;
  rotated: false;
};
export type SpriteAtlasManifest = {
  schemaVersion: 1;
  image: AssetRef;
  width: number;
  height: number;
  coordinates: "top-left-pixels";
  colorSpace: "srgb";
  alphaMode: "straight";
  padding: number;
  extrusion: number;
  sprites: SpriteAtlasEntry[];
};
type Invocation = { parameters?: unknown; inputs?: unknown };
const integerSchema = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const frameSchema = {
  type: "object", additionalProperties: false,
  required: ["sequence", "index", "timeMs", "durationMs", "loop"],
  properties: {
    sequence: { type: "string", pattern: tokenPattern.source, maxLength: 128 },
    index: integerSchema(0, 1_000_000), timeMs: integerSchema(0, 86_400_000),
    durationMs: integerSchema(1, 86_400_000), loop: { type: "boolean" },
  },
};
const registry = createAssetOperationRegistry([{
  schemaVersion: 1, id: "image.sprite-atlas", version: "1", category: "image.packaging",
  label: "Assemble deterministic sprite atlas",
  description: "Pack selected straight-alpha images in stable ID order with lossless visible-pixel trimming and edge extrusion. Rotation is unsupported.",
  inputs: [{ id: "sprites", assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE], cardinality: { min: 1, max: MAX_SPRITES } }],
  outputs: [
    { id: "image", assetKinds: ["image"], mediaTypes: [RGBA8_IMAGE_MEDIA_TYPE] },
    { id: "manifest", assetKinds: ["sprite-atlas"], mediaTypes: [SPRITE_ATLAS_MEDIA_TYPE] },
  ],
  parameterSchema: {
    type: "object", additionalProperties: false,
    required: ["width", "maxHeight", "padding", "extrusion", "trim", "sprites"],
    properties: {
      width: integerSchema(1, MAX_DIMENSION), maxHeight: integerSchema(1, MAX_DIMENSION),
      padding: integerSchema(0, 32), extrusion: integerSchema(0, 32), trim: { type: "boolean" },
      sprites: { type: "array", minItems: 1, maxItems: MAX_SPRITES, items: {
        type: "object", additionalProperties: false, required: ["id", "pivot"],
        properties: {
          id: { type: "string", pattern: tokenPattern.source, maxLength: 128 },
          pivot: { type: "object", additionalProperties: false, required: ["x", "y"], properties: {
            x: { type: "number", minimum: 0, maximum: 8192 }, y: { type: "number", minimum: 0, maximum: 8192 },
          } },
          frame: frameSchema,
        },
      } },
    },
  },
}]);
// The literal registration above owns this key.
export const SPRITE_ATLAS_OPERATION = registry.get("image.sprite-atlas", "1")!;

function object(value: unknown, required: string[], optional: string[], location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${location} must be a plain object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!required.includes(key) && !optional.includes(key)) throw new Error(`${location} contains unknown field '${key}'`);
  for (const key of required) if (!Object.hasOwn(result, key)) throw new Error(`${location} is missing '${key}'`);
  return result;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}
function token(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 128 || !tokenPattern.test(value)) throw new Error(`${name} must be a portable lowercase token of at most 128 characters`);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function pivotCoordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8192) throw new Error("pivot coordinates must be finite source-pixel positions in 0..8192");
  return value;
}
function declaration(value: unknown): SpriteDeclaration {
  const sprite = object(value, ["id", "pivot"], ["frame"], "sprite");
  const pivot = object(sprite.pivot, ["x", "y"], [], "sprite.pivot");
  const result: SpriteDeclaration = { id: token(sprite.id, "sprite.id"), pivot: { x: pivotCoordinate(pivot.x), y: pivotCoordinate(pivot.y) } };
  if (Object.hasOwn(sprite, "frame")) {
    const frame = object(sprite.frame, ["sequence", "index", "timeMs", "durationMs", "loop"], [], "sprite.frame");
    result.frame = {
      sequence: token(frame.sequence, "frame.sequence"), index: integer(frame.index, "frame.index", 0, 1_000_000),
      timeMs: integer(frame.timeMs, "frame.timeMs", 0, 86_400_000), durationMs: integer(frame.durationMs, "frame.durationMs", 1, 86_400_000),
      loop: boolean(frame.loop, "frame.loop"),
    };
  }
  return result;
}
function parameters(value: unknown): SpriteAtlasParameters {
  const p = object(value, ["width", "maxHeight", "padding", "extrusion", "trim", "sprites"], [], "atlas parameters");
  if (!Array.isArray(p.sprites) || p.sprites.length < 1 || p.sprites.length > MAX_SPRITES) throw new Error(`sprites must contain 1..${MAX_SPRITES} declarations`);
  const sprites = p.sprites.map(declaration);
  if (new Set(sprites.map(s => s.id)).size !== sprites.length) throw new Error("sprite IDs must be unique");
  const sequences = new Map<string, SpriteFrame[]>();
  for (const { frame } of sprites) if (frame) {
    const frames = sequences.get(frame.sequence) ?? [];
    frames.push(frame); sequences.set(frame.sequence, frames);
  }
  for (const frames of sequences.values()) {
    frames.sort((a, b) => a.index - b.index);
    for (let i = 1; i < frames.length; i++) {
      const previous = frames[i - 1]!, current = frames[i]!;
      if (previous.index === current.index || previous.timeMs + previous.durationMs > current.timeMs || previous.loop !== current.loop) throw new Error("sequence frame indices/times must be unique, ordered, non-overlapping and share loop policy");
    }
  }
  return {
    width: integer(p.width, "width", 1, MAX_DIMENSION), maxHeight: integer(p.maxHeight, "maxHeight", 1, MAX_DIMENSION),
    padding: integer(p.padding, "padding", 0, 32), extrusion: integer(p.extrusion, "extrusion", 0, 32),
    trim: boolean(p.trim, "trim"), sprites,
  };
}

/** Validate original producer metadata for portable distribution without evaluating animation or repacking. */
export function parseSpriteAtlasManifest(bytes: Uint8Array): SpriteAtlasManifest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8 * 1024 * 1024) throw new Error("atlas manifest exceeds 8 MiB budget");
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const p = object(raw, ["schemaVersion", "image", "width", "height", "coordinates", "colorSpace", "alphaMode", "padding", "extrusion", "sprites"], [], "atlas manifest");
  if (p.schemaVersion !== 1 || p.coordinates !== "top-left-pixels" || p.colorSpace !== "srgb" || p.alphaMode !== "straight") throw new Error("unsupported atlas manifest semantics");
  if (!Array.isArray(p.sprites) || p.sprites.length<1 || p.sprites.length>MAX_SPRITES) throw new Error("atlas sprites must contain 1..512 entries");
  const entries = p.sprites.map(value => object(value, ["id", "pivot", "source", "sourceSize", "rect", "trimOffset", "empty", "rotated"], ["frame"], "atlas sprite"));
  const controls = parameters({width:p.width,maxHeight:p.height,padding:p.padding,extrusion:p.extrusion,trim:true,
    sprites:entries.map(e=>({id:e.id,pivot:e.pivot,...(Object.hasOwn(e,"frame")?{frame:e.frame}:{})}))});
  const image = parseAssetRef(p.image);
  function canonicalImage(source: AssetRef): void {
    if (source.kind !== "image" || source.mediaType !== RGBA8_IMAGE_MEDIA_TYPE) throw new Error("atlas resource must be a canonical RGBA8 image");
  }
  canonicalImage(image);
  const sprites: SpriteAtlasEntry[] = entries.map((e,index)=>{
    const source=parseAssetRef(e.source);canonicalImage(source);
    const size=object(e.sourceSize,["width","height"],[],"sprite source size"),rect=object(e.rect,["x","y","width","height"],[],"sprite rect"),offset=object(e.trimOffset,["x","y"],[],"sprite trim offset");
    const sourceSize={width:integer(size.width,"source width",1,8192),height:integer(size.height,"source height",1,8192)};
    const rectangle={x:integer(rect.x,"rect x",0,MAX_DIMENSION),y:integer(rect.y,"rect y",0,MAX_DIMENSION),
      width:integer(rect.width,"rect width",1,MAX_DIMENSION),height:integer(rect.height,"rect height",1,MAX_DIMENSION)};
    const trimOffset={x:integer(offset.x,"trim x",0,8192),y:integer(offset.y,"trim y",0,8192)};
    const declared=controls.sprites[index]!,empty=boolean(e.empty,"sprite empty"),margin=controls.padding+controls.extrusion;
    if (e.rotated !== false) throw new Error("rotated atlas sprites are unsupported");
    if (declared.pivot.x>sourceSize.width || declared.pivot.y>sourceSize.height || trimOffset.x+rectangle.width>sourceSize.width || trimOffset.y+rectangle.height>sourceSize.height) throw new Error("sprite pivot/trim exceeds source bounds");
    if (rectangle.x<margin || rectangle.y<margin || rectangle.x+rectangle.width+margin>controls.width || rectangle.y+rectangle.height+margin>controls.maxHeight) throw new Error("sprite rect/padding/extrusion exceeds atlas bounds");
    if (empty && (rectangle.width!==1 || rectangle.height!==1 || trimOffset.x!==0 || trimOffset.y!==0)) throw new Error("empty sprite must use the original one-pixel placeholder");
    return {...declared,source,sourceSize,rect:rectangle,trimOffset,empty,rotated:false};
  });
  const margin=controls.padding+controls.extrusion;
  for(let i=0;i<sprites.length;i++) {
    if(i>0 && compareCodeUnitStrings(sprites[i-1]!.id,sprites[i]!.id)>=0) throw new Error("atlas sprite IDs must have stable sorted ordering");
    const a=sprites[i]!.rect;
    for(let j=0;j<i;j++) {
      const b=sprites[j]!.rect;
      if(a.x-margin<b.x+b.width+margin && b.x-margin<a.x+a.width+margin && a.y-margin<b.y+b.height+margin && b.y-margin<a.y+a.height+margin) throw new Error("atlas sprite footprints overlap");
    }
  }
  return {schemaVersion:1,image,width:controls.width,height:controls.maxHeight,coordinates:"top-left-pixels",colorSpace:"srgb",alphaMode:"straight",
    padding:controls.padding,extrusion:controls.extrusion,sprites};
}
function assertRoot(root: string): void {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("sprite atlas root must be an absolute path");
}
type Source = { declaration: SpriteDeclaration; asset: AssetRef; image: ReturnType<typeof parseRgba8Image> };
async function sources(root: string, p: SpriteAtlasParameters, inputs: unknown): Promise<Source[]> {
  const map = object(inputs, ["sprites"], [], "atlas inputs");
  if (!Array.isArray(map.sprites) || map.sprites.length !== p.sprites.length) throw new Error("one source asset is required for each sprite declaration");
  const result: Source[] = [];
  let pixelCount = 0;
  for (let i = 0; i < p.sprites.length; i++) {
    const asset = createAssetRef(map.sprites[i]);
    if (asset.kind !== "image" || asset.mediaType !== RGBA8_IMAGE_MEDIA_TYPE) throw new Error("sprite source must be a canonical RGBA8 image");
    // Each image is bounded before decoding; cap the combined decoded working set too.
    if (asset.byteLength > 96 * 1024 * 1024) throw new Error("sprite source exceeds encoded byte budget");
    const image = parseRgba8Image(await resolveAssetObject(root, asset));
    pixelCount += image.width * image.height;
    if (pixelCount > MAX_SOURCE_PIXELS) throw new Error("sprite sources exceed the 16-megapixel budget");
    const sprite = p.sprites[i]!;
    if (sprite.pivot.x > image.width || sprite.pivot.y > image.height) throw new Error(`sprite '${sprite.id}' pivot exceeds source dimensions`);
    result.push({ declaration: sprite, asset, image });
  }
  return result.sort((a, b) => compareCodeUnitStrings(a.declaration.id, b.declaration.id));
}
async function prepare(root: string, invocation: Invocation) {
  assertRoot(root);
  const p = parameters(invocation.parameters);
  const selected = await sources(root, p, invocation.inputs);
  p.sprites = selected.map(s => s.declaration);
  const build = createAssetOperationBuildIdentity({
    operation: SPRITE_ATLAS_OPERATION, parameters: p, inputs: { sprites: selected.map(s => s.asset) },
    implementation: { id: "builtin.image.sprite-atlas", version: "1", algorithm: "id-sorted-shelf-alpha-trim-edge-extrusion-v1", tool: await captureToolIdentity() },
  });
  return { p, selected, build };
}
export async function createSpriteAtlasOperationBuildIdentity(root: string, invocation: Invocation = {}): Promise<AssetOperationBuildIdentity> {
  return (await prepare(root, invocation)).build;
}

function visibleBounds(source: Source, trim: boolean) {
  const { width, height, pixels } = source.image;
  if (!trim) return { x: 0, y: 0, width, height, empty: false };
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3]! > 0) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? { x: 0, y: 0, width: 1, height: 1, empty: true }
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, empty: false };
}
function layout(selected: Source[], p: SpriteAtlasParameters) {
  const margin = p.padding + p.extrusion;
  let x = 0, y = 0, rowHeight = 0;
  const placements = selected.map(source => {
    const bounds = visibleBounds(source, p.trim);
    const width = bounds.width + margin * 2, height = bounds.height + margin * 2;
    if (width > p.width || height > p.maxHeight) throw new Error(`sprite '${source.declaration.id}' does not fit atlas bounds`);
    if (x + width > p.width) { x = 0; y += rowHeight; rowHeight = 0; }
    if (y + height > p.maxHeight) throw new Error("sprites exceed atlas maxHeight");
    const placement = { source, bounds, x: x + margin, y: y + margin };
    x += width; rowHeight = Math.max(rowHeight, height);
    return placement;
  });
  return { placements, height: y + rowHeight };
}
export async function executeSpriteAtlasOperation(root: string, invocation: Invocation = {}) {
  const { p, selected, build } = await prepare(root, invocation);
  const packed = layout(selected, p);
  const pixels = Buffer.alloc(p.width * packed.height * 4);
  const entries: SpriteAtlasEntry[] = [];
  for (const { source, bounds, x, y } of packed.placements) {
    if (!bounds.empty) for (let dy = -p.extrusion; dy < bounds.height + p.extrusion; dy++) {
      for (let dx = -p.extrusion; dx < bounds.width + p.extrusion; dx++) {
        const sx = bounds.x + Math.max(0, Math.min(bounds.width - 1, dx));
        const sy = bounds.y + Math.max(0, Math.min(bounds.height - 1, dy));
        const offset = (sy * source.image.width + sx) * 4;
        source.image.pixels.copy(pixels, ((y + dy) * p.width + x + dx) * 4, offset, offset + 4);
      }
    }
    entries.push({ ...source.declaration, source: source.asset,
      sourceSize: { width: source.image.width, height: source.image.height },
      rect: { x, y, width: bounds.width, height: bounds.height }, trimOffset: { x: bounds.x, y: bounds.y },
      empty: bounds.empty, rotated: false,
    });
  }
  const image = (await storeAssetObject(root, {
    bytes: encodeRgba8Image({ width: p.width, height: packed.height, pixels }), kind: "image", mediaType: RGBA8_IMAGE_MEDIA_TYPE,
    metadata: { width: p.width, height: packed.height, colorSpace: "srgb", alphaMode: "straight", generator: "image.sprite-atlas@1", sourceSha256s: selected.map(s => s.asset.sha256) },
  })).asset;
  const manifest: SpriteAtlasManifest = { schemaVersion: 1, image, width: p.width, height: packed.height,
    coordinates: "top-left-pixels", colorSpace: "srgb", alphaMode: "straight", padding: p.padding, extrusion: p.extrusion, sprites: entries };
  const storedManifest = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(manifest)}\n`),
    kind: "sprite-atlas", mediaType: SPRITE_ATLAS_MEDIA_TYPE,
    metadata: { imageSha256: image.sha256, sourceSha256s: selected.map(s => s.asset.sha256), spriteCount: entries.length },
  })).asset;
  return normalizeAssetOperationResult(SPRITE_ATLAS_OPERATION, {
    outputs: { image, manifest: storedManifest }, observations: { build, width: p.width, height: packed.height, spriteCount: entries.length, sourcePixels: selected.reduce((sum, s) => sum + s.image.width * s.image.height, 0) },
  });
}
