#!/usr/bin/env python3
"""Prepare reproducible benchmark inputs from the official Han AOX repository."""
from __future__ import annotations

import argparse
import csv
import re
import subprocess
from pathlib import Path

from common import (
    BENCHMARK_ROOT,
    DATA_ROOT,
    normalize_accession,
    parse_fasta,
    sha256_file,
    write_csv,
    write_fasta,
    write_json,
    write_tsv,
)

SOURCE_FILES = [
    "data/aox/raw/sequence.fasta",
    "data/aox/raw/known_sequence.tsv",
    "data/aox/cache/hmmsearch.tsv",
    "data/aox/cache/hmmsearch_600_700_added.fasta",
    "data/aox/result/sequence_results.tsv",
    "data/aox/result/sequence_picked_results.tsv",
    "data/aox/result/experiment_result.tsv",
    "data/aox/graph/acc/nodes.tsv",
    "data/aox/graph/acc/edges.tsv",
]


def read_table(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def git_value(repo: Path, args: list[str]) -> str:
    try:
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
    except Exception:
        return "unknown"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", required=True, type=Path, help="Official enzyme-mining-aox repository")
    parser.add_argument("--output-root", type=Path, default=DATA_ROOT)
    args = parser.parse_args()
    source = args.source_repo.resolve()
    out = args.output_root.resolve()

    missing = [rel for rel in SOURCE_FILES if not (source / rel).is_file()]
    if missing:
        raise SystemExit("Missing source files:\n" + "\n".join(missing))

    references = parse_fasta(source / "data/aox/raw/sequence.fasta")
    write_fasta(out / "references/han_21_active_aox.fasta", references)

    known = read_table(source / "data/aox/raw/known_sequence.tsv")
    known_by_acc = {normalize_accession(row.get("accession", "")): row for row in known}
    write_tsv(
        out / "references/han_21_reference_metadata.tsv",
        [
            {
                "accession": normalize_accession(record["id"]),
                "fasta_id": record["id"],
                "organism": known_by_acc.get(normalize_accession(record["id"]), {}).get("organism", ""),
                "phylum": known_by_acc.get(normalize_accession(record["id"]), {}).get("ph", ""),
                "class": known_by_acc.get(normalize_accession(record["id"]), {}).get("cls", ""),
                "taxid": known_by_acc.get(normalize_accession(record["id"]), {}).get("taxid", ""),
            }
            for record in references
        ],
        ["accession", "fasta_id", "organism", "phylum", "class", "taxid"],
    )

    picked = read_table(source / "data/aox/result/sequence_picked_results.tsv")
    picked_by_id = {row["sequence_id"]: row for row in picked}
    result_rows = read_table(source / "data/aox/result/sequence_results.tsv")
    result_by_acc = {normalize_accession(row["acc"]): row for row in result_rows}
    graph_nodes = read_table(source / "data/aox/graph/acc/nodes.tsv")
    graph_ids = [row["accession"] for row in graph_nodes]
    graph_id_set = set(graph_ids)
    ref_ids = {row["accession"] for row in graph_nodes if row.get("active_sequence") == "True"}

    hmm_rows = read_table(source / "data/aox/cache/hmmsearch.tsv")
    hmm_by_raw = {row["acc"]: row for row in hmm_rows}
    hmm_by_norm: dict[str, dict[str, str]] = {}
    for row in hmm_rows:
        hmm_by_norm.setdefault(normalize_accession(row["acc"]), row)

    experiment = read_table(source / "data/aox/result/experiment_result.tsv")
    exp_by_id = {row["name"]: row for row in experiment}

    metadata: list[dict[str, object]] = []
    candidate_records: list[dict[str, str]] = []
    reference_graph_records: list[dict[str, str]] = []
    for node in graph_nodes:
        accession = node["accession"]
        picked_row = picked_by_id.get(accession)
        if not picked_row:
            raise SystemExit(f"No sequence for graph node {accession}")
        sequence = re.sub(r"[^A-Za-z*]", "", picked_row["seq"]).upper()
        is_reference = accession in ref_ids
        record = {"id": accession, "header": accession, "sequence": sequence}
        if is_reference:
            reference_graph_records.append(record)
        else:
            candidate_records.append(record)
        hmm = hmm_by_raw.get(picked_row.get("acc", "")) or hmm_by_norm.get(accession, {})
        exp = exp_by_id.get(accession, {})
        seq_result = result_by_acc.get(normalize_accession(picked_row.get("acc", "")), {})
        activity = exp.get("activity(mU/mg)", "")
        yield_mg_l = exp.get("Yield (mg/L)", "")
        metadata.append(
            {
                "accession": accession,
                "length": len(sequence),
                "is_reference": int(is_reference),
                "phylum": node.get("phylum", ""),
                "class": node.get("class", ""),
                "organism": seq_result.get("organism", ""),
                "taxid": seq_result.get("taxid", ""),
                "paper_tax_score": node.get("score", seq_result.get("tax_score", "")),
                "paper_sequence_score": picked_row.get("seq_score", ""),
                "hmm_score": hmm.get("score", ""),
                "hmm_domain_bitscore": hmm.get("bitscore", ""),
                "hmm_evalue": hmm.get("evalue", ""),
                "experiment_round": exp.get("round", ""),
                "activity_mU_mg": activity,
                "activity_sd": exp.get("SD", ""),
                "yield_mg_L": yield_mg_l,
                "soluble_label": int(bool(yield_mg_l) and float(yield_mg_l) > 0) if yield_mg_l else "",
                "active_label": int(bool(activity) and float(activity) > 0) if activity else "",
                "high_activity_label": int(bool(activity) and float(activity) > 1000) if activity else "",
            }
        )

    write_fasta(out / "universe/author_graph_358_all.fasta", [*candidate_records, *reference_graph_records])
    write_fasta(out / "universe/author_graph_339_candidates.fasta", candidate_records)
    write_fasta(out / "references/author_graph_19_reference_nodes.fasta", reference_graph_records)

    # Controlled reference-to-recommendation search context. This is the 393-record
    # author-provided post-length/domain FASTA, not a complete reference-proteome DB.
    search_context = parse_fasta(source / "data/aox/cache/hmmsearch_600_700_added.fasta")
    write_fasta(out / "universe/author_post_domain_search_context_393.fasta", search_context)

    metadata_fields = [
        "accession", "length", "is_reference", "phylum", "class", "organism", "taxid",
        "paper_tax_score", "paper_sequence_score", "hmm_score", "hmm_domain_bitscore", "hmm_evalue",
        "experiment_round", "activity_mU_mg", "activity_sd", "yield_mg_L", "soluble_label",
        "active_label", "high_activity_label",
    ]
    write_tsv(out / "metadata/author_graph_358_metadata.tsv", metadata, metadata_fields)

    # Network files follow EnzymeMiner Pro's native schemas. Restrict the author's
    # complete 360-sequence SSN to the 358 nodes present in author graph metadata.
    nodes_csv = []
    metadata_by_id = {str(row["accession"]): row for row in metadata}
    for index, accession in enumerate(graph_ids):
        row = metadata_by_id[accession]
        nodes_csv.append(
            {
                "id": accession,
                "cluster": "author_graph",
                "representative": "1",
                "is_reference": str(row["is_reference"]),
                "kingdom": "Fungi" if row["phylum"] in {"Ascomycota", "Basidiomycota"} else "",
                "phylum": row["phylum"],
                "class": row["class"],
                "order": "",
                "family": "",
                "genus": "",
                "species": row["organism"],
                "taxonomy_id": row["taxid"],
                "length": row["length"],
                "hmm_score": row["hmm_score"],
                "evalue": row["hmm_evalue"],
                "scoring_score": row["paper_sequence_score"],
            }
        )
    write_csv(
        out / "network/nodes.csv",
        nodes_csv,
        ["id", "cluster", "representative", "is_reference", "kingdom", "phylum", "class", "order", "family", "genus", "species", "taxonomy_id", "length", "hmm_score", "evalue", "scoring_score"],
    )

    graph_edges = read_table(source / "data/aox/graph/acc/edges.tsv")
    edge_rows = []
    seen: set[tuple[str, str]] = set()
    for edge in graph_edges:
        query, target = edge["query"], edge["target"]
        if query not in graph_id_set or target not in graph_id_set or query == target:
            continue
        pair = tuple(sorted((query, target)))
        if pair in seen:
            continue
        seen.add(pair)
        similarity = float(edge["id"])
        edge_rows.append(
            {
                "source": pair[0],
                "target": pair[1],
                "similarity": f"{similarity:.6g}",
                "weight": f"{similarity / 100:.8g}",
                "type": "Reference_links" if pair[0] in ref_ids or pair[1] in ref_ids else "Similarity",
            }
        )
    write_csv(out / "network/edges_similarity.csv", edge_rows, ["source", "target", "similarity", "weight", "type"])

    # Primary cohort: workflow rounds 2+3, present in the graph, not reference nodes.
    primary = []
    workflow = []
    for row in experiment:
        accession = row["name"]
        if row["round"] not in {"2", "3"} or accession not in graph_id_set:
            continue
        base = {
            "accession": accession,
            "round": row["round"],
            "activity_mU_mg": row["activity(mU/mg)"],
            "activity_sd": row["SD"],
            "yield_mg_L": row["Yield (mg/L)"],
            "main_position": row["Main_Position"],
            "soluble_label": int(float(row["Yield (mg/L)"]) > 0),
            "active_label": int(float(row["activity(mU/mg)"]) > 0),
            "high_activity_label": int(float(row["activity(mU/mg)"]) > 1000),
            "is_reference": int(accession in ref_ids),
            "class": metadata_by_id[accession]["class"],
            "phylum": metadata_by_id[accession]["phylum"],
        }
        workflow.append(base)
        if accession not in ref_ids:
            primary.append(base)
    label_fields = [
        "accession", "round", "activity_mU_mg", "activity_sd", "yield_mg_L", "main_position",
        "soluble_label", "active_label", "high_activity_label", "is_reference", "class", "phylum",
    ]
    write_tsv(out / "labels/workflow_tested_31.tsv", workflow, label_fields)
    write_tsv(out / "labels/primary_novel_tested_23.tsv", primary, label_fields)
    high = [row for row in primary if row["high_activity_label"] == 1]
    write_tsv(out / "labels/high_activity_targets_6.tsv", high, label_fields)

    provenance = {
        "source_repository": "enzyme-mining-aox",
        "paper_doi": "10.1016/j.synbio.2025.04.014",
        "source_path_used": str(source),
        "source_commit": git_value(source, ["rev-parse", "HEAD"]),
        "source_commit_date": git_value(source, ["log", "-1", "--format=%cs"]),
        "source_license": "Apache-2.0",
        "generated_files": {},
        "counts": {
            "input_references": len(references),
            "author_graph_nodes": len(graph_ids),
            "reference_nodes_in_graph": len(ref_ids),
            "recommendable_candidates": len(candidate_records),
            "restricted_network_edges": len(edge_rows),
            "controlled_search_context": len(search_context),
            "workflow_tested": len(workflow),
            "primary_novel_tested": len(primary),
            "high_activity_targets": len(high),
        },
        "known_reproducibility_warning": "The current author repository graph has 358 nodes and its all-pairs edge table has 360 sequence IDs, whereas the paper reports 357 final candidates. This benchmark preserves and names the concrete artifacts instead of silently forcing the count to 357.",
    }
    for path in sorted(out.rglob("*")):
        if path.is_file():
            provenance["generated_files"][str(path.relative_to(BENCHMARK_ROOT))] = sha256_file(path)
    write_json(BENCHMARK_ROOT / "provenance/manifest.json", provenance)

    license_src = source / "LICENSE"
    if license_src.is_file():
        (BENCHMARK_ROOT / "provenance/AUTHOR_REPOSITORY_LICENSE.txt").write_text(license_src.read_text(encoding="utf-8"), encoding="utf-8")

    print("Prepared AOX benchmark data")
    for key, value in provenance["counts"].items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
