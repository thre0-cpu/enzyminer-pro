#!/usr/bin/env python3
"""Trace Han high-activity targets through an end-to-end benchmark task."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

from common import accession_aliases, parse_fasta, read_csv, read_tsv, write_json, write_tsv


def id_set_from_fasta(path: Path | None) -> set[str]:
    if path is None or not path.is_file():
        return set()
    return {alias for row in parse_fasta(path) for alias in accession_aliases(row["id"])}


def id_set_from_csv(path: Path | None, fields: Iterable[str]) -> set[str]:
    if path is None or not path.is_file():
        return set()
    aliases: set[str] = set()
    for row in read_csv(path):
        value = next((row.get(field, "") for field in fields if row.get(field, "")), "")
        aliases.update(accession_aliases(value))
    return aliases


def contains(aliases: set[str], accession: str) -> bool:
    return bool(aliases & accession_aliases(accession))


def rank_map(path: Path | None) -> dict[str, int]:
    if path is None or not path.is_file():
        return {}
    result: dict[str, int] = {}
    for index, row in enumerate(read_csv(path), 1):
        raw = row.get("id", "")
        try:
            rank = int(float(row.get("rank") or index))
        except ValueError:
            rank = index
        for alias in accession_aliases(raw):
            result.setdefault(alias, rank)
    return result


def lookup_rank(ranks: dict[str, int], accession: str) -> int | None:
    values = [ranks[alias] for alias in accession_aliases(accession) if alias in ranks]
    return min(values) if values else None


def build_trace(
    *,
    targets_tsv: Path,
    database_fasta: Path | None,
    hits_csv: Path | None,
    filtered_csv: Path | None,
    scored_csv: Path | None,
    passed_fasta: Path | None,
    clustered_fasta: Path | None,
    nodes_csv: Path | None,
    predictions_csv: Path | None,
    ranking_csv: Path | None,
) -> list[dict[str, object]]:
    database = id_set_from_fasta(database_fasta)
    hits = id_set_from_csv(hits_csv, ("target", "accession", "id"))
    filtered = id_set_from_csv(filtered_csv, ("target", "accession", "id"))
    scored = id_set_from_csv(scored_csv, ("id", "target", "accession"))
    passed = id_set_from_fasta(passed_fasta)
    clustered = id_set_from_fasta(clustered_fasta)
    nodes = id_set_from_csv(nodes_csv, ("id", "accession", "target"))
    predictions = id_set_from_csv(predictions_csv, ("id", "accession", "target"))
    ranks = rank_map(ranking_csv)

    rows: list[dict[str, object]] = []
    for target in read_tsv(targets_tsv):
        accession = target["accession"]
        rank = lookup_rank(ranks, accession)
        rows.append(
            {
                "accession": accession,
                "activity_mU_mg": target.get("activity_mU_mg", ""),
                "present_in_database": int(contains(database, accession)),
                "hmm_retrieved": int(contains(hits, accession)),
                "passed_length_filter": int(contains(filtered, accession)),
                "present_in_scoring_table": int(contains(scored, accession)),
                "passed_residue_scoring": int(contains(passed, accession)),
                "passed_candidate_clustering": int(contains(clustered, accession)),
                "present_in_network": int(contains(nodes, accession)),
                "received_prediction": int(contains(predictions, accession)),
                "received_recommendation_score": int(rank is not None),
                "global_rank": rank if rank is not None else "",
            }
        )
    return rows


def write_trace(run_dir: Path, work_dir: Path, database_fasta: Path, method: str = "product_default") -> list[dict[str, object]]:
    ranking = run_dir / "rankings" / f"{method}.csv"
    rows = build_trace(
        targets_tsv=Path(__file__).resolve().parents[1] / "data/labels/high_activity_targets_6.tsv",
        database_fasta=database_fasta,
        hits_csv=work_dir / "hits_all.csv",
        filtered_csv=work_dir / "hits_filtered.csv",
        scored_csv=work_dir / "scored_results.csv",
        passed_fasta=work_dir / "scored_passed.fasta",
        clustered_fasta=work_dir / "candidates_cdhit85.fasta",
        nodes_csv=work_dir / "nodes.csv",
        predictions_csv=work_dir / "predicted_metrics.csv",
        ranking_csv=ranking,
    )
    fields = list(rows[0]) if rows else []
    write_tsv(run_dir / "target_stage_trace.tsv", rows, fields)
    write_json(
        run_dir / "target_stage_trace.json",
        {
            "ranking_method": method,
            "warning": "A missing downstream target may be caused by an upstream loss. Untested candidates are not treated as negatives.",
            "targets": rows,
        },
    )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--database-fasta", type=Path, required=True)
    parser.add_argument("--method", default="product_default")
    args = parser.parse_args()
    rows = write_trace(args.run_dir.resolve(), args.work_dir.resolve(), args.database_fasta.resolve(), args.method)
    print(f"Wrote {len(rows)} target traces to {args.run_dir / 'target_stage_trace.tsv'}")


if __name__ == "__main__":
    main()
