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

The `comfyui` profile pins ComfyUI to source commit `98cc0bf84b7cb1383654c5b402e7612d875d6d22` (release v0.41.0), official `comfy-cli` 1.22.0, and `comfy-mcp` 0.10.0 in `scripts/toolchain.json`. The official CLI installs the chosen GPU/CPU dependencies and repository source under ignored `.artifacts/toolchain/`; this project does not implement its own inference runtime, updater or package resolver. An installed environment's resolved dependency snapshot is hashed and checked on subsequent runs. **The upstream Python dependency graph is not yet a cross-machine hash-locked wheel set**; its first-time resolution can vary. Do not claim byte-identical environment reproduction solely from the receipt.

To launch the locally installed server after setup:

```sh
.artifacts/toolchain/comfy-cli-venv/bin/comfy --workspace "$PWD/.artifacts/toolchain/comfy-workspace" launch
```

To expose the official MCP server to a compatible local agent, configure its executable as `.artifacts/toolchain/comfy-cli-venv/bin/comfy-mcp` and set `COMFY_BIN` to the neighboring `comfy` binary. This is agent-local setup; it is not a dependency of asset consumers or a game runtime. The script neither starts services nor modifies a global MCP configuration.

## Idempotency and scope

`doctor` is non-mutating and machine-readable. A second `setup` against an intact managed ComfyUI installation is a no-op; inconsistent source, backend, Python packages or receipt fails closed instead of upgrading, overwriting, wiping data or switching providers. Failed partial installations are left available for inspection; remove only the deliberately disposable managed directory after investigating, not a user-owned installation. All managed files are under the already ignored `.artifacts/` directory.

ComfyUI checkpoints, workflow JSON, custom nodes, model licenses, output selection and real generation are *not* installed or approved by the setup command. Prepare those through their declared acquisition and acceptance paths ([#212](https://github.com/moritzbrantner/asset-tooling/issues/212), [#211](https://github.com/moritzbrantner/asset-tooling/issues/211)). A successful doctor means the tools and runtime match this repository's known setup, **not** that image generation or an agent MCP connection has been accepted. No hidden model downloads, cloud inference, or paid-provider fallback.
