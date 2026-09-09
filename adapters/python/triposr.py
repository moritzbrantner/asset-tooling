#!/usr/bin/env python3
"""Offline TripoSR adapter for asset-tooling process-adapter-v1."""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
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


def module_fingerprint(name: str) -> dict[str, str | None]:
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


def probe() -> None:
    try:
        import torch
    except ImportError as error:
        fail(f"required Python package 'torch' is not installed: {error}")

    components = [
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
        module_fingerprint("torchmcubes"),
        {
            "id": "torch-accelerator",
            "cudaVersion": torch.version.cuda,
            "cudnnVersion": torch.backends.cudnn.version(),
            "cudaAvailable": torch.cuda.is_available(),
        },
    ]
    print(json.dumps(components, sort_keys=True, separators=(",", ":")))


def safe_extract_zip(bundle_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(bundle_path) as archive:
        members = archive.infolist()
        if not members:
            fail("TripoSR bundle is empty")
        for member in members:
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                fail(f"TripoSR bundle contains unsafe path {member.filename!r}")
            unix_mode = member.external_attr >> 16
            if stat.S_ISLNK(unix_mode):
                fail(f"TripoSR bundle contains symbolic link {member.filename!r}")
            if unix_mode and not (stat.S_ISREG(unix_mode) or stat.S_ISDIR(unix_mode)):
                fail(f"TripoSR bundle contains unsupported file type {member.filename!r}")
        archive.extractall(destination)


def candidate_bundle_root(path: Path) -> Path:
    def complete(candidate: Path) -> bool:
        return (
            (candidate / "tsr").is_dir()
            and (candidate / "config.yaml").is_file()
            and (candidate / "model.ckpt").is_file()
            and (candidate / "dino").is_dir()
            and (candidate / "dino" / "config.json").is_file()
        )

    if complete(path):
        return path
    children = [child for child in path.iterdir() if child.is_dir()]
    if len(children) == 1 and complete(children[0]):
        return children[0]
    fail(
        "TripoSR bundle must contain tsr/, config.yaml, model.ckpt, and a local dino/ model directory"
    )
    raise AssertionError("unreachable")


def patch_local_dino(bundle_root: Path) -> str:
    try:
        from omegaconf import OmegaConf
    except ImportError as error:
        fail(f"required Python package 'omegaconf' is not installed: {error}")

    config = OmegaConf.load(bundle_root / "config.yaml")
    if "image_tokenizer" not in config or "pretrained_model_name_or_path" not in config.image_tokenizer:
        fail("TripoSR config does not declare image_tokenizer.pretrained_model_name_or_path")
    config.image_tokenizer.pretrained_model_name_or_path = str(bundle_root / "dino")
    patched_name = "asset-tooling-config.yaml"
    OmegaConf.save(config, bundle_root / patched_name)
    return patched_name


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
    if image.mode != "RGB":
        fail("TripoSR preprocessMode='prepared' requires an RGB input image; preprocess it explicitly before generation")
    return image


def generate(request_path: Path, output_path: Path, observations_path: Path) -> None:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    bundle_path = Path(request["triposrBundlePath"])
    image_path = Path(request["imagePath"])
    parameters = request["parameters"]

    if not bundle_path.is_file():
        fail("declared TripoSR bundle does not exist")
    if not image_path.is_file():
        fail("declared TripoSR input image does not exist")

    with tempfile.TemporaryDirectory(prefix="asset-tooling-triposr-") as temporary:
        temporary_path = Path(temporary)
        extracted_path = temporary_path / "bundle"
        cache_path = temporary_path / "hf-cache"
        extracted_path.mkdir()
        cache_path.mkdir()

        os.environ["HF_HOME"] = str(cache_path)
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(cache_path / "hub")
        os.environ["TRANSFORMERS_CACHE"] = str(cache_path / "transformers")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

        safe_extract_zip(bundle_path, extracted_path)
        bundle_root = candidate_bundle_root(extracted_path)
        patched_config_name = patch_local_dino(bundle_root)

        sys.path.insert(0, str(bundle_root))
        try:
            import torch
            from tsr.system import TSR
        except ImportError as error:
            fail(f"TripoSR runtime dependency is missing: {error}")

        if parameters["device"] == "cuda" and not torch.cuda.is_available():
            fail("parameters.device='cuda' requested but CUDA is unavailable")
        configure_determinism(torch, parameters["deterministicAlgorithms"])

        image = load_prepared_image(image_path)
        model = TSR.from_pretrained(
            str(bundle_root),
            config_name=patched_config_name,
            weight_name="model.ckpt",
        )
        model.renderer.set_chunk_size(parameters["chunkSize"])
        model.to(parameters["device"])

        with torch.no_grad():
            scene_codes = model([image], device=parameters["device"])
        meshes = model.extract_mesh(
            scene_codes,
            True,
            resolution=parameters["mcResolution"],
        )
        if len(meshes) != 1:
            fail(f"TripoSR returned {len(meshes)} meshes for one input image")
        mesh = meshes[0]
        mesh.export(output_path, file_type=parameters["outputFormat"])

        observations = {
            "adapterProtocol": "asset-tooling-process-adapter-v1",
            "preprocessMode": "prepared",
            "inputImageMode": image.mode,
            "modelClass": type(model).__name__,
            "chunkSize": parameters["chunkSize"],
            "mcResolution": parameters["mcResolution"],
            "vertexColorOutput": True,
            "vertexCount": int(len(mesh.vertices)),
            "faceCount": int(len(mesh.faces)),
            "outputFormat": parameters["outputFormat"],
            "deterministicAlgorithms": parameters["deterministicAlgorithms"],
        }
        observations_path.write_text(
            json.dumps(observations, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: triposr.py probe | generate REQUEST OUTPUT OBSERVATIONS")
    mode = sys.argv[1]
    if mode == "probe" and len(sys.argv) == 2:
        probe()
        return
    if mode == "generate" and len(sys.argv) == 5:
        generate(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
        return
    fail("usage: triposr.py probe | generate REQUEST OUTPUT OBSERVATIONS")


if __name__ == "__main__":
    main()
