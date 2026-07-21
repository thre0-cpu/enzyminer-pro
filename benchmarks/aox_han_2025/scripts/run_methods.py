#!/usr/bin/env python3
"""Run EnzymeMiner Pro recommendation methods for an already prepared task."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from common import ApiClient, BENCHMARK_ROOT, read_json, save_api_payload, write_csv, write_json


def run_prediction(
    client: ApiClient,
    task_id: str,
    run_dir: Path,
    benchmark_config: dict[str, Any],
    *,
    force: bool,
    skip: bool,
) -> dict[str, Any] | None:
    if skip:
        return None
    payload = client.post(
        "/api/network/predict-metrics",
        task_id=task_id,
        body={
            "forceRecompute": force,
            "subWeights": benchmark_config["predicted_sub_weights"],
            "tmTarget": benchmark_config["predicted_tm_target"],
            "smiles": benchmark_config["substrate_smiles"],
        },
    )
    save_api_payload(run_dir, "prediction", payload)
    rows = payload.get("rows", [])
    if rows:
        fields = list(rows[0].keys())
        write_csv(run_dir / "predictions.csv", rows, fields)
    return payload


def run_methods(
    client: ApiClient,
    task_id: str,
    run_dir: Path,
    benchmark_config: dict[str, Any],
    methods_config: dict[str, Any],
) -> None:
    top_k = [int(k) for k in benchmark_config["top_k"]]
    common = {
        "temperature": 0,
        "networkConnectivityThreshold": benchmark_config["network_connectivity_threshold"],
        "predictedSubWeights": benchmark_config["predicted_sub_weights"],
        "predictedTmTarget": benchmark_config["predicted_tm_target"],
        "filterConditions": [],
        "filterLogic": "and",
    }
    manifest: dict[str, Any] = {"task_id": task_id, "methods": {}}
    for method in methods_config["methods"]:
        method_id = method["id"]
        base_body = {
            **common,
            "weights": method["weights"],
            "minClusterSize": method.get("min_cluster_size", 1),
            "minSimilarity": method.get("min_similarity", 0),
            "diversityMode": method.get("diversity_mode", "proportional"),
        }
        full = client.post(
            "/api/network/recommend-candidates",
            task_id=task_id,
            body={**base_body, "topN": 5000},
        )
        save_api_payload(run_dir, f"recommend_{method_id}_full", full)
        candidates = full.get("candidates", [])
        rank_rows = []
        for rank, candidate in enumerate(candidates, 1):
            rank_rows.append({"rank": rank, **candidate})
        fields = [
            "rank", "id", "score", "avgRefSimilarity", "maxRefSimilarity", "clusterSizeNorm",
            "taxonomyDiversity", "predictedScore", "propertyCoverage", "networkComponent",
            "networkComponentSize", "refEdgeCount", "phylum", "class", "order", "family", "genus", "species",
        ]
        write_csv(run_dir / "rankings" / f"{method_id}.csv", rank_rows, fields)

        selections: dict[str, Any] = {}
        for k in top_k:
            selected = client.post(
                "/api/network/recommend-candidates",
                task_id=task_id,
                body={**base_body, "topN": k},
            )
            save_api_payload(run_dir, f"recommend_{method_id}_top{k}", selected)
            selection_rows = [{"selection_rank": index, **row} for index, row in enumerate(selected.get("candidates", []), 1)]
            write_csv(run_dir / "selections" / f"{method_id}_top{k}.csv", selection_rows, ["selection_rank", *fields[1:]])
            selections[str(k)] = [row.get("id") for row in selected.get("candidates", [])]

        manifest["methods"][method_id] = {
            "description": method.get("description", ""),
            "weights": method["weights"],
            "min_cluster_size": method.get("min_cluster_size", 1),
            "diversity_mode": method.get("diversity_mode", "proportional"),
            "ranked_count": len(candidates),
            "total_candidates": full.get("totalCandidates"),
            "filtered_by_cluster_size": full.get("filteredByClusterSize"),
            "predicted_metrics_available": full.get("predictedMetricsAvailable"),
            "selections": selections,
        }
        print(f"[{method_id}] ranked={len(candidates)}")
    write_json(run_dir / "methods_manifest.json", manifest)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default="http://127.0.0.1:8787")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--skip-prediction", action="store_true")
    parser.add_argument("--force-prediction", action="store_true")
    args = parser.parse_args()
    client = ApiClient(args.api_url, args.api_key)
    benchmark = read_json(BENCHMARK_ROOT / "configs/benchmark.json")
    methods = read_json(BENCHMARK_ROOT / "configs/methods.json")
    args.run_dir.mkdir(parents=True, exist_ok=True)
    run_prediction(client, args.task_id, args.run_dir, benchmark, force=args.force_prediction, skip=args.skip_prediction)
    run_methods(client, args.task_id, args.run_dir, benchmark, methods)


if __name__ == "__main__":
    main()
