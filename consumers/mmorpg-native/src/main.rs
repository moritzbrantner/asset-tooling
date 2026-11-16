//! Loads each glTF or GLB file named on the command line the way moenarch-games/mmorpg's native
//! client does (asset-tooling #691): meshopt views decoded and quantized attributes dequantized
//! (`packed`), every KTX2 image transcoded by the pure-Rust `basisu` transcoder, and the document
//! read by the `gltf` crate's importer and accessor readers. Prints one JSON line per file and
//! exits 1 when any file could not be loaded.

mod packed;

use serde_json::{Value, json};
use std::{fs, path::Path, process::ExitCode};

fn main() -> ExitCode {
    let mut failed = false;
    for file in std::env::args().skip(1) {
        let line = match check(Path::new(&file)) {
            Ok(summary) => json!({ "file": file, "ok": true, "summary": summary }),
            Err(error) => {
                failed = true;
                json!({ "file": file, "ok": false, "error": error })
            }
        };
        println!("{line}");
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn check(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| format!("read: {error}"))?;
    let (mut json, mut buffers) = if bytes.starts_with(b"glTF") {
        glb_parts(&bytes)?
    } else {
        gltf_parts(path, &bytes)?
    };
    let textures = transcode_images(path, &json, &buffers)?;
    packed::decode_views(&mut json, &mut buffers)?;
    packed::dequantize(&mut json, &mut buffers)?;
    for list in ["extensionsUsed", "extensionsRequired"] {
        if let Some(names) = json.get_mut(list).and_then(Value::as_array_mut) {
            names.retain(|name| {
                !packed::EXTENSIONS.iter().any(|resolved| name == resolved)
                    && name != "KHR_texture_basisu"
            });
        }
    }
    basisu_as_core(&mut json);
    let glb = glb(json, &buffers)?;
    let gltf = gltf::Gltf::from_slice(&glb).map_err(|error| format!("gltf: {error}"))?;
    let data = gltf::import_buffers(&gltf.document, None, gltf.blob)
        .map_err(|error| format!("gltf buffers: {error}"))?;
    let buffer = |buffer: gltf::Buffer| data.get(buffer.index()).map(|data| &data[..]);
    let (mut primitives, mut vertices, mut channels) = (0, 0, 0);
    for mesh in gltf.document.meshes() {
        for primitive in mesh.primitives() {
            let reader = primitive.reader(buffer);
            let positions: Vec<[f32; 3]> = reader
                .read_positions()
                .ok_or("a primitive has no positions")?
                .collect();
            if positions.iter().flatten().any(|value| !value.is_finite()) {
                return Err("a primitive has a non-finite position".into());
            }
            let count = positions.len();
            let same = |name: &str, length: Option<usize>| match length {
                Some(length) if length != count => {
                    Err(format!("{name} has {length} values for {count} vertices"))
                }
                _ => Ok(()),
            };
            same("NORMAL", reader.read_normals().map(Iterator::count))?;
            same(
                "TEXCOORD_0",
                reader
                    .read_tex_coords(0)
                    .map(|coords| coords.into_f32().count()),
            )?;
            same(
                "JOINTS_0",
                reader
                    .read_joints(0)
                    .map(|joints| joints.into_u16().count()),
            )?;
            same(
                "WEIGHTS_0",
                reader
                    .read_weights(0)
                    .map(|weights| weights.into_f32().count()),
            )?;
            if let Some(indices) = reader.read_indices()
                && indices.into_u32().any(|index| index as usize >= count)
            {
                return Err("an index lies outside its primitive".into());
            }
            for (positions, normals, _) in reader.read_morph_targets() {
                same("a morph target", positions.map(Iterator::count))?;
                same("a morph target's normals", normals.map(Iterator::count))?;
            }
            primitives += 1;
            vertices += count;
        }
    }
    for animation in gltf.document.animations() {
        for channel in animation.channels() {
            let reader = channel.reader(buffer);
            let inputs = reader
                .read_inputs()
                .ok_or("a channel has no inputs")?
                .count();
            let outputs = reader.read_outputs().ok_or("a channel has no outputs")?;
            use gltf::animation::util::ReadOutputs as O;
            let values = match outputs {
                O::Translations(values) | O::Scales(values) => values.count(),
                O::Rotations(values) => values.into_f32().count(),
                O::MorphTargetWeights(values) => values.into_f32().count(),
            };
            if inputs == 0 || values == 0 {
                return Err("an animation channel is empty".into());
            }
            channels += 1;
        }
    }
    Ok(
        json!({ "primitives": primitives, "vertices": vertices, "channels": channels, "textures": textures }),
    )
}

/// A GLB's JSON and buffers: the binary chunk is buffer 0, a meshopt fallback buffer is empty.
fn glb_parts(bytes: &[u8]) -> Result<(Value, Vec<Vec<u8>>), String> {
    let chunk = |at: usize| -> Result<&[u8], String> {
        let length = bytes
            .get(at..at + 4)
            .ok_or("a truncated GLB")?
            .try_into()
            .map(u32::from_le_bytes)
            .map_err(|_| "a truncated GLB")?;
        bytes
            .get(at + 8..at + 8 + length as usize)
            .ok_or_else(|| "a truncated GLB chunk".into())
    };
    let text = chunk(12)?;
    let json: Value = serde_json::from_slice(text).map_err(|error| format!("GLB JSON: {error}"))?;
    let bin = if 20 + text.len() < bytes.len() {
        Some(chunk(20 + text.len())?)
    } else {
        None
    };
    let buffers = list(&json["buffers"])
        .iter()
        .enumerate()
        .map(|(index, buffer)| match bin {
            Some(bin) if index == 0 && buffer.get("uri").is_none() => bin.to_vec(),
            _ => Vec::new(),
        })
        .collect();
    Ok((json, buffers))
}

/// A glTF's JSON and buffers, external ones read beside it; a meshopt fallback buffer is empty.
fn gltf_parts(path: &Path, bytes: &[u8]) -> Result<(Value, Vec<Vec<u8>>), String> {
    let json: Value = serde_json::from_slice(bytes).map_err(|error| format!("JSON: {error}"))?;
    let buffers = list(&json["buffers"])
        .iter()
        .map(|buffer| match buffer["uri"].as_str() {
            Some(uri) => external(path, uri),
            None => Ok(Vec::new()),
        })
        .collect::<Result<_, _>>()?;
    Ok((json, buffers))
}

fn external(path: &Path, uri: &str) -> Result<Vec<u8>, String> {
    if uri.starts_with("data:") || uri.contains("://") {
        return Err(format!("{uri} is not a relative file"));
    }
    let file = path.parent().unwrap_or(Path::new(".")).join(uri);
    fs::read(&file).map_err(|error| format!("{}: {error}", file.display()))
}

/// Transcodes every KTX2 image (each mip level, as the game's ground does) and returns how many.
fn transcode_images(path: &Path, json: &Value, buffers: &[Vec<u8>]) -> Result<usize, String> {
    let mut count = 0;
    for image in list(&json["images"]) {
        let bytes = match (image["uri"].as_str(), image["bufferView"].as_u64()) {
            (Some(uri), _) => external(path, uri)?,
            (None, Some(view)) => {
                let view = &json["bufferViews"][view as usize];
                let start = view["byteOffset"].as_u64().unwrap_or(0) as usize;
                let length = view["byteLength"].as_u64().unwrap_or(0) as usize;
                view["buffer"]
                    .as_u64()
                    .and_then(|buffer| buffers.get(buffer as usize))
                    .and_then(|buffer| buffer.get(start..start + length))
                    .ok_or("an image view lies outside its buffer")?
                    .to_vec()
            }
            _ => return Err("an image has neither a URI nor a view".into()),
        };
        if !bytes.starts_with(b"\xABKTX 20\xBB\r\n\x1A\n") {
            continue;
        }
        let transcoder =
            basisu::Transcoder::new(&bytes).map_err(|error| format!("KTX2 image: {error:?}"))?;
        for level in 0..transcoder.level_count() {
            transcoder
                .transcode(
                    level,
                    basisu::TargetFormat::Rgba32,
                    basisu::DecodeFlags::NONE,
                )
                .map_err(|error| format!("KTX2 level {level}: {error:?}"))?;
        }
        count += 1;
    }
    Ok(count)
}

/// `KHR_texture_basisu`'s source as the texture's core source (mmorpg `ground::basisu_as_core`).
fn basisu_as_core(json: &mut Value) {
    for texture in json
        .get_mut("textures")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let basisu = texture
            .get_mut("extensions")
            .and_then(Value::as_object_mut)
            .and_then(|extensions| extensions.remove("KHR_texture_basisu"));
        if let Some(source) = basisu.map(|basisu| basisu["source"].clone()) {
            texture["source"] = source;
        }
    }
}

/// One GLB of `json` and its `buffers` in a single binary chunk; external images keep their URI
/// (the importer reads no images here: [`transcode_images`] decoded them).
fn glb(mut json: Value, buffers: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    let mut bin = Vec::new();
    let mut offsets = Vec::new();
    for buffer in buffers {
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        offsets.push(bin.len());
        bin.extend_from_slice(buffer);
    }
    for view in json
        .get_mut("bufferViews")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let buffer = view["buffer"].as_u64().ok_or("a view names no buffer")? as usize;
        let offset = offsets.get(buffer).ok_or("a view names a missing buffer")?;
        view["byteOffset"] = (view["byteOffset"].as_u64().unwrap_or(0) as usize + offset).into();
        view["buffer"] = 0.into();
    }
    zero_accessors(&mut json, &mut |bytes: &[u8]| {
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        let offset = bin.len();
        bin.extend_from_slice(bytes);
        offset
    });
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    json["buffers"] = json!([{ "byteLength": bin.len() }]);
    let mut text = serde_json::to_vec(&json).map_err(|error| error.to_string())?;
    while text.len() % 4 != 0 {
        text.push(b' ');
    }
    let word = |value: usize| {
        u32::try_from(value)
            .map(u32::to_le_bytes)
            .map_err(|_| "too large for a GLB")
    };
    let mut out = Vec::with_capacity(28 + text.len() + bin.len());
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2_u32.to_le_bytes());
    out.extend_from_slice(&word(28 + text.len() + bin.len())?);
    out.extend_from_slice(&word(text.len())?);
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&text);
    out.extend_from_slice(&word(bin.len())?);
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    Ok(out)
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// Gives every accessor without a buffer view or sparse storage (all zeros) a view of one shared
/// block of zeros: glTF allows them, the `gltf` crate does not (mmorpg `skinned::zero_accessors`).
fn zero_accessors(json: &mut serde_json::Value, append: &mut impl FnMut(&[u8]) -> usize) {
    let size = |accessor: &serde_json::Value| {
        let component = match accessor["componentType"].as_u64() {
            Some(5120 | 5121) => 1,
            Some(5122 | 5123) => 2,
            _ => 4,
        };
        let components = match accessor["type"].as_str() {
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4" | "MAT2") => 4,
            Some("MAT3") => 9,
            Some("MAT4") => 16,
            _ => 1,
        };
        accessor["count"].as_u64().unwrap_or(0) as usize * component * components
    };
    let empty = |accessor: &serde_json::Value| {
        accessor.get("bufferView").is_none() && accessor.get("sparse").is_none()
    };
    let longest = json["accessors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|accessor| empty(accessor))
        .map(size)
        .max();
    let Some(longest) = longest.filter(|&longest| longest > 0) else {
        return;
    };
    let offset = append(&vec![0; longest]);
    let views = json["bufferViews"].as_array().map_or(0, Vec::len);
    if let Some(list) = json
        .get_mut("bufferViews")
        .and_then(serde_json::Value::as_array_mut)
    {
        list.push(serde_json::json!({"buffer": 0, "byteOffset": offset, "byteLength": longest}));
    }
    for accessor in json
        .get_mut("accessors")
        .and_then(serde_json::Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if empty(accessor) {
            accessor["bufferView"] = views.into();
        }
    }
}
