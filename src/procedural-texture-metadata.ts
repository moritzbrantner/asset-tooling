import { createAssetRef, type AssetOperationBuildIdentity, type CanonicalJsonObject } from "./operations.js";

type Dimensions = { width: number; height: number };

/** Shared producer/lock-check contract; does not generate or resolve pixels. */
export function proceduralTextureMetadata(build: AssetOperationBuildIdentity, image: Dimensions): CanonicalJsonObject {
  const metadata: CanonicalJsonObject = { width:image.width, height:image.height, pixelFormat:"rgba8",
    colorSpace:"srgb", alphaMode:"straight", generator:`${build.operation.id}@${build.operation.version}` };
  switch (build.operation.id) {
    case "image.procedural.texture.tileable-noise": return {...metadata,tileable:true};
    case "image.procedural.height.tileable-noise": return {...metadata,field:"height",heightEncoding:"luma8",tileable:true};
    case "image.normal.from-height": {
      const wrap = build.parameters.wrap;
      if (typeof wrap !== "boolean") throw new Error("normal build must declare wrap");
      return {...metadata,field:"normal",normalEncoding:"xyz-unorm8",tangentSpace:true,
        sourceSha256:createAssetRef(build.inputs.source).sha256,wrap};
    }
    default: throw new Error(`unsupported procedural texture metadata operation '${build.operation.id}'`);
  }
}

export function proceduralTextureObservations(build: AssetOperationBuildIdentity, image: Dimensions): CanonicalJsonObject {
  const algorithm = build.implementation.algorithm, randomness = build.implementation.randomness;
  if (algorithm === undefined || randomness === undefined) throw new Error("texture build must declare algorithm and randomness");
  return {width:image.width,height:image.height,algorithm,randomness,parameters:build.parameters};
}
