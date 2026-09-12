# Texture and material operations

`asset-tooling` treats material preparation as reproducible asset composition. It does not own renderer or shader behavior.

## ORM packing

`texture.orm.pack@1` accepts three canonical sRGB RGBA8 image assets with identical dimensions:

- `ambient-occlusion`
- `roughness`
- `metallic`

Each source pixel is reduced through the repository's exact Q8 Rec.709 luma rule. The result is written as canonical linear-sRGB RGBA8 with ambient occlusion in red, roughness in green, metallic in blue, and opaque alpha. The operation records every input SHA-256 and the channel semantics in output metadata.

The operation does not resize, resample, reinterpret, or silently default missing inputs. Preparation of differently sized source maps must be explicit upstream work.

## PBR material bundle

`material.pbr.bundle@1` creates a content-addressed material document that references any non-empty subset of:

- `base-color`: canonical sRGB RGBA8
- `normal`: canonical sRGB RGBA8 tangent-space XYZ data
- `orm`: canonical linear-sRGB RGBA8 produced by the ORM packing convention

When a normal map is present, callers must declare whether its Y axis is `positive` or `negative`. The bundle records texture hashes, byte lengths, dimensions, media types, and semantic conventions; it does not duplicate the texture bytes.

The first bundle version deliberately does not define sampler state, UV transforms, alpha behavior, shader equations, or runtime compression. Those belong to later explicit asset operations or consuming renderer/runtime contracts.

## Reproducibility boundary

Both operations use normal asset-operation build identity and object-store verification. Repeating the same operation against the same exact input assets and parameters yields the same content-addressed output identity. A renderer accepting the bundle must still interpret the recorded conventions explicitly rather than infer them from filenames or ambient defaults.
