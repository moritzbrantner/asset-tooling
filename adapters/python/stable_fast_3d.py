#!/usr/bin/env python3
"""Offline Stable Fast 3D adapter for asset-tooling process-adapter-v1."""

from __future__ import annotations

from contextlib import nullcontext
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


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


def accelerator_component(torch, requested_device: str) -> dict[str, object]:
    component: dict[str, object] = {
        "id": "torch-accelerator",
        "requestedDevice": requested_device,
        "cudaVersion": torch.version.cuda,
        "cudnnVersion": torch.backends.cudnn.version(),
        "cudaAvailable": torch.cuda.is_available(),
    }
    if requested_device == "cuda":
        if not torch.cuda.is_available():
            fail("parameters.device='cuda' requested but CUDA is unavailable")
        index = torch.cuda.current_device()
        properties = torch.cuda.get_device_properties(index)
        major, minor = torch.cuda.get_device_capability(index)
        component["cudaDriverVersion"] = nvidia_driver_version()
        component["selectedCudaDevice"] = {
            "index": index,
            "name": properties.name,
            "totalMemoryBytes": properties.total_memory,
            "computeCapability": [major, minor],
            "multiProcessorCount": properties.multi_processor_count,
        }
    return component


def probe() -> None:
    try:
        import torch
    except ImportError as error:
        fail(f"required Python package 'torch' is not installed: {error}")

    requested_device = os.environ.get("ASSET_TOOLING_REQUESTED_DEVICE", "cpu")
    components = [
        {
            "id": "asset-tooling.stable-fast-3d-adapter",
            "sha256": sha256_file(Path(__file__).resolve()),
        },
        {
            "id": "python",
            "version": platform.python_version(),
            "executableSha256": sha256_file(Path(sys.executable)),
        },
        {"id": "torch", "version": package_version("torch")},
        {"id": "transformers", "version": package_version("transformers")},
        {"id": "huggingface-hub", "version": package_version("huggingface-hub")},
        {"id": "omegaconf", "version": package_version("omegaconf")},
        {"id": "pillow", "version": package_version("Pillow")},
        {"id": "numpy", "version": package_version("numpy")},
        {"id": "einops", "version": package_version("einops")},
        {"id": "trimesh", "version": package_version("trimesh")},
        {"id": "open-clip-torch", "version": package_version("open-clip-torch")},
        {"id": "jaxtyping", "version": package_version("jaxtyping")},
        {"id": "pynanoinstantmeshes", "version": package_version("pynanoinstantmeshes")},
        {"id": "gpytoolbox", "version": package_version("gpytoolbox")},
        module_fingerprint("texture_baker._C"),
        module_fingerprint("uv_unwrapper._C"),
        accelerator_component(torch, requested_device),
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
        from PIL import Image
    except ImportError as error:
        fail(f"required Python package 'Pillow' is not installed: {error}")

    image = Image.open(image_path)
    image.load()
    if image.mode != "RGBA":
        fail(
            "Stable Fast 3D preprocessMode='prepared-rgba' requires an RGBA input image "
            "with the intended foreground mask"
        )
    if image.size != (512, 512):
        fail("Stable Fast 3D prepared input must be exactly 512x512 pixels")
    return image


def patch_local_dino(model_root: Path, dino_root: Path) -> str:
    try:
        from omegaconf import OmegaConf
    except ImportError as error:
        fail(f"required Python package 'omegaconf' is not installed: {error}")

    config = OmegaConf.load(model_root / "config.yaml")
    if "image_tokenizer" not in config or "pretrained_model_name_or_path" not in config.image_tokenizer:
        fail("Stable Fast 3D config does not declare image_tokenizer.pretrained_model_name_or_path")
    config.image_tokenizer.pretrained_model_name_or_path = str(dino_root)
    patched_name = "asset-tooling-config.yaml"
    OmegaConf.save(config, model_root / patched_name)
    return patched_name


def generate(request_path: Path, output_path: Path, observations_path: Path) -> None:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    source_bundle_path = Path(request["sourceBundlePath"])
    model_bundle_path = Path(request["modelBundlePath"])
    dino_bundle_path = Path(request["dinoBundlePath"])
    image_path = Path(request["imagePath"])
    parameters = request["parameters"]

    for bundle_path, label in (
        (source_bundle_path, "Stable Fast 3D source"),
        (model_bundle_path, "Stable Fast 3D model"),
        (dino_bundle_path, "DINO"),
    ):
        if not bundle_path.is_file():
            fail(f"declared {label} bundle does not exist")
    if not image_path.is_file():
        fail("declared Stable Fast 3D input image does not exist")

    with tempfile.TemporaryDirectory(prefix="asset-tooling-stable-fast-3d-") as temporary:
        temporary_path = Path(temporary)
        source_path = temporary_path / "source"
        model_path = temporary_path / "model"
        dino_path = temporary_path / "dino"
        cache_path = temporary_path / "hf-cache"
        import_path = temporary_path / "python-source"
        for directory in (source_path, model_path, dino_path, cache_path, import_path):
            directory.mkdir()

        os.environ["HF_HOME"] = str(cache_path)
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(cache_path / "hub")
        os.environ["TRANSFORMERS_CACHE"] = str(cache_path / "transformers")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

        safe_extract_zip(source_bundle_path, source_path, "Stable Fast 3D source")
        safe_extract_zip(model_bundle_path, model_path, "Stable Fast 3D model")
        safe_extract_zip(dino_bundle_path, dino_path, "DINO")

        source_root = candidate_root(source_path, ("sf3d",), "Stable Fast 3D source")
        model_root = candidate_root(
            model_path,
            ("config.yaml", "model.safetensors"),
            "Stable Fast 3D model",
        )
        dino_root = candidate_root(dino_path, ("config.json",), "DINO")
        if not (source_root / "sf3d" / "__init__.py").is_file():
            fail("Stable Fast 3D source bundle must contain sf3d/__init__.py")

        shutil.copytree(source_root / "sf3d", import_path / "sf3d")
        patched_config_name = patch_local_dino(model_root, dino_root)

        sys.path.insert(0, str(import_path))
        try:
            import torch
            from sf3d.system import SF3D
        except ImportError as error:
            fail(f"Stable Fast 3D runtime dependency is missing: {error}")

        if parameters["device"] == "cuda" and not torch.cuda.is_available():
            fail("parameters.device='cuda' requested but CUDA is unavailable")
        configure_determinism(torch, parameters["deterministicAlgorithms"])

        image = load_prepared_image(image_path)
        model = SF3D.from_pretrained(
            str(model_root),
            config_name=patched_config_name,
            weight_name="model.safetensors",
        )
        model.eval()
        model.to(parameters["device"])

        autocast = (
            torch.autocast(device_type="cuda", dtype=torch.bfloat16)
            if parameters["device"] == "cuda"
            else nullcontext()
        )
        with torch.no_grad():
            with autocast:
                mesh, _global = model.run_image(
                    image,
                    bake_resolution=parameters["textureResolution"],
                    remesh=parameters["remesh"],
                    vertex_count=parameters["targetVertexCount"],
                )

        if len(mesh.vertices) == 0 or len(mesh.faces) == 0:
            fail("Stable Fast 3D returned an empty mesh")
        mesh.export(output_path, file_type="glb", include_normals=True)

        observations = {
            "adapterProtocol": "asset-tooling-process-adapter-v1",
            "preprocessMode": "prepared-rgba",
            "inputImageMode": image.mode,
            "inputImageSize": [image.width, image.height],
            "modelClass": type(model).__name__,
            "textureResolution": parameters["textureResolution"],
            "remesh": parameters["remesh"],
            "targetVertexCount": parameters["targetVertexCount"],
            "vertexCount": int(len(mesh.vertices)),
            "faceCount": int(len(mesh.faces)),
            "outputFormat": "glb",
            "deterministicAlgorithms": parameters["deterministicAlgorithms"],
        }
        observations_path.write_text(
            json.dumps(observations, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: stable_fast_3d.py probe | generate REQUEST OUTPUT OBSERVATIONS")
    mode = sys.argv[1]
    if mode == "probe" and len(sys.argv) == 2:
        probe()
        return
    if mode == "generate" and len(sys.argv) == 5:
        generate(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
        return
    fail("usage: stable_fast_3d.py probe | generate REQUEST OUTPUT OBSERVATIONS")


if __name__ == "__main__":
    main()
