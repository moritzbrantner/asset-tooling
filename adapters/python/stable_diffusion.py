#!/usr/bin/env python3
"""Offline Stable Diffusion adapter for asset-tooling process-adapter-v1."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
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
        "mpsAvailable": bool(
            hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        ),
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
            "id": "asset-tooling.stable-diffusion-adapter",
            "sha256": sha256_file(Path(__file__).resolve()),
        },
        {
            "id": "python",
            "version": platform.python_version(),
            "executableSha256": sha256_file(Path(sys.executable)),
        },
        {"id": "torch", "version": package_version("torch")},
        {"id": "diffusers", "version": package_version("diffusers")},
        {"id": "transformers", "version": package_version("transformers")},
        {"id": "huggingface-hub", "version": package_version("huggingface-hub")},
        {"id": "safetensors", "version": package_version("safetensors")},
        {"id": "pillow", "version": package_version("Pillow")},
        accelerator_component(torch, requested_device),
    ]
    print(json.dumps(components, sort_keys=True, separators=(",", ":")))


def safe_extract_zip(bundle_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(bundle_path) as archive:
        members = archive.infolist()
        if not members:
            fail("Stable Diffusion pipeline bundle is empty")
        for member in members:
            member_path = Path(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                fail(f"pipeline bundle contains unsafe path {member.filename!r}")
            unix_mode = member.external_attr >> 16
            if stat.S_ISLNK(unix_mode):
                fail(f"pipeline bundle contains symbolic link {member.filename!r}")
        archive.extractall(destination)


def pipeline_root(extracted: Path) -> Path:
    if (extracted / "model_index.json").is_file():
        return extracted
    children = [child for child in extracted.iterdir() if child.is_dir()]
    if len(children) == 1 and (children[0] / "model_index.json").is_file():
        return children[0]
    fail("pipeline bundle must contain model_index.json at its root or inside one top-level directory")
    raise AssertionError("unreachable")


def torch_dtype(torch, name: str):
    mapping = {
        "float32": torch.float32,
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
    }
    return mapping[name]


def configure_scheduler(pipe, name: str) -> None:
    if name == "default":
        return
    from diffusers import DDIMScheduler, EulerAncestralDiscreteScheduler, EulerDiscreteScheduler

    scheduler_types = {
        "ddim": DDIMScheduler,
        "euler": EulerDiscreteScheduler,
        "euler-a": EulerAncestralDiscreteScheduler,
    }
    pipe.scheduler = scheduler_types[name].from_config(pipe.scheduler.config)


def generate(request_path: Path, output_path: Path, observations_path: Path) -> None:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    bundle_path = Path(request["pipelineBundlePath"])
    parameters = request["parameters"]
    seed = int(request["seed"])

    if not bundle_path.is_file():
        fail("declared Stable Diffusion pipeline bundle does not exist")

    with tempfile.TemporaryDirectory(prefix="asset-tooling-sd-") as temporary:
        temporary_path = Path(temporary)
        cache_path = temporary_path / "hf-cache"
        extracted_path = temporary_path / "pipeline"
        extracted_path.mkdir()
        cache_path.mkdir()

        os.environ["HF_HOME"] = str(cache_path)
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(cache_path / "hub")
        os.environ["TRANSFORMERS_CACHE"] = str(cache_path / "transformers")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

        safe_extract_zip(bundle_path, extracted_path)
        local_pipeline = pipeline_root(extracted_path)

        try:
            import torch
            from diffusers import DiffusionPipeline
        except ImportError as error:
            fail(f"Stable Diffusion runtime dependency is missing: {error}")

        if parameters["device"] == "cuda" and not torch.cuda.is_available():
            fail("parameters.device='cuda' requested but CUDA is unavailable")
        if parameters["device"] == "mps" and not (
            hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        ):
            fail("parameters.device='mps' requested but MPS is unavailable")

        if parameters["deterministicAlgorithms"]:
            torch.use_deterministic_algorithms(True)
            if hasattr(torch.backends, "cudnn"):
                torch.backends.cudnn.benchmark = False
            if hasattr(torch.backends, "cuda") and hasattr(torch.backends.cuda, "matmul"):
                torch.backends.cuda.matmul.allow_tf32 = False
            if hasattr(torch.backends, "cudnn"):
                torch.backends.cudnn.allow_tf32 = False

        dtype = torch_dtype(torch, parameters["dtype"])
        pipe = DiffusionPipeline.from_pretrained(
            local_pipeline,
            local_files_only=True,
            dtype=dtype,
        )
        configure_scheduler(pipe, parameters["scheduler"])
        pipe = pipe.to(parameters["device"])

        generator = torch.Generator(device="cpu").manual_seed(seed)
        result = pipe(
            prompt=parameters["prompt"],
            negative_prompt=parameters["negativePrompt"],
            width=parameters["width"],
            height=parameters["height"],
            num_inference_steps=parameters["steps"],
            guidance_scale=parameters["guidanceScale"],
            generator=generator,
            num_images_per_prompt=1,
            output_type="pil",
        )
        image = result.images[0]
        image.save(output_path, format="PNG", optimize=False, compress_level=9)

        observations = {
            "adapterProtocol": "asset-tooling-process-adapter-v1",
            "pipelineClass": type(pipe).__name__,
            "schedulerClass": type(pipe.scheduler).__name__,
            "generatorDevice": "cpu",
            "imageMode": image.mode,
            "imageWidth": image.width,
            "imageHeight": image.height,
            "outputFormat": "png",
            "deterministicAlgorithms": parameters["deterministicAlgorithms"],
        }
        observations_path.write_text(
            json.dumps(observations, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: stable_diffusion.py probe | generate REQUEST OUTPUT OBSERVATIONS")
    mode = sys.argv[1]
    if mode == "probe" and len(sys.argv) == 2:
        probe()
        return
    if mode == "generate" and len(sys.argv) == 5:
        generate(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
        return
    fail("usage: stable_diffusion.py probe | generate REQUEST OUTPUT OBSERVATIONS")


if __name__ == "__main__":
    main()
