#!/usr/bin/env python3
"""Run the Han AOX reference-to-recommendation end-to-end benchmark."""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from common import (
    ApiClient,
    BENCHMARK_ROOT,
    DATA_ROOT,
    RESULTS_ROOT,
    create_task,
    accession_aliases,
    normalize_accession,
    parse_fasta,
    read_json,
    save_api_payload,
    sha256_file,
    stage_task_file,
    write_fasta,
    write_json,
)
from evaluate import evaluate_run
from run_methods import run_methods, run_prediction
from trace_targets import write_trace



def stage_target_database(work_dir: Path, source: Path, preserve_ids: bool) -> tuple[Path, dict[str, Any]]:
    """Stage the database, optionally canonicalizing pipe-formatted IDs.

    The current network backend tokenizes pipe-delimited IDs and may collapse all
    ``tr|...`` records through their shared ``tr`` token. Canonicalization is a
    declared benchmark workaround, not evidence that raw UniProt IDs are safe.
    """
    destination = work_dir / "target.fasta"
    if preserve_ids:
        stage_task_file(work_dir, source, destination.name)
        return destination, {"canonicalized": False, "records": len(parse_fasta(source)), "id_collisions": []}
    records = parse_fasta(source)
    seen: set[str] = set()
    collisions: list[str] = []
    canonical_records: list[dict[str, str]] = []
    for record in records:
        canonical = normalize_accession(record["id"])
        if not canonical or canonical in seen:
            collisions.append(canonical or record["id"])
            continue
        seen.add(canonical)
        canonical_records.append({"id": canonical, "header": canonical, "sequence": record["sequence"]})
    if collisions:
        raise RuntimeError(f"Target FASTA ID canonicalization produced collisions: {collisions[:10]}")
    write_fasta(destination, canonical_records)
    return destination, {"canonicalized": True, "records": len(canonical_records), "id_collisions": []}


def expected_network_candidate_count(clustered_fasta: Path, reference_fasta: Path) -> int:
    reference_aliases = {alias for row in parse_fasta(reference_fasta) for alias in accession_aliases(row["id"])}
    count = 0
    for row in parse_fasta(clustered_fasta):
        if not (accession_aliases(row["id"]) & reference_aliases):
            count += 1
    return count


def save_stage_artifacts(run_dir: Path, work_dir: Path) -> dict[str, dict[str, Any]]:
    """Copy compact result artifacts out of the task directory and hash them."""
    names = [
        "ref.fasta", "ref_cdhit90.fasta", "ref_cdhit90.mafft.fasta", "ref.hmm",
        "hmmsearch.tblout", "hits_all.csv", "hits_filtered.csv", "hits_filtered.fasta",
        "scoring_input_auto.mafft.fasta", "scored_results.csv", "scored_passed.fasta",
        "candidates_cdhit85.fasta", "candidates_cdhit85.fasta.clstr",
        "nodes.csv", "edges_similarity.csv", "predicted_metrics.csv",
    ]
    output: dict[str, dict[str, Any]] = {}
    artifact_dir = run_dir / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        source = work_dir / name
        if not source.is_file():
            continue
        destination = artifact_dir / name
        shutil.copy2(source, destination)
        output[name] = {"bytes": destination.stat().st_size, "sha256": sha256_file(destination)}
    return output


def require_prediction_services(health: dict[str, Any], names: list[str], skip_prediction: bool) -> None:
    if skip_prediction:
        return
    services = health.get("predictionServices", {})
    offline = [name for name in names if not services.get(name, {}).get("online", False)]
    if offline:
        raise RuntimeError(f"Required prediction services are offline: {', '.join(offline)}")


def run(args: argparse.Namespace) -> Path:
    client = ApiClient(args.api_url, args.api_key, timeout=args.timeout)
    health = client.get("/api/health")
    required = [item.strip() for item in args.require_services.split(",") if item.strip()]
    require_prediction_services(health, required, args.skip_prediction)

    if args.task_id:
        tasks = client.get("/api/tasks").get("tasks", [])
        task = next((item for item in tasks if item.get("id") == args.task_id), None)
        if not task:
            raise RuntimeError(f"Task not found: {args.task_id}")
    else:
        task = create_task(client, "aox-reference")
    task_id = task["id"]
    work_dir = Path(task["workDir"])

    stamp = time.strftime("%Y%m%d-%H%M%S")
    run_name = args.run_name or f"reference-{stamp}-{task_id}"
    run_dir = RESULTS_ROOT / run_name
    run_dir.mkdir(parents=True, exist_ok=False)
    save_api_payload(run_dir, "health", health)

    pipeline = read_json(BENCHMARK_ROOT / "configs/reference_pipeline.json")
    if args.candidate_identity is not None:
        pipeline["candidate_clustering"]["identity"] = args.candidate_identity
    if args.candidate_word_size is not None:
        pipeline["candidate_clustering"]["word_size"] = args.candidate_word_size
    benchmark = read_json(BENCHMARK_ROOT / "configs/benchmark.json")
    methods = read_json(BENCHMARK_ROOT / "configs/methods.json")
    source_target = args.target_fasta.resolve()
    if not source_target.is_file():
        raise FileNotFoundError(source_target)
    staged_target, id_policy = stage_target_database(work_dir, source_target, args.preserve_target_ids)

    manifest: dict[str, Any] = {
        "benchmark_id": benchmark["benchmark_id"],
        "mode": "reference_to_recommendation",
        "status": "running",
        "task_id": task_id,
        "task_work_dir": str(work_dir),
        "api_url": args.api_url,
        "server_version": health.get("version"),
        "prediction_services": health.get("predictionServices", {}),
        "target_fasta": str(source_target),
        "target_fasta_sha256": sha256_file(source_target),
        "staged_target_fasta_sha256": sha256_file(staged_target),
        "target_id_policy": id_policy,
        "effective_pipeline_config": pipeline,
        "target_context": (
            "controlled_author_post_domain_context_393; not a full UniProt reference-proteome reproduction"
            if source_target == (DATA_ROOT / "universe/author_post_domain_search_context_393.fasta").resolve()
            else "user_supplied_database"
        ),
        "completed_stages": [],
    }
    write_json(run_dir / "run_manifest.json", manifest)

    try:
        reference_text = (DATA_ROOT / "references/han_21_active_aox.fasta").read_text(encoding="utf-8")
        imported = client.post(
            "/api/reference/import-fasta", task_id=task_id,
            body={"fastaText": reference_text, "sourceName": "Han_2025_21_active_AOX"},
        )
        save_api_payload(run_dir, "reference_import", imported)
        manifest["completed_stages"].append("reference_import")

        hmm_cfg = pipeline["hmm_build"]
        hmm = client.post(
            "/api/hmm/build", task_id=task_id,
            body={
                "identity": hmm_cfg["identity"], "wordSize": hmm_cfg["word_size"],
                "coverageLong": hmm_cfg["coverage_long"], "coverageShort": hmm_cfg["coverage_short"],
                "identityLowerBound": hmm_cfg["identity_lower_bound"],
                "refFasta": imported["fasta"], "prefix": "ref",
            },
        )
        save_api_payload(run_dir, "hmm_build", hmm)
        manifest["completed_stages"].append("hmm_build")

        search = client.post(
            "/api/search/run", task_id=task_id,
            body={"mode": "local", "targetFasta": str(staged_target), "hmmFile": hmm["outputs"]["hmm"]},
        )
        save_api_payload(run_dir, "hmm_search", search)
        manifest["completed_stages"].append("hmm_search")

        filt_cfg = pipeline["search_filter"]
        filtered = client.post(
            "/api/search/filter", task_id=task_id,
            body={"scoreMin": filt_cfg["score_min"], "lenMin": filt_cfg["length_min"], "lenMax": filt_cfg["length_max"]},
        )
        save_api_payload(run_dir, "search_filter", filtered)
        manifest["completed_stages"].append("search_filter")
        if not filtered.get("filteredFasta") or not filtered.get("fastaCount"):
            raise RuntimeError("No sequences passed the HMM/length filter; downstream ranking cannot run")

        score_cfg = pipeline["residue_scoring"]
        alignment = client.post(
            "/api/scoring/prepare-alignment", task_id=task_id,
            body={
                "filteredFasta": filtered["filteredFasta"], "referenceFasta": imported["fasta"],
                "refId": score_cfg["reference_id"],
            },
        )
        save_api_payload(run_dir, "scoring_alignment", alignment)
        manifest["completed_stages"].append("scoring_alignment")

        scoring = client.post(
            "/api/scoring/run", task_id=task_id,
            body={
                "alignment": alignment["alignment"], "refId": score_cfg["reference_id"],
                "threshold": score_cfg["threshold"], "rules": score_cfg["rules"],
                "positionMode": score_cfg["position_mode"],
                "preAlignmentAnchor": score_cfg["pre_alignment_anchor"],
                "referenceFasta": imported["fasta"],
            },
        )
        save_api_payload(run_dir, "residue_scoring", scoring)
        manifest["completed_stages"].append("residue_scoring")
        if not scoring.get("passedFasta") or not scoring.get("passedCount"):
            raise RuntimeError("No sequences passed residue scoring; downstream ranking cannot run")

        cluster_cfg = pipeline["candidate_clustering"]
        clustered = client.post(
            "/api/clustering/run", task_id=task_id,
            body={
                "inputFasta": scoring["passedFasta"], "identity": cluster_cfg["identity"],
                "wordSize": cluster_cfg["word_size"],
            },
        )
        save_api_payload(run_dir, "candidate_clustering", clustered)
        manifest["completed_stages"].append("candidate_clustering")

        network_cfg = pipeline["network"]
        network = client.post(
            "/api/network/compute-similarity", task_id=task_id,
            body={
                "sourceFasta": clustered["outputFasta"], "referenceFasta": imported["fasta"],
                "includeReferenceLinks": network_cfg["include_reference_links"],
                "similarityMethod": network_cfg["similarity_method"], "forceRecompute": True,
            },
        )
        save_api_payload(run_dir, "network_similarity", network)
        expected_candidates = expected_network_candidate_count(Path(clustered["outputFasta"]), Path(imported["fasta"]))
        actual_candidates = int(network.get("candidateNodes", -1))
        manifest["network_integrity"] = {
            "expected_candidate_nodes": expected_candidates,
            "actual_candidate_nodes": actual_candidates,
            "passed": actual_candidates == expected_candidates,
        }
        if actual_candidates != expected_candidates:
            raise RuntimeError(
                "Network candidate-node count mismatch: "
                f"expected {expected_candidates} from clustered FASTA but backend produced {actual_candidates}. "
                "Pipe-formatted UniProt IDs can trigger token-collision loss; rerun without --preserve-target-ids "
                "for the declared accession-canonicalization workaround."
            )
        manifest["completed_stages"].append("network_similarity")

        prediction = run_prediction(
            client, task_id, run_dir, benchmark,
            force=args.force_prediction, skip=args.skip_prediction,
        )
        manifest["prediction_executed"] = prediction is not None
        manifest["completed_stages"].append("prediction" if prediction is not None else "prediction_skipped")

        run_methods(client, task_id, run_dir, benchmark, methods)
        manifest["completed_stages"].append("recommendation")

        write_trace(run_dir, work_dir, staged_target, args.trace_method)
        manifest["completed_stages"].append("target_trace")
        evaluate_run(run_dir)
        manifest["completed_stages"].append("evaluation")

        manifest["artifacts"] = save_stage_artifacts(run_dir, work_dir)
        manifest["status"] = "complete"
        manifest["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        write_json(run_dir / "run_manifest.json", manifest)
        return run_dir
    except Exception as exc:
        manifest["status"] = "failed"
        manifest["error"] = str(exc)
        manifest["traceback"] = traceback.format_exc()
        manifest["artifacts"] = save_stage_artifacts(run_dir, work_dir)
        manifest["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        write_json(run_dir / "run_manifest.json", manifest)
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default=os.environ.get("AOX_BENCH_API_URL", "http://127.0.0.1:8787"))
    parser.add_argument("--api-key", default=os.environ.get("API_KEY", ""))
    parser.add_argument("--task-id", help="Use an existing empty task instead of creating one")
    parser.add_argument("--run-name", default="")
    parser.add_argument(
        "--target-fasta", type=Path,
        default=DATA_ROOT / "universe/author_post_domain_search_context_393.fasta",
        help="Search database. Default is the controlled 393-sequence author context; use a frozen full database for a broader test.",
    )
    parser.add_argument("--preserve-target-ids", action="store_true", help="Do not canonicalize pipe-formatted FASTA IDs; useful for exposing raw-ID compatibility failures")
    parser.add_argument("--candidate-identity", type=float, help="Override candidate CD-HIT identity, e.g. 1.0 for exact-target-retention sensitivity analysis")
    parser.add_argument("--candidate-word-size", type=int, help="Override candidate CD-HIT word size")
    parser.add_argument("--skip-prediction", action="store_true")
    parser.add_argument("--force-prediction", action="store_true")
    parser.add_argument("--require-services", default="cataPro,solubility,tm")
    parser.add_argument("--trace-method", default="product_default")
    parser.add_argument("--timeout", type=float, default=7200.0, help="HTTP timeout per long-running stage, seconds")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        run_dir = run(args)
    except Exception as exc:
        print(f"Benchmark failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print(f"End-to-end benchmark complete: {run_dir}")
    print(f"Report: {run_dir / 'report.md'}")


if __name__ == "__main__":
    main()
