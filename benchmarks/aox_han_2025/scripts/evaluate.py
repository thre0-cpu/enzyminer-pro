#!/usr/bin/env python3
"""Evaluate AOX recommendation runs without treating untested candidates as negatives."""
from __future__ import annotations

import argparse
import math
import random
import statistics
from pathlib import Path
from typing import Any, Callable

from common import BENCHMARK_ROOT, accession_aliases, read_csv, read_json, read_tsv, write_json, write_tsv, finite_float


def average_ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda index: values[index])
    ranks = [0.0] * len(values)
    pos = 0
    while pos < len(order):
        end = pos + 1
        while end < len(order) and values[order[end]] == values[order[pos]]:
            end += 1
        avg = (pos + 1 + end) / 2.0
        for index in order[pos:end]:
            ranks[index] = avg
        pos = end
    return ranks


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    mean_x, mean_y = statistics.fmean(xs), statistics.fmean(ys)
    numerator = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    denominator = math.sqrt(sum((x - mean_x) ** 2 for x in xs) * sum((y - mean_y) ** 2 for y in ys))
    return numerator / denominator if denominator else None


def spearman(xs: list[float], ys: list[float]) -> float | None:
    return pearson(average_ranks(xs), average_ranks(ys))


def dcg(relevances: list[float], k: int) -> float:
    return sum(rel / math.log2(index + 2) for index, rel in enumerate(relevances[:k]))


def ndcg(ordered_activity: list[float], k: int) -> float:
    relevance = [math.log1p(max(0.0, value)) for value in ordered_activity]
    ideal = sorted(relevance, reverse=True)
    denominator = dcg(ideal, k)
    return dcg(relevance, k) / denominator if denominator else 0.0


def roc_auc(labels: list[int], scores: list[float]) -> float | None:
    positives = sum(labels)
    negatives = len(labels) - positives
    if not positives or not negatives:
        return None
    ranks = average_ranks(scores)
    rank_sum = sum(rank for rank, label in zip(ranks, labels) if label == 1)
    return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def average_precision(labels: list[int], scores: list[float]) -> float | None:
    positives = sum(labels)
    if not positives:
        return None
    order = sorted(range(len(scores)), key=lambda index: (-scores[index], index))
    hits = 0
    total = 0.0
    for rank, index in enumerate(order, 1):
        if labels[index] == 1:
            hits += 1
            total += hits / rank
    return total / positives


def percentile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    sorted_values = sorted(values)
    position = (len(sorted_values) - 1) * q
    lo = math.floor(position)
    hi = math.ceil(position)
    if lo == hi:
        return sorted_values[lo]
    return sorted_values[lo] * (hi - position) + sorted_values[hi] * (position - lo)


def cohort_metrics(
    order: list[str],
    labels: dict[str, dict[str, str]],
    top_k: list[int],
    universe_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Evaluate an observed ranking while treating missing labels as unranked.

    ``universe_ids`` defines the complete labelled cohort. This prevents missing
    recommendation scores from being appended alphabetically and accidentally
    counted as Top-K hits.
    """
    universe = universe_ids if universe_ids is not None else order
    activities = [float(labels[accession]["activity_mU_mg"]) for accession in order]
    highs = [int(labels[accession]["high_activity_label"]) for accession in order]
    high_total = sum(int(labels[accession]["high_activity_label"]) for accession in universe)
    ideal_relevance = sorted(
        [math.log1p(max(0.0, float(labels[accession]["activity_mU_mg"]))) for accession in universe],
        reverse=True,
    )
    result: dict[str, Any] = {
        "cohort_size": len(universe),
        "ranked_cohort_size": len(order),
        "high_activity_total": high_total,
        "spearman_rank_vs_activity": spearman([-float(index) for index in range(len(order))], activities),
    }
    for k in top_k:
        used = min(k, len(order))
        hits = sum(highs[:used])
        numerator = dcg([math.log1p(max(0.0, value)) for value in activities], k)
        denominator = dcg(ideal_relevance, k)
        result[f"hits_at_{k}"] = hits
        result[f"precision_at_{k}"] = hits / used if used else 0.0
        result[f"recall_at_{k}"] = hits / high_total if high_total else 0.0
        result[f"mean_activity_at_{k}"] = statistics.fmean(activities[:used]) if used else 0.0
        result[f"ndcg_at_{k}"] = numerator / denominator if denominator else 0.0
    return result


def simulate_random(
    accessions: list[str],
    labels: dict[str, dict[str, str]],
    top_k: list[int],
    iterations: int,
    seed: int,
    selector: Callable[[list[str], random.Random], list[str]],
) -> dict[str, Any]:
    rng = random.Random(seed)
    samples: dict[int, list[float]] = {k: [] for k in top_k}
    activity_samples: dict[int, list[float]] = {k: [] for k in top_k}
    for _ in range(iterations):
        order = selector(accessions, rng)
        for k in top_k:
            selected = order[:k]
            samples[k].append(sum(int(labels[item]["high_activity_label"]) for item in selected))
            activity_samples[k].append(statistics.fmean(float(labels[item]["activity_mU_mg"]) for item in selected))
    result: dict[str, Any] = {"iterations": iterations, "seed": seed}
    for k in top_k:
        result[f"hits_at_{k}_mean"] = statistics.fmean(samples[k])
        result[f"hits_at_{k}_ci95"] = [percentile(samples[k], 0.025), percentile(samples[k], 0.975)]
        result[f"mean_activity_at_{k}_mean"] = statistics.fmean(activity_samples[k])
        result[f"mean_activity_at_{k}_ci95"] = [percentile(activity_samples[k], 0.025), percentile(activity_samples[k], 0.975)]
    return result


def shuffled_selector(accessions: list[str], rng: random.Random) -> list[str]:
    order = list(accessions)
    rng.shuffle(order)
    return order


def make_stratified_selector(labels: dict[str, dict[str, str]]) -> Callable[[list[str], random.Random], list[str]]:
    def selector(accessions: list[str], rng: random.Random) -> list[str]:
        groups: dict[str, list[str]] = {}
        for accession in accessions:
            groups.setdefault(labels[accession].get("class") or "Unknown", []).append(accession)
        for members in groups.values():
            rng.shuffle(members)
        classes = list(groups)
        rng.shuffle(classes)
        order: list[str] = []
        while classes:
            next_classes: list[str] = []
            for class_name in classes:
                members = groups[class_name]
                if members:
                    order.append(members.pop())
                if members:
                    next_classes.append(class_name)
            rng.shuffle(next_classes)
            classes = next_classes
        return order
    return selector


def numeric_baseline_order(
    primary_ids: list[str], metadata: dict[str, dict[str, str]], field: str, reverse: bool = True
) -> list[str]:
    return sorted(
        primary_ids,
        key=lambda accession: (
            finite_float(metadata.get(accession, {}).get(field), float("-inf")) if reverse else finite_float(metadata.get(accession, {}).get(field), float("inf")),
            accession,
        ),
        reverse=reverse,
    )


def format_number(value: Any, digits: int = 3) -> str:
    if value is None:
        return "NA"
    if isinstance(value, float):
        if not math.isfinite(value):
            return "NA"
        return f"{value:.{digits}f}"
    return str(value)


def evaluate_properties(run_dir: Path, labels: dict[str, dict[str, str]]) -> dict[str, Any]:
    path = run_dir / "predictions.csv"
    if not path.is_file():
        return {"available": False}
    prediction_rows = read_csv(path)
    predictions: dict[str, dict[str, str]] = {}
    for row in prediction_rows:
        for alias in accession_aliases(row.get("id", "")):
            predictions.setdefault(alias, row)
    sol_labels: list[int] = []
    sol_scores: list[float] = []
    activity_values: list[float] = []
    efficiency_values: list[float] = []
    cata_sources: dict[str, int] = {}
    sol_sources: dict[str, int] = {}
    for accession, label in labels.items():
        row = next((predictions.get(alias) for alias in accession_aliases(accession) if alias in predictions), None)
        if not row:
            continue
        cata_source = row.get("cataPro_source", "") or row.get("catapro_source", "")
        sol_source = row.get("solubility_source", "")
        if cata_source:
            cata_sources[cata_source] = cata_sources.get(cata_source, 0) + 1
        if sol_source:
            sol_sources[sol_source] = sol_sources.get(sol_source, 0) + 1
        solubility = finite_float(row.get("solubility"))
        if solubility is not None:
            sol_labels.append(int(label["soluble_label"]))
            sol_scores.append(solubility)
        kcat = finite_float(row.get("kcat"))
        km = finite_float(row.get("km"))
        if kcat is not None and km is not None and kcat > 0 and km > 0:
            activity_values.append(float(label["activity_mU_mg"]))
            efficiency_values.append(kcat / km)
    property_result: dict[str, Any] = {
        "available": True,
        "prediction_rows": len(prediction_rows),
        "primary_solubility_coverage": len(sol_scores),
        "primary_catalytic_coverage": len(efficiency_values),
        "cata_sources": cata_sources,
        "solubility_sources": sol_sources,
    }
    if sol_scores:
        property_result.update(
            {
                "solubility_auroc": roc_auc(sol_labels, sol_scores),
                "solubility_auprc": average_precision(sol_labels, sol_scores),
                "solubility_brier": statistics.fmean((score - label) ** 2 for score, label in zip(sol_scores, sol_labels)),
            }
        )
    if efficiency_values:
        property_result["spearman_catalytic_efficiency_vs_activity"] = spearman(efficiency_values, activity_values)
    return property_result


def evaluate_run(run_dir: Path) -> dict[str, Any]:
    run_dir = run_dir.resolve()
    benchmark = read_json(BENCHMARK_ROOT / "configs/benchmark.json")
    method_manifest = read_json(run_dir / "methods_manifest.json")
    label_rows = read_tsv(BENCHMARK_ROOT / benchmark["primary_labels"])
    labels = {row["accession"]: row for row in label_rows}
    primary_ids = list(labels)
    high_targets = {row["accession"] for row in read_tsv(BENCHMARK_ROOT / benchmark["high_activity_targets"])}
    metadata_rows = read_tsv(BENCHMARK_ROOT / "data/metadata/author_graph_358_metadata.tsv")
    metadata = {row["accession"]: row for row in metadata_rows}
    top_k = [int(k) for k in benchmark["top_k"]]

    evaluation: dict[str, Any] = {
        "benchmark_id": benchmark["benchmark_id"],
        "run_dir": str(run_dir),
        "primary_cohort_size": len(primary_ids),
        "high_activity_targets": sorted(high_targets),
        "methods": {},
        "baselines": {},
        "scientific_warning": "Global ranks are valid for known target recovery, but untested candidates are not negatives; global precision is intentionally not reported.",
    }
    summary_rows: list[dict[str, Any]] = []

    for method_id, method_info in method_manifest["methods"].items():
        ranking_rows = read_csv(run_dir / "rankings" / f"{method_id}.csv")
        global_order = [row["id"] for row in ranking_rows]
        global_rank: dict[str, int] = {}
        score_map: dict[str, float | None] = {}
        for rank, row in enumerate(ranking_rows, 1):
            score = finite_float(row.get("score"), float("-inf"))
            for alias in accession_aliases(row.get("id", "")):
                global_rank.setdefault(alias, rank)
                score_map.setdefault(alias, score)
        def score_key(accession: str) -> tuple[bool, float, str]:
            score = score_map.get(accession)
            return (score is None or not math.isfinite(score), -(score if score is not None and math.isfinite(score) else 0.0), accession)
        cohort_order = sorted((accession for accession in primary_ids if accession in score_map), key=score_key)
        metrics = cohort_metrics(cohort_order, labels, top_k, universe_ids=primary_ids)
        metrics["cohort_score_coverage"] = sum(accession in score_map for accession in primary_ids)
        def known_rank(accession: str) -> int | None:
            values = [global_rank[alias] for alias in accession_aliases(accession) if alias in global_rank]
            return min(values) if values else None
        metrics["global_target_ranks"] = {accession: known_rank(accession) for accession in sorted(high_targets)}
        metrics["best_activity_target_rank"] = known_rank("A0A4U6X6L6")
        metrics["global_ranked_count"] = len(global_order)
        metrics["global_known_target_hits"] = {}
        for k in top_k:
            selected = method_info.get("selections", {}).get(str(k), [])
            metrics["global_known_target_hits"][str(k)] = len(set(selected) & high_targets)
        evaluation["methods"][method_id] = metrics
        summary_rows.append({"method": method_id, **{f"hits_at_{k}": metrics[f"hits_at_{k}"] for k in top_k}, "ndcg_at_10": metrics.get("ndcg_at_10"), "spearman": metrics.get("spearman_rank_vs_activity"), "best_target_global_rank": metrics.get("best_activity_target_rank"), "score_coverage": metrics.get("cohort_score_coverage")})

    # Deterministic score baselines are evaluated only inside the 23 labelled
    # cohort, while their score fields were computed in the complete context.
    default_ranking = read_csv(run_dir / "rankings/default_no_hard_cluster_filter.csv")
    default_features = {row["id"]: row for row in default_ranking}
    baseline_specs = {
        "hmm_score": (metadata, "hmm_score"),
        "paper_sequence_score": (metadata, "paper_sequence_score"),
        "paper_tax_score_direct": (metadata, "paper_tax_score"),
        "max_reference_similarity": (default_features, "maxRefSimilarity"),
        "average_reference_similarity": (default_features, "avgRefSimilarity"),
    }
    for baseline_id, (source, field) in baseline_specs.items():
        order = numeric_baseline_order(primary_ids, source, field)
        evaluation["baselines"][baseline_id] = cohort_metrics(order, labels, top_k)

    iterations = int(benchmark["random_iterations"])
    seed = int(benchmark["random_seed"])
    evaluation["baselines"]["random"] = simulate_random(primary_ids, labels, top_k, iterations, seed, shuffled_selector)
    evaluation["baselines"]["taxonomy_class_stratified_random"] = simulate_random(
        primary_ids, labels, top_k, iterations, seed + 1, make_stratified_selector(labels)
    )
    evaluation["property_evaluation"] = evaluate_properties(run_dir, labels)

    write_json(run_dir / "evaluation.json", evaluation)
    write_tsv(run_dir / "method_summary.tsv", summary_rows, ["method", *[f"hits_at_{k}" for k in top_k], "ndcg_at_10", "spearman", "best_target_global_rank", "score_coverage"])

    lines = [
        "# Han 2025 AOX recommendation benchmark report",
        "",
        f"- Run: `{run_dir.name}`",
        f"- Primary labelled cohort: {len(primary_ids)} novel workflow candidates",
        f"- High-activity definition: > {benchmark['high_activity_threshold_mU_mg']} mU/mg",
        f"- High-activity positives: {len(high_targets)}",
        "- Important: untested global candidates are **not** treated as inactive.",
        "",
        "## Primary result: ranking within the 23 labelled novel candidates",
        "",
        "| Method | High hits@3 | @5 | @10 | @20 | nDCG@10 | Spearman(rank, activity) | Best enzyme global rank | Label score coverage |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in summary_rows:
        lines.append(
            f"| {row['method']} | {row.get('hits_at_3', '')} | {row.get('hits_at_5', '')} | {row.get('hits_at_10', '')} | {row.get('hits_at_20', '')} | {format_number(row.get('ndcg_at_10'))} | {format_number(row.get('spearman'))} | {row.get('best_target_global_rank') or 'not ranked'} | {row.get('score_coverage')}/{len(primary_ids)} |"
        )
    random_result = evaluation["baselines"]["random"]
    stratified_result = evaluation["baselines"]["taxonomy_class_stratified_random"]
    lines.extend(
        [
            "",
            "## Random expectations",
            "",
            f"- Uniform random Top 5: mean high-activity hits = {format_number(random_result['hits_at_5_mean'])}, 95% interval = {random_result['hits_at_5_ci95']}.",
            f"- Class-stratified random Top 5: mean high-activity hits = {format_number(stratified_result['hits_at_5_mean'])}, 95% interval = {stratified_result['hits_at_5_ci95']}.",
            "",
            "## Known high-activity targets: global ranks",
            "",
            "These ranks answer whether a user would see a known high-activity enzyme in the complete recommendation output. They do not define global precision.",
            "",
        ]
    )
    for method_id, metrics in evaluation["methods"].items():
        ranks = ", ".join(f"{accession}={rank if rank is not None else 'not ranked'}" for accession, rank in metrics["global_target_ranks"].items())
        lines.append(f"- **{method_id}**: {ranks}")
    trace_path = run_dir / "target_stage_trace.tsv"
    if trace_path.is_file():
        trace_rows = read_tsv(trace_path)
        stage_columns = [
            "present_in_database", "hmm_retrieved", "passed_length_filter",
            "passed_residue_scoring", "passed_candidate_clustering",
            "present_in_network", "received_prediction", "received_recommendation_score",
        ]
        evaluation["target_stage_trace"] = trace_rows
        lines.extend(["", "## End-to-end loss localization", ""])
        lines.append("| Target | Database | HMM | Length | Residue | CD-HIT representative | Network | Prediction | Ranked | Global rank |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
        for row in trace_rows:
            values = [row.get(column, "") for column in stage_columns]
            lines.append(f"| {row.get('accession', '')} | " + " | ".join(values) + f" | {row.get('global_rank') or 'NA'} |")
        lost_at_clustering = sum(
            row.get("passed_residue_scoring") == "1" and row.get("passed_candidate_clustering") != "1"
            for row in trace_rows
        )
        if lost_at_clustering:
            lines.extend([
                "",
                f"**Critical finding:** {lost_at_clustering}/{len(trace_rows)} high-activity targets passed residue scoring but were not retained as exact CD-HIT representatives. "
                "They therefore cannot be evaluated by the downstream recommendation formula. This is an upstream product-design loss, not a recommendation success.",
            ])

    prop = evaluation["property_evaluation"]
    lines.extend(["", "## Property predictor diagnostics", ""])
    if not prop.get("available"):
        lines.append("No `predictions.csv` was available; property validation was skipped.")
    else:
        lines.extend(
            [
                f"- Solubility coverage in primary cohort: {prop.get('primary_solubility_coverage', 0)}/{len(primary_ids)}",
                f"- Solubility AUROC: {format_number(prop.get('solubility_auroc'))}",
                f"- Solubility AUPRC: {format_number(prop.get('solubility_auprc'))}",
                f"- Solubility Brier score: {format_number(prop.get('solubility_brier'))}",
                f"- CataPro kcat/Km coverage: {prop.get('primary_catalytic_coverage', 0)}/{len(primary_ids)}",
                f"- Spearman(predicted kcat/Km, experimental activity): {format_number(prop.get('spearman_catalytic_efficiency_vs_activity'))}",
            ]
        )
    lines.extend(
        [
            "",
            "## Interpretation constraints",
            "",
            "1. The 23 candidates were not a random sample of the entire candidate universe; retrospective results may contain selection bias.",
            "2. Do not tune weights on all 23 and then report the same 23 as an untouched test set.",
            "3. Missing/failed predictor outputs must remain visible through coverage; mock outputs are scientifically ineligible.",
            "4. A high global rank for a known positive is evidence of recovery, but a low global precision cannot be inferred because most candidates were never assayed.",
            "5. The author repository currently contains 358 graph nodes rather than an exact, internally consistent 357-node artifact.",
            "",
        ]
    )
    write_json(run_dir / "evaluation.json", evaluation)
    (run_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Evaluation written to {run_dir / 'report.md'}")
    return evaluation


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    evaluate_run(args.run_dir)


if __name__ == "__main__":
    main()
