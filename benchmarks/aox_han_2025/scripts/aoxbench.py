#!/usr/bin/env python3
"""Unified command dispatcher for the Han 2025 AOX benchmark."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
COMMANDS = {
    "doctor": "doctor.py",
    "verify-data": "verify_data.py",
    "run-fixed": "run_fixed_benchmark.py",
    "run-reference": "run_reference_benchmark.py",
    "evaluate": "evaluate.py",
    "trace": "trace_targets.py",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=COMMANDS)
    parser.add_argument("args", nargs=argparse.REMAINDER, help="Arguments passed to the selected command")
    parsed = parser.parse_args()
    command = [sys.executable, str(SCRIPT_DIR / COMMANDS[parsed.command]), *parsed.args]
    raise SystemExit(subprocess.run(command, check=False).returncode)


if __name__ == "__main__":
    main()
