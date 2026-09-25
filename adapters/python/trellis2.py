#!/usr/bin/env python3
"""Offline TRELLIS.2 adapter for asset-tooling process-adapter-v1."""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
import tempfile
import zipfile


PIPELINE_TYPES = {
    "512": "512",
    "1024": "1024",
    "1024-cascade": "1024_cascade",
    "1536-cascade": "1536_cascade",
}
LEGACY_DECODER_REF = "microsoft/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        fail(f"required Python package {name!r} is not installed")
    raise AssertionError("unreachable")


def module_fingerprint(name: str) -> dict[str, str]:
    spec = importlib.util.find_spec(name)
    if spec is None or spec.origin is None:
        fail(f"required Python module {name!r} is not installed")
    origin = Path(spec.origin)
    if not origin.is_file():
        fail(f"required Python module {name!r} has no fingerprintable origin")
    return {
        "id": f"python-module:{name}",
        "pathKind": "module-origin",
        "sha256": sha256_file(origin),
    }


def nvidia_driver_version() -> str:
    try:
        completed = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"could not fingerprint the NVIDIA driver with nvidia-smi: {error}")
    versions = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not versions:
        fail("nvidia-smi did not report an NVIDIA driver version")
    return versions[0]


def accelerator_component(torch) -> dict[str, object]:
    if not torch.cuda.is_available():
        fail("TRELLIS.2 v1 requires CUDA but torch.cuda.is_available() is false")
    index = torch.cuda.current_device()
    properties = torch.cuda.get_device_properties(index)
    major, minor = torch.cuda.get_device_capability(index)
    return {
        "id": "torch-accelerator",
        "requestedDevice": "cuda",
        "cudaVersion": torch.version.cuda,
        "cudnnVersion": torch.backends.cudnn.version(),
        "cudaAvailable": True,
        "cudaDriverVersion": nvidia_driver_version(),
        "selectedCudaDevice": {
            "index": index,
            "name": properties.name,
            "totalMemoryBytes": properties.total_memory,
            "computeCapability": [major, minor],
            "multiProcessorCount": properties.multi_processor_count,
        },
    }


def probe() -> None:
    try:
        import torch
    except ImportError as error:
        fail(f"required Python package 'torch' is not installed: {error}")

    components = [
        {
            "id": "asset-tooling.trellis2-adapter",
            "sha256": sha256_file(Path(__file__).resolve()),
        },
        {
            "id": "python",
            "version": platform.python_version(),
            "executableSha256": sha256_file(Path(sys.executable)),
        },
        {"id": "torch", "version": package_version("torch")},
        {"id": "torchvision", "version": package_version("torchvision")},
        {"id": "transformers", "version": package_version("transformers")},
        {"id": "huggingface-hub", "version": package_version("huggingface-hub")},
        {"id": "safetensors", "version": package_version("safetensors")},
        {"id": "pillow", "version": package_version("Pillow")},
        {"id": "numpy", "version": package_version("numpy")},
        {"id": "trimesh", "version": package_version("trimesh")},
        module_fingerprint("flash_attn"),
        module_fingerprint("flex_gemm"),
        module_fingerprint("cumesh"),
        module_fingerprint("nvdiffrast.torch"),
        module_fingerprint("o_voxel"),
        module_fingerprint("o_voxel._C"),
        module_fingerprint("o_voxel.postprocess"),
        accelerator_component(torch),
    ]
    print(json.dumps(components, sort_keys=True, separators=(",", ":")))


def safe_extract_zip(bundle_path: Path, destination: Path, label: str) -> None:
    with zipfile.ZipFile(bundle_path) as archive:
        members = archive.infolist()
        if not members:
            fail(f"{label} bundle is empty")
        for member in members:
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                fail(f"{label} bundle contains unsafe path {member.filename!r}")
            unix_mode = member.external_attr >> 16
            file_type = stat.S_IFMT(unix_mode)
            if file_type == stat.S_IFLNK:
                fail(f"{label} bundle contains symbolic link {member.filename!r}")
            if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                fail(f"{label} bundle contains unsupported file type {member.filename!r}")
        archive.extractall(destination)


def candidate_root(path: Path, required: tuple[str, ...], label: str) -> Path:
    def complete(candidate: Path) -> bool:
        return all((candidate / item).exists() for item in required)

    if complete(path):
        return path
    children = [child for child in path.iterdir() if child.is_dir()]
    if len(children) == 1 and complete(children[0]):
        return children[0]
    fail(f"{label} bundle must contain {', '.join(required)}")
    raise AssertionError("unreachable")


def require_checkpoint(stem: Path, label: str) -> str:
    config = stem.with_suffix(".json")
    weights = stem.with_suffix(".safetensors")
    if not config.is_file() or not weights.is_file():
        fail(f"{label} must contain {config.name} and {weights.name}")
    return str(stem)


def configure_determinism(torch, enabled: bool) -> None:
    if not enabled:
        return
    torch.use_deterministic_algorithms(True)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.allow_tf32 = False
    if hasattr(torch.backends, "cuda") and hasattr(torch.backends.cuda, "matmul"):
        torch.backends.cuda.matmul.allow_tf32 = False


def load_prepared_image(image_path: Path):
    try:
        import numpy as np
        from PIL import Image
    except ImportError as error:
        fail(f"required prepared-image dependency is missing: {error}")

    image = Image.open(image_path)
    image.load()
    if image.mode != "RGBA":
        fail(
            "TRELLIS.2 preprocessMode='prepared-rgba-premultiplied' requires an RGBA PNG "
            "with background/mask decisions completed before generation"
        )
    if image.width < 16 or image.height < 16:
        fail("TRELLIS.2 prepared image dimensions must both be at least 16 pixels")

    rgba = np.asarray(image, dtype=np.uint16)
    alpha = rgba[:, :, 3:4]
    rgb = ((rgba[:, :, :3] * alpha + 127) // 255).astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB"), [image.width, image.height]


def local_model_paths(model_root: Path, legacy_root: Path, args: dict) -> dict[str, str]:
    models = args.get("models")
    if not isinstance(models, dict) or not models:
        fail("TRELLIS.2 pipeline.json must contain args.models")

    resolved: dict[str, str] = {}
    for key, value in models.items():
        if not isinstance(value, str) or not value:
            fail(f"TRELLIS.2 model reference {key!r} must be a non-empty string")
        if key == "sparse_structure_decoder":
            if value != LEGACY_DECODER_REF:
                fail(
                    "TRELLIS.2 sparse_structure_decoder reference changed; "
                    "update the explicit legacy-decoder contract before accepting it"
                )
            resolved[key] = require_checkpoint(
                legacy_root / "ckpts" / "ss_dec_conv3d_16l8_fp16",
                "TRELLIS legacy sparse-structure decoder",
            )
            continue
        if not value.startswith("ckpts/"):
            fail(
                f"TRELLIS.2 model reference {key!r} is not local to the declared model bundle: {value!r}"
            )
        resolved[key] = require_checkpoint(
            model_root / value,
            f"TRELLIS.2 model {key!r}",
        )
    return resolved


def load_pipeline(model_root: Path, legacy_root: Path, dino_root: Path):
    try:
        import torch
        from trellis2 import models
        from trellis2.modules import image_feature_extractor
        from trellis2.pipelines import samplers
        from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline
    except ImportError as error:
        fail(f"TRELLIS.2 runtime dependency is missing: {error}")

    config_path = model_root / "pipeline.json"
    try:
        pipeline_document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"could not read TRELLIS.2 pipeline.json: {error}")
    if pipeline_document.get("name") != "Trellis2ImageTo3DPipeline":
        fail("TRELLIS.2 pipeline.json must declare Trellis2ImageTo3DPipeline")
    args = pipeline_document.get("args")
    if not isinstance(args, dict):
        fail("TRELLIS.2 pipeline.json args must be an object")

    paths = local_model_paths(model_root, legacy_root, args)
    loaded_models = {}
    for key in Trellis2ImageTo3DPipeline.model_names_to_load:
        if key not in paths:
            fail(f"TRELLIS.2 pipeline.json is missing required model {key!r}")
        loaded_models[key] = models.from_pretrained(paths[key])

    pipeline = Trellis2ImageTo3DPipeline(loaded_models)

    def sampler(name: str):
        value = args.get(name)
        if not isinstance(value, dict):
            fail(f"TRELLIS.2 pipeline.json is missing {name}")
        sampler_name = value.get("name")
        sampler_args = value.get("args")
        sampler_params = value.get("params")
        if (
            not isinstance(sampler_name, str)
            or not isinstance(sampler_args, dict)
            or not isinstance(sampler_params, dict)
        ):
            fail(f"TRELLIS.2 pipeline.json {name} is malformed")
        if not hasattr(samplers, sampler_name):
            fail(f"TRELLIS.2 pipeline.json requests unknown sampler {sampler_name!r}")
        return getattr(samplers, sampler_name)(**sampler_args), sampler_params

    pipeline.sparse_structure_sampler, pipeline.sparse_structure_sampler_params = sampler(
        "sparse_structure_sampler"
    )
    pipeline.shape_slat_sampler, pipeline.shape_slat_sampler_params = sampler(
        "shape_slat_sampler"
    )
    pipeline.tex_slat_sampler, pipeline.tex_slat_sampler_params = sampler("tex_slat_sampler")

    shape_normalization = args.get("shape_slat_normalization")
    texture_normalization = args.get("tex_slat_normalization")
    if not isinstance(shape_normalization, dict) or not isinstance(texture_normalization, dict):
        fail("TRELLIS.2 pipeline.json must declare shape and texture normalization")
    pipeline.shape_slat_normalization = shape_normalization
    pipeline.tex_slat_normalization = texture_normalization

    image_cond = args.get("image_cond_model")
    if (
        not isinstance(image_cond, dict)
        or image_cond.get("name") != "DinoV3FeatureExtractor"
        or not isinstance(image_cond.get("args"), dict)
    ):
        fail("TRELLIS.2 pipeline.json must declare DinoV3FeatureExtractor conditioning")
    if not (dino_root / "config.json").is_file():
        fail("DINOv3 bundle must contain config.json")
    if not any(dino_root.glob("*.safetensors")):
        fail("DINOv3 bundle must contain safetensors weights")
    pipeline.image_cond_model = image_feature_extractor.DinoV3FeatureExtractor(
        model_name=str(dino_root)
    )

    pipeline.rembg_model = None
    pipeline.low_vram = bool(args.get("low_vram", True))
    pipeline.default_pipeline_type = args.get("default_pipeline_type", "1024_cascade")
    pipeline.pbr_attr_layout = {
        "base_color": slice(0, 3),
        "metallic": slice(3, 4),
        "roughness": slice(4, 5),
        "alpha": slice(5, 6),
    }
    pipeline._device = torch.device("cpu")
    return pipeline


def generate(request_path: Path, output_path: Path, observations_path: Path) -> None:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    source_bundle_path = Path(request["sourceBundlePath"])
    model_bundle_path = Path(request["modelBundlePath"])
    legacy_decoder_bundle_path = Path(request["legacyDecoderBundlePath"])
    image_encoder_bundle_path = Path(request["imageEncoderBundlePath"])
    image_path = Path(request["imagePath"])
    seed = request["seed"]
    parameters = request["parameters"]

    for bundle_path, label in (
        (source_bundle_path, "TRELLIS.2 source"),
        (model_bundle_path, "TRELLIS.2 model"),
        (legacy_decoder_bundle_path, "TRELLIS legacy decoder"),
        (image_encoder_bundle_path, "DINOv3 image encoder"),
    ):
        if not bundle_path.is_file():
            fail(f"declared {label} bundle does not exist")
    if not image_path.is_file():
        fail("declared TRELLIS.2 input image does not exist")
    if parameters["device"] != "cuda":
        fail("TRELLIS.2 v1 requires parameters.device='cuda'")
    if parameters["preprocessMode"] != "prepared-rgba-premultiplied":
        fail("TRELLIS.2 v1 requires prepared-rgba-premultiplied preprocessing")
    if parameters["pipelineType"] not in PIPELINE_TYPES:
        fail("TRELLIS.2 pipelineType is unsupported")

    with tempfile.TemporaryDirectory(prefix="asset-tooling-trellis2-") as temporary:
        temporary_path = Path(temporary)
        source_path = temporary_path / "source"
        model_path = temporary_path / "model"
        legacy_path = temporary_path / "legacy"
        dino_path = temporary_path / "dino"
        cache_path = temporary_path / "hf-cache"
        for directory in (source_path, model_path, legacy_path, dino_path, cache_path):
            directory.mkdir()

        os.environ["HF_HOME"] = str(cache_path)
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(cache_path / "hub")
        os.environ["TRANSFORMERS_CACHE"] = str(cache_path / "transformers")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"

        safe_extract_zip(source_bundle_path, source_path, "TRELLIS.2 source")
        safe_extract_zip(model_bundle_path, model_path, "TRELLIS.2 model")
        safe_extract_zip(legacy_decoder_bundle_path, legacy_path, "TRELLIS legacy decoder")
        safe_extract_zip(image_encoder_bundle_path, dino_path, "DINOv3 image encoder")

        source_root = candidate_root(source_path, ("trellis2",), "TRELLIS.2 source")
        model_root = candidate_root(model_path, ("pipeline.json", "ckpts"), "TRELLIS.2 model")
        legacy_root = candidate_root(legacy_path, ("ckpts",), "TRELLIS legacy decoder")
        dino_root = candidate_root(dino_path, ("config.json",), "DINOv3 image encoder")

        if not (source_root / "trellis2" / "__init__.py").is_file():
            fail("TRELLIS.2 source bundle must contain trellis2/__init__.py")
        sys.path.insert(0, str(source_root))

        try:
            import torch
            import o_voxel
        except ImportError as error:
            fail(f"TRELLIS.2 compiled runtime dependency is missing: {error}")

        if not torch.cuda.is_available():
            fail("TRELLIS.2 v1 requires CUDA but CUDA is unavailable")
        configure_determinism(torch, parameters["deterministicAlgorithms"])

        prepared_image, input_size = load_prepared_image(image_path)
        pipeline = load_pipeline(model_root, legacy_root, dino_root)
        pipeline.cuda()

        with torch.no_grad():
            mesh = pipeline.run(
                prepared_image,
                seed=int(seed),
                preprocess_image=False,
                pipeline_type=PIPELINE_TYPES[parameters["pipelineType"]],
                max_num_tokens=parameters["maxNumTokens"],
            )[0]

        if mesh.vertices.shape[0] == 0 or mesh.faces.shape[0] == 0:
            fail("TRELLIS.2 returned an empty mesh")

        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices,
            faces=mesh.faces,
            attr_volume=mesh.attrs,
            coords=mesh.coords,
            attr_layout=mesh.layout,
            voxel_size=mesh.voxel_size,
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=parameters["decimationTarget"],
            texture_size=parameters["textureSize"],
            remesh=parameters["remesh"],
            remesh_band=1,
            remesh_project=0,
            verbose=False,
        )
        glb.export(output_path, extension_webp=parameters["extensionWebp"])

        observations = {
            "adapterProtocol": "asset-tooling-process-adapter-v1",
            "preprocessMode": "prepared-rgba-premultiplied",
            "inputImageMode": "RGBA",
            "inputImageSize": input_size,
            "pipelineType": parameters["pipelineType"],
            "maxNumTokens": parameters["maxNumTokens"],
            "decimationTarget": parameters["decimationTarget"],
            "textureSize": parameters["textureSize"],
            "remesh": parameters["remesh"],
            "extensionWebp": parameters["extensionWebp"],
            "vertexCount": int(mesh.vertices.shape[0]),
            "faceCount": int(mesh.faces.shape[0]),
            "outputFormat": "glb",
            "pbrChannels": ["base-color", "metallic", "roughness", "opacity"],
            "deterministicAlgorithms": parameters["deterministicAlgorithms"],
        }
        observations_path.write_text(
            json.dumps(observations, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: trellis2.py probe | generate REQUEST OUTPUT OBSERVATIONS")
    mode = sys.argv[1]
    if mode == "probe" and len(sys.argv) == 2:
        probe()
        return
    if mode == "generate" and len(sys.argv) == 5:
        generate(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
        return
    fail("usage: trellis2.py probe | generate REQUEST OUTPUT OBSERVATIONS")


if __name__ == "__main__":
    main()
