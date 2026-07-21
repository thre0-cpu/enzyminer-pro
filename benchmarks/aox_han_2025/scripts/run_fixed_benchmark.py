#!/usr/bin/env python3
"""Run the controlled recommendation benchmark in the fixed author SSN context."""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from common import (
    ApiClient,
    BENCHMARK_ROOT,
    DATA_ROOT,
    RESULTS_ROOT,
    create_task,
    read_json,
    save_api_payload,
    stage_task_file,
    write_json,
)
from evaluate import evaluate_run
from run_methods import run_methods, run_prediction


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default=os.environ.get("AOX_BENCH_API_URL", "http://127.0.0.1:8787"))
    parser.add_argument("--api-key", default=os.environ.get("API_KEY", ""))
    parser.add_argument("--task-id", help="Use an existing empty task instead of creating one")
    parser.add_argument("--run-name", default="")
    parser.add_argument("--skip-prediction", action="store_true")
    parser.add_argument("--force-prediction", action="store_true")
    parser.add_argument("--require-services", default="cataPro,solubility,tm", help="Comma-separated services required to be online; empty disables")
    args = parser.parse_args()

    client = ApiClient(args.api_url, args.api_key)
    health = client.get("/api/health")
    required = [item.strip() for item in args.require_services.split(",") if item.strip()]
    offline = [name for name in required if not health.get("predictionServices", {}).get(name, {}).get("online", False)]
    if offline and not args.skip_prediction:
        raise SystemExit(f"Required prediction services are offline: {', '.join(offline)}")

    if args.task_id:
        tasks = client.get("/api/tasks").get("tasks", [])
        task = next((item for item in tasks if item.get("id") == args.task_id), None)
        if not task:
            raise SystemExit(f"Task not found: {args.task_id}")
    else:
        task = create_task(client, "aox-fixed")
    task_id = task["id"]
    work_dir = Path(task["workDir"])

    stamp = time.strftime("%Y%m%d-%H%M%S")
    run_name = args.run_name or f"fixed-{stamp}-{task_id}"
    run_dir = RESULTS_ROOT / run_name
    run_dir.mkdir(parents=True, exist_ok=False)
    save_api_payload(run_dir, "health", health)

    reference_text = (DATA_ROOT / "references/han_21_active_aox.fasta").read_text(encoding="utf-8")
    imported = client.post(
        "/api/reference/import-fasta",
        task_id=task_id,
        body={"fastaText": reference_text, "sourceName": "Han_2025_21_active_AOX"},
    )
    save_api_payload(run_dir, "reference_import", imported)

    # Stage the author's fixed graph directly. This isolates recommendation from
    # HMM/database/version effects while still invoking the actual predictor and
    # recommendation endpoints of EnzymeMiner Pro.
    stage_task_file(work_dir, DATA_ROOT / "universe/author_graph_339_candidates.fasta", "candidates_cdhit85.fasta")
    stage_task_file(work_dir, DATA_ROOT / "network/nodes.csv", "nodes.csv")
    stage_task_file(work_dir, DATA_ROOT / "network/edges_similarity.csv", "edges_similarity.csv")
    stage_task_file(work_dir, DATA_ROOT / "metadata/author_graph_358_metadata.tsv", "benchmark_metadata.tsv")

    benchmark = read_json(BENCHMARK_ROOT / "configs/benchmark.json")
    methods = read_json(BENCHMARK_ROOT / "configs/methods.json")
    prediction = run_prediction(
        client,
        task_id,
        run_dir,
        benchmark,
        force=args.force_prediction,
        skip=args.skip_prediction,
    )
    run_methods(client, task_id, run_dir, benchmark, methods)
    evaluate_run(run_dir)
    write_json(
        run_dir / "run_manifest.json",
        {
            "benchmark_id": benchmark["benchmark_id"],
            "mode": "fixed_author_graph",
            "task_id": task_id,
            "task_work_dir": str(work_dir),
            "api_url": args.api_url,
            "server_version": health.get("version"),
            "prediction_services": health.get("predictionServices", {}),
            "prediction_executed": prediction is not None,
            "evaluation_executed": True,
            "candidate_context": "author_graph_358_nodes_with_19_reference_nodes_and_339_recommendable_candidates",
            "warning": "The author repository artifact has 358 graph nodes; do not relabel it as an exact 357-sequence reconstruction.",
        },
    )
    print(f"Fixed benchmark complete: {run_dir}")
    print(f"Report: {run_dir / 'report.md'}")


if __name__ == "__main__":
    main()
