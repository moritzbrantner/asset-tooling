"""Inspect the current pinned corn outputs through the shared Crop inspector."""
import runpy
from pathlib import Path

root = Path(__file__).resolve().parents[2]
runpy.run_path(root / 'examples/crop_review.py')["main"](root / '.artifacts/corn', 'corn')
