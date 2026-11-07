#!/usr/bin/env python3
"""Print the managed Blender executable for this host: the release adapters/blender/release.json pins, as
`mise run setup:blender` (scripts/install-blender.ts) installs it under .artifacts/toolchain/blender.
mise.toml exports it as ASSET_TOOLING_BLENDER; it prints the path whether or not Blender is installed yet."""
import json
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
release = json.loads((ROOT / "adapters/blender/release.json").read_text(encoding="utf8"))
arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower(), platform.machine())
entry = release["releases"].get(f"{sys.platform}-{arch}")
if entry is None:
    sys.exit(f"no pinned Blender release for {sys.platform}-{arch}")
print(ROOT / ".artifacts/toolchain/blender" / entry["executable"])
