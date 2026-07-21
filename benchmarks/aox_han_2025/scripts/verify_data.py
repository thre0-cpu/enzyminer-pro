#!/usr/bin/env python3
"""Verify static Han AOX benchmark artifacts, counts, membership and hashes."""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from common import BENCHMARK_ROOT, normalize_accession, parse_fasta, read_csv, read_json, read_tsv, sha256_file, write_json


def ids_fasta(path: Path) -> set[str]:
    return {normalize_accession(row["id"]) for row in parse_fasta(path)}


def verify() -> dict[str, object]:
    data = BENCHMARK_ROOT / "data"
    manifest = read_json(BENCHMARK_ROOT / "provenance/manifest.json")
    refs = ids_fasta(data / "references/han_21_active_aox.fasta")
    graph_all = ids_fasta(data / "universe/author_graph_358_all.fasta")
    graph_candidates = ids_fasta(data / "universe/author_graph_339_candidates.fasta")
    controlled = ids_fasta(data / "universe/author_post_domain_search_context_393.fasta")
    graph_ref = ids_fasta(data / "references/author_graph_19_reference_nodes.fasta")
    workflow = {normalize_accession(row["accession"]) for row in read_tsv(data / "labels/workflow_tested_31.tsv")}
    primary = {normalize_accession(row["accession"]) for row in read_tsv(data / "labels/primary_novel_tested_23.tsv")}
    high = {normalize_accession(row["accession"]) for row in read_tsv(data / "labels/high_activity_targets_6.tsv")}
    edges = read_csv(data / "network/edges_similarity.csv")

    checks = {
        "references_21": len(refs) == 21,
        "author_graph_nodes_358": len(graph_all) == 358,
        "author_graph_reference_nodes_19": len(graph_ref) == 19,
        "recommendable_candidates_339": len(graph_candidates) == 339,
        "controlled_context_393": len(controlled) == 393,
        "network_edges_complete_358_choose_2": len(edges) == math.comb(358, 2),
        "workflow_tested_31": len(workflow) == 31,
        "primary_novel_tested_23": len(primary) == 23,
        "high_activity_targets_6": len(high) == 6,
        "all_primary_in_candidates": primary <= graph_candidates,
        "all_high_in_candidates": high <= graph_candidates,
        "high_not_in_references": not bool(high & refs),
        "graph_partition_19_plus_339": graph_ref | graph_candidates == graph_all and not (graph_ref & graph_candidates),
    }
    hash_failures: list[dict[str, str]] = []
    for relative, expected in manifest.get("generated_files", {}).items():
        path = BENCHMARK_ROOT / relative
        actual = sha256_file(path) if path.is_file() else "MISSING"
        if actual != expected:
            hash_failures.append({"file": relative, "expected": expected, "actual": actual})
    checks["manifest_hashes_match"] = not hash_failures
    return {
        "ok": all(checks.values()),
        "checks": checks,
        "hash_failures": hash_failures,
        "known_warning": manifest.get("known_reproducibility_warning"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, help="Also write result JSON")
    args = parser.parse_args()
    result = verify()
    for name, passed in result["checks"].items():
        print(f"[{'OK' if passed else 'FAIL'}] {name}")
    if result["hash_failures"]:
        for failure in result["hash_failures"]:
            print(f"[HASH FAIL] {failure['file']}")
    print(f"\nKnown source inconsistency: {result['known_warning']}")
    if args.json:
        write_json(args.json, result)
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
