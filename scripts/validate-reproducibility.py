#!/usr/bin/env python3
"""Validate processing-receipt reproducibility invariants JSON Schema cannot express.

Run this only after validating the receipt against its declared schema version.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _reject_json_constant(token: str) -> None:
    raise ValueError(f"non-standard JSON numeric constant {token!r} is not allowed")


def validate_reproducibility(receipt: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    reproducibility = receipt.get("reproducibility")
    output = receipt.get("output")
    if not isinstance(reproducibility, dict) or not isinstance(output, dict):
        return ["receipt must be schema-valid before reproducibility validation"]

    state = reproducibility.get("state")
    output_hash = output.get("sha256")
    if state == "exact":
        repeat_hash = reproducibility.get("repeatOutputSha256")
        if repeat_hash != output_hash:
            errors.append(
                "exact reproducibility requires repeatOutputSha256 to equal output.sha256"
            )
    elif state in {"structural", "unverified"}:
        evidence = reproducibility.get("evidence")
        if not isinstance(evidence, dict) or not evidence.get("reason"):
            errors.append(
                f"{state} reproducibility requires evidence.reason explaining the limitation"
            )
    else:
        errors.append("receipt must be schema-valid before reproducibility validation")

    return errors


def validate_file(path: Path) -> list[str]:
    try:
        receipt = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=_reject_json_constant,
        )
    except (OSError, ValueError) as error:
        return [f"could not read strict JSON: {error}"]

    if not isinstance(receipt, dict):
        return ["receipt root must be a JSON object"]
    return validate_reproducibility(receipt)


def main(arguments: list[str]) -> int:
    if len(arguments) < 2:
        print(f"usage: {arguments[0]} RECEIPT.json [RECEIPT.json ...]", file=sys.stderr)
        return 2

    failed = False
    for raw_path in arguments[1:]:
        path = Path(raw_path)
        errors = validate_file(path)
        if errors:
            failed = True
            for error in errors:
                print(f"{path}: {error}", file=sys.stderr)
        else:
            print(f"{path}: reproducibility evidence valid")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
