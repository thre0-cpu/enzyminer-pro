#!/usr/bin/env python3
"""Check local tools, benchmark data, backend health and prediction services."""
from __future__ import annotations

import argparse
import os
import shutil
import sys

from common import ApiClient, ApiError
from verify_data import verify


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default=os.environ.get("AOX_BENCH_API_URL", "http://127.0.0.1:8787"))
    parser.add_argument("--api-key", default=os.environ.get("API_KEY", ""))
    parser.add_argument("--require-services", default="cataPro,solubility,tm")
    parser.add_argument("--skip-api", action="store_true")
    args = parser.parse_args()

    failed = False
    print("## Static benchmark data")
    data_result = verify()
    print(f"[{'OK' if data_result['ok'] else 'FAIL'}] data artifacts and membership")
    failed |= not bool(data_result["ok"])

    print("\n## Command-line dependencies")
    commands = [sys.executable, "cd-hit", "mafft", "hmmbuild", "hmmsearch", "mmseqs"]
    for command in commands:
        found = shutil.which(command)
        print(f"[{'OK' if found else 'FAIL'}] {command}: {found or 'not found'}")
        failed |= found is None

    if not args.skip_api:
        print("\n## Backend and prediction services")
        try:
            health = ApiClient(args.api_url, args.api_key, timeout=15).get("/api/health")
            print(f"[OK] backend: {args.api_url} version={health.get('version', 'unknown')}")
            required = [x.strip() for x in args.require_services.split(",") if x.strip()]
            for name in required:
                info = health.get("predictionServices", {}).get(name, {})
                online = bool(info.get("online"))
                print(f"[{'OK' if online else 'FAIL'}] predictor {name}: {'online' if online else 'offline'}")
                failed |= not online
        except ApiError as exc:
            print(f"[FAIL] backend: {exc}")
            failed = True

    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
