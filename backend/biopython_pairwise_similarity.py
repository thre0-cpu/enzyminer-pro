#!/usr/bin/env python3
import json
import sys
from typing import Any, Dict, List, Optional

from Bio.Align import PairwiseAligner


def _build_aligner(method: str, scoring: Dict[str, Any]) -> PairwiseAligner:
    aligner = PairwiseAligner()
    aligner.mode = "global" if method == "needleman-wunsch" else "local"
    aligner.match_score = float(scoring.get("match", 2))
    aligner.mismatch_score = float(scoring.get("mismatch", -1))
    aligner.open_gap_score = float(scoring.get("open_gap", -1))
    aligner.extend_gap_score = float(scoring.get("extend_gap", -1))
    return aligner


def _similarity_pct(seq_a: str, seq_b: str, aligner: PairwiseAligner) -> Optional[float]:
    a = (seq_a or "").strip().upper()
    b = (seq_b or "").strip().upper()
    if not a or not b:
        return None

    alignment = aligner.align(a, b)[0]
    aligned_a, aligned_b = alignment.aligned

    matches = 0
    aligned_both = 0

    for (s1, e1), (s2, e2) in zip(aligned_a, aligned_b):
        length = min(e1 - s1, e2 - s2)
        if length <= 0:
            continue

        chunk_a = a[s1 : s1 + length]
        chunk_b = b[s2 : s2 + length]
        aligned_both += length
        matches += sum(1 for x, y in zip(chunk_a, chunk_b) if x == y)

    if aligned_both <= 0:
        return 0.0
    return (matches / aligned_both) * 100.0


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: biopython_pairwise_similarity.py <input.json> <output.json>", file=sys.stderr)
        return 2

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    method = str(payload.get("method") or "needleman-wunsch").strip().lower()
    if method not in {"needleman-wunsch", "smith-waterman"}:
        method = "needleman-wunsch"

    scoring = payload.get("scoring") if isinstance(payload.get("scoring"), dict) else {}
    pairs: List[Dict[str, Any]] = payload.get("pairs") if isinstance(payload.get("pairs"), list) else []
    phase = str(payload.get("phase") or method).strip() or method

    aligner = _build_aligner(method, scoring)

    total = len(pairs)
    step = max(1, total // 100) if total > 0 else 1
    print(f"PROGRESS|{phase}|0|{max(1, total)}", flush=True)

    results: List[Optional[float]] = []
    for idx, p in enumerate(pairs, start=1):
        seq_a = str(p.get("seqA") or "")
        seq_b = str(p.get("seqB") or "")
        results.append(_similarity_pct(seq_a, seq_b, aligner))
        if idx % step == 0 or idx == total:
            print(f"PROGRESS|{phase}|{idx}|{max(1, total)}", flush=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"method": method, "results": results}, f)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
