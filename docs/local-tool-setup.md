# Local repository tool setup

Use this repository's own setup script, rather than requiring ambient global ComfyUI, Blender or Python packages. This is the bounded initial profile for the ComfyUI-first operation path in [#212](https://github.com/moritzbrantner/asset-tooling/issues/212), not proof that model-backed generation works.

## Commands

Run from the repository root with Python 3.10+ and Git available:

```sh
python3 scripts/setup-tools.py doctor --profile all --json
python3 scripts/setup-tools.py setup --profile core
python3 scripts/setup-tools.py setup --profile previews
python3 scripts/setup-tools.py setup --profile comfyui --gpu nvidia
python3 scripts/setup-tools.py doctor --profile comfyui --json
```

Use `--gpu cpu` instead of `--gpu nvidia` when GPU inference is deliberately unavailable. The default `core` profile uses `bun install --frozen-lockfile` and the exact Bun version from `package.json`. The `previews` profile reuses `scripts/install-blender.ts` and its SHA-256-pinned Blender release; FFmpeg/FFprobe must be installed on the host. No privileged package-manager action is hidden in the script.

The `comfyui` profile pins ComfyUI to source commit `98cc0bf84b7cb1383654c5b402e7612d875d6d22` (release v0.41.0), official `comfy-cli` 1.22.0, and `comfy-mcp` 0.10.0 in `scripts/toolchain.json`. The official CLI installs the repository source under ignored `.artifacts/toolchain/`; for `--gpu nvidia` it also installs PyTorch and ComfyUI's requirements. This project does not implement its own inference runtime, updater or package resolver. An installed environment's resolved dependency snapshot is hashed and checked on subsequent runs. **The upstream Python dependency graph is not yet a cross-machine hash-locked wheel set**; its first-time resolution can vary. Do not claim byte-identical environment reproduction solely from the receipt.

`--gpu cpu` is supported on Linux x86_64 with CPython 3.10–3.15 only; any other platform fails closed before anything is installed, naming the platform. comfy-cli installs the source only (`--cpu --skip-torch-or-directml --skip-requirement`), because its resolver would otherwise pull a CUDA torch build from PyPI ([#220](https://github.com/moritzbrantner/asset-tooling/issues/220)). The wheel set is chosen by probing the runtime interpreter's platform and ABI, not the caller's, and the runtime venv must be a real directory inside `.artifacts/toolchain` (no symlinked path component). Setup then installs the `+cpu` torch and torchvision wheels pinned by URL and SHA-256 in `comfyui.cpuTorch` (`pip --require-hashes --no-deps`), then ComfyUI's `requirements.txt`, runs `pip check`, and probes that torch imports as the pinned build without CUDA. Only torch and torchvision are hash-pinned. The CPU receipt records `torch: {version, cuda: null, wheels: [{name, sha256}]}`, and `doctor` requires it to match the pins.

To launch the locally installed server after setup:

```sh
.artifacts/toolchain/comfy-cli-venv/bin/comfy --workspace "$PWD/.artifacts/toolchain/comfy-workspace" launch
```

To expose the official MCP server to a compatible local agent, configure its executable as `.artifacts/toolchain/comfy-cli-venv/bin/comfy-mcp` and set `COMFY_BIN` to the neighboring `comfy` binary. This is agent-local setup; it is not a dependency of asset consumers or a game runtime. The script neither starts services nor modifies a global MCP configuration.

## Idempotency and scope

`doctor` is non-mutating and machine-readable. A second `setup` against an intact managed ComfyUI installation is a no-op. ~~Inconsistent source, backend, Python packages or receipt fails closed instead of upgrading, overwriting, wiping data or switching providers.~~ Superseded for managed state by [Atlas Decision 5.1.3](decisions/atlas.md): setup converges a managed installation to the pinned state, and `doctor` reports a mismatch until setup is re-run.

The first convergence step is the CPU torch backend. When a managed `--gpu cpu` install is otherwise intact (receipt, source revision and origin, recorded environment hashes) but has no torch record or a CUDA torch record, `setup --profile comfyui --gpu cpu` uninstalls only the installed `nvidia-*`/`triton` distributions that the installed torch declares as requirements, installs the pinned `+cpu` wheels, re-runs `pip check` and the torch probe, and rewrites the receipt. It does not reinstall ComfyUI. All other drift still fails closed: source revision or origin, switching between NVIDIA and CPU, changed environment hashes (also on a CUDA install), and unowned checkouts. The NVIDIA profile is unchanged.

Failed partial installations are left available for inspection; remove only the deliberately disposable managed directory after investigating, not a user-owned installation. All managed files are under the already ignored `.artifacts/` directory.

ComfyUI checkpoints, workflow JSON, custom nodes, model licenses, output selection and real generation are *not* installed or approved by the setup command. Prepare those through their declared acquisition and acceptance paths ([#212](https://github.com/moritzbrantner/asset-tooling/issues/212), [#211](https://github.com/moritzbrantner/asset-tooling/issues/211)). A successful doctor means the tools and runtime match this repository's known setup, **not** that image generation or an agent MCP connection has been accepted. No hidden model downloads, cloud inference, or paid-provider fallback.
