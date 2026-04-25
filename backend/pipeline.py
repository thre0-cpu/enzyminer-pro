#!/usr/bin/env python3
import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd
from Bio import AlignIO, Entrez, SeqIO


DEFAULT_SCORING_RULES = [
    (13, {"G"}, 5, "FAD_13_G"),
    (15, {"G"}, 5, "FAD_15_G"),
    (18, {"G"}, 5, "FAD_18_G"),
    (660, {"Uni"}, -0.1, "PTS_660"),
]

_UNIPROT_ACC_RE = re.compile(
    r"^[OPQ][0-9][A-Z0-9]{3}[0-9]$"
    r"|^[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]$"
    r"|^[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9][A-Z][A-Z0-9]{2}[0-9]$"
)

_NUCL_ACC_RE = re.compile(r"^[A-Z]\d{5}$|^[A-Z]{2}\d{6,8}$")

_CSV_COLUMNS = [
    "input", "type", "accession", "kingdom", "phylum", "class", "order", "family", "genus", "species",
    "description", "length", "sequence",
]


def _is_uniprot_accession(acc: str) -> bool:
    """Return True if *acc* looks like a UniProt (SwissProt/TrEMBL) accession."""
    return bool(_UNIPROT_ACC_RE.match(acc.split(".")[0]))


def _is_nucleotide_accession(acc: str) -> bool:
    """Return True for NCBI nucleotide accessions (e.g. MF540777, AF123456)."""
    base = acc.split(".")[0]
    if "_" in acc:
        return False
    return bool(_NUCL_ACC_RE.match(base))


def _http_get(url, *, accept=None, context, retries=3):
    headers = {"User-Agent": "enzymeminer-pro/1.0"}
    if accept:
        headers["Accept"] = accept

    last_exc = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last_exc = exc
            retryable = exc.code in {408, 429, 500, 502, 503, 504}
            if not retryable or attempt == retries:
                raise RuntimeError(f"{context} failed (HTTP {exc.code})") from exc
            print(
                f"  Retry {attempt}/{retries} for {context} after HTTP {exc.code}",
                file=sys.stderr,
            )
        except Exception as exc:
            last_exc = exc
            if attempt == retries:
                raise RuntimeError(f"{context} failed: {exc}") from exc
            print(
                f"  Retry {attempt}/{retries} for {context} after error: {exc}",
                file=sys.stderr,
            )
        time.sleep(2)

    raise RuntimeError(f"{context} failed: {last_exc}")


def _http_get_json(url, *, context, retries=3):
    payload = _http_get(url, accept="application/json", context=context, retries=retries)
    return json.loads(payload.decode("utf-8"))


def _format_fasta(accession, sequence, description=""):
    header = accession if not description else f"{accession} {description}"
    chunks = [sequence[idx:idx + 60] for idx in range(0, len(sequence), 60)]
    return ">" + header + "\n" + "\n".join(chunks) + "\n"


def _taxonomy_from_lineage(lineage):
    return {
        "kingdom": lineage[0] if len(lineage) > 0 else "",
        "phylum": lineage[2] if len(lineage) > 2 else "",
        "class": lineage[3] if len(lineage) > 3 else "",
        "order": lineage[4] if len(lineage) > 4 else "",
        "family": lineage[5] if len(lineage) > 5 else "",
        "genus": lineage[6] if len(lineage) > 6 else "",
    }


def _resolve_uniparc_fallback(acc, uniparc_id):
    data = _http_get_json(
        f"https://rest.uniprot.org/uniparc/{uniparc_id}?format=json",
        context=f"UniParc lookup for {acc} via {uniparc_id}",
    )
    sequence = data.get("sequence", {}).get("value", "")
    if not sequence:
        raise RuntimeError(f"UniParc fallback for {acc} returned no sequence")

    cross_refs = data.get("uniParcCrossReferences") or []
    matching_ref = next(
        (
            ref for ref in cross_refs
            if ref.get("database", "").startswith("UniProtKB") and ref.get("id") == acc
        ),
        None,
    )
    active_ref = next((ref for ref in cross_refs if ref.get("active")), None)
    meta_ref = matching_ref or active_ref or {}
    organism = meta_ref.get("organism") or {}
    description = meta_ref.get("proteinName", "")

    row = {
        "accession": acc,
        "input": acc,
        "type": "uniprot",
        "kingdom": "",
        "phylum": "",
        "class": "",
        "order": "",
        "family": "",
        "genus": "",
        "species": organism.get("scientificName", ""),
        "description": description,
        "length": len(sequence),
        "sequence": sequence,
    }
    return row, _format_fasta(acc, sequence, description)


def fetch_from_ncbi(accessions, email, origin_map=None):
    if origin_map is None:
        origin_map = {}
    Entrez.email = email
    ids = ",".join(accessions)

    retries = 3
    for attempt in range(retries):
        try:
            handle_gb = Entrez.efetch(db="protein", id=ids, rettype="gb", retmode="text")
            break
        except Exception as exc:
            if attempt == retries - 1:
                raise RuntimeError(
                    f"NCBI efetch failed for {ids}. "
                    "Make sure these are valid NCBI protein accessions (e.g. AAB57849.1)."
                ) from exc
            print(f"  Retry {attempt+1}/{retries} for {ids} after error: {exc}", file=sys.stderr)
            time.sleep(2)
    records_gb = list(SeqIO.parse(handle_gb, "genbank"))
    handle_gb.close()

    rows = []
    for record in records_gb:
        taxonomy = record.annotations.get("taxonomy", [])
        kingdom = taxonomy[0] if len(taxonomy) > 0 else ""
        phylum = taxonomy[2] if len(taxonomy) > 2 else ""
        cls = taxonomy[3] if len(taxonomy) > 3 else ""
        order = taxonomy[4] if len(taxonomy) > 4 else ""
        family = taxonomy[5] if len(taxonomy) > 5 else ""
        genus = taxonomy[6] if len(taxonomy) > 6 else ""
        origin = origin_map.get(record.id, (record.id, "ncbi_protein"))
        rows.append(
            {
                "accession": record.id,
                "input": origin[0],
                "type": origin[1],
                "kingdom": kingdom,
                "phylum": phylum,
                "class": cls,
                "order": order,
                "family": family,
                "genus": genus,
                "species": record.annotations.get("organism", ""),
                "description": record.description,
                "length": len(record.seq),
                "sequence": str(record.seq),
            }
        )

    df = pd.DataFrame(rows, columns=_CSV_COLUMNS)

    for attempt in range(retries):
        try:
            handle_fasta = Entrez.efetch(db="protein", id=ids, rettype="fasta", retmode="text")
            break
        except Exception as exc:
            if attempt == retries - 1:
                raise RuntimeError(f"NCBI fasta efetch failed for {ids}: {exc}") from exc
            print(f"  Retry {attempt+1}/{retries} for {ids} fasta after error: {exc}", file=sys.stderr)
            time.sleep(2)

    fasta_text = handle_fasta.read()
    handle_fasta.close()

    return df, fasta_text


def fetch_from_uniprot(accessions):
    """Fetch protein records from the UniProt REST API."""
    rows = []
    fasta_parts = []
    for acc in accessions:
        data = _http_get_json(
            f"https://rest.uniprot.org/uniprotkb/{acc}.json",
            context=f"UniProt lookup for {acc}",
        )

        if str(data.get("entryType", "")).strip().lower() == "inactive":
            inactive_reason = data.get("inactiveReason", {})
            uniparc_id = (data.get("extraAttributes") or {}).get("uniParcId")
            if not uniparc_id:
                reason = inactive_reason.get("inactiveReasonType", "inactive")
                raise RuntimeError(
                    f"UniProt accession {acc} is {reason.lower()} and no UniParc fallback is available."
                )
            print(
                f"  UniProt accession {acc} is inactive; using UniParc {uniparc_id}",
                file=sys.stderr,
            )
            row, fasta_text = _resolve_uniparc_fallback(acc, uniparc_id)
            rows.append(row)
            fasta_parts.append(fasta_text.strip())
            continue

        organism = data.get("organism", {})
        taxonomy = _taxonomy_from_lineage(organism.get("lineage", []))

        prot_desc = ""
        pn = data.get("proteinDescription", {})
        rec_name = pn.get("recommendedName") or (pn.get("submissionNames") or [{}])[0]
        if rec_name:
            prot_desc = rec_name.get("fullName", {}).get("value", "")

        sequence = data.get("sequence", {}).get("value", "")
        if not sequence:
            raise RuntimeError(f"UniProt lookup for {acc} returned no sequence")

        rows.append({
            "accession": data.get("primaryAccession", acc),
            "input": acc,
            "type": "uniprot",
            "kingdom": taxonomy["kingdom"],
            "phylum": taxonomy["phylum"],
            "class": taxonomy["class"],
            "order": taxonomy["order"],
            "family": taxonomy["family"],
            "genus": taxonomy["genus"],
            "species": organism.get("scientificName", ""),
            "description": prot_desc,
            "length": len(sequence),
            "sequence": sequence,
        })
        fasta_parts.append(_format_fasta(data.get("primaryAccession", acc), sequence, prot_desc).strip())

    df = pd.DataFrame(rows, columns=_CSV_COLUMNS)
    return df, "\n".join(fasta_parts) + "\n" if fasta_parts else ""


def resolve_nucleotide_to_protein_ids(accessions, email):
    """Map nucleotide GenBank accessions to their CDS protein_id values via NCBI."""
    Entrez.email = email
    ids = ",".join(accessions)

    retries = 3
    for attempt in range(retries):
        try:
            handle = Entrez.efetch(db="nucleotide", id=ids, rettype="gb", retmode="text")
            break
        except Exception as exc:
            if attempt == retries - 1:
                raise RuntimeError(
                    f"NCBI nucleotide efetch failed for {ids}: {exc}"
                ) from exc
            print(f"  Retry {attempt+1}/{retries} for {ids} after error: {exc}", file=sys.stderr)
            time.sleep(2)

    records = list(SeqIO.parse(handle, "genbank"))
    handle.close()

    protein_pairs = []
    for record in records:
        found = False
        for feat in record.features:
            if feat.type == "CDS" and "protein_id" in feat.qualifiers:
                pid = feat.qualifiers["protein_id"][0]
                protein_pairs.append((pid, record.id))
                print(f"  {record.id} -> {pid}", file=sys.stderr)
                found = True
        if not found:
            print(
                f"WARNING: no CDS with protein_id in nucleotide record {record.id}",
                file=sys.stderr,
            )

    return protein_pairs


def parse_hmm_tblout(tblout, target_fasta, output_csv):
    lengths = {}
    sequences = {}
    for rec in SeqIO.parse(str(target_fasta), "fasta"):
        seq = str(rec.seq)
        lengths[rec.id] = len(seq)
        sequences[rec.id] = seq

    rows = []
    with open(tblout, "r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip() or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 8:
                continue

            target = parts[0]
            evalue = None
            score = None
            try:
                evalue = float(parts[4])
            except Exception:
                evalue = None
            try:
                score = float(parts[5])
            except Exception:
                score = None

            rows.append(
                {
                    "target": target,
                    "hmm_score": score,
                    "evalue": evalue,
                    "length": lengths.get(target),
                    "sequence": sequences.get(target, ""),
                }
            )

    df = pd.DataFrame(rows)
    df.to_csv(output_csv, index=False)


def filter_hits(input_csv, output_csv, score_min, len_min, len_max):
    df = pd.read_csv(input_csv)
    score_col = "hmm_score" if "hmm_score" in df.columns else "score"
    filt = df[(df[score_col] >= score_min) & (df["length"] >= len_min) & (df["length"] <= len_max)].copy()
    filt.to_csv(output_csv, index=False)
    return len(df), len(filt)


def get_column_map_from_record(ref_rec):
    col_map = {}
    current_res_num = 0
    for col_idx, aa in enumerate(str(ref_rec.seq)):
        if aa != "-":
            current_res_num += 1
            col_map[current_res_num] = col_idx
    return col_map


def get_column_map(alignment, ref_id_part=None):
    ref_rec = None
    token = str(ref_id_part or "").strip()
    if token:
        for rec in alignment:
            if token in rec.id or token in rec.description:
                ref_rec = rec
                break
        if not ref_rec:
            raise ValueError(f"Cannot find reference sequence in alignment by token: {token}")
    else:
        if not alignment:
            raise ValueError("Alignment has no sequences")
        ref_rec = alignment[0]

    return get_column_map_from_record(ref_rec)


def normalize_scoring_rules(raw_rules):
    if raw_rules is None:
        return DEFAULT_SCORING_RULES

    if not isinstance(raw_rules, list) or not raw_rules:
        raise ValueError("rules must be a non-empty list")

    normalized = []
    for idx, item in enumerate(raw_rules, 1):
        if isinstance(item, dict):
            pos = item.get("pos")
            allowed = item.get("allowed")
            score_val = item.get("score")
            label = item.get("label") or f"rule_{idx}"
        elif isinstance(item, (list, tuple)) and len(item) == 4:
            pos, allowed, score_val, label = item
        else:
            raise ValueError(f"rule #{idx} must be dict(pos, allowed, score, label) or 4-item list")

        try:
            pos = int(pos)
        except Exception as exc:
            raise ValueError(f"rule #{idx} has invalid pos: {pos}") from exc
        if pos <= 0:
            raise ValueError(f"rule #{idx} pos must be > 0")

        if not isinstance(allowed, (list, tuple, set)) or not allowed:
            raise ValueError(f"rule #{idx} allowed must be a non-empty list")

        allowed_tokens = {str(x).strip().upper() for x in allowed if str(x).strip()}
        if not allowed_tokens:
            raise ValueError(f"rule #{idx} allowed has no valid values")
        if "UNI" in allowed_tokens:
            allowed_set = {"Uni"}
        else:
            allowed_set = allowed_tokens

        try:
            score_val = float(score_val)
        except Exception as exc:
            raise ValueError(f"rule #{idx} has invalid score: {score_val}") from exc

        label = str(label).strip()
        if not label:
            raise ValueError(f"rule #{idx} label must not be empty")

        normalized.append((pos, allowed_set, score_val, label))

    return normalized


def score_alignment(alignment_path, ref_id, output_csv, threshold, raw_rules=None, position_mode="pre"):
    rules = normalize_scoring_rules(raw_rules)
    mode = str(position_mode or "pre").strip().lower()
    if mode not in {"pre", "aligned"}:
        raise ValueError("position_mode must be one of: pre, aligned")

    aln = AlignIO.read(str(alignment_path), "fasta")
    col_map = get_column_map(aln, ref_id if mode == "pre" else None)
    aln_len = aln.get_alignment_length()

    scored_rows = []
    for rec in aln:
        res_detail = {}
        total_score = 0.0

        for pos, allowed_set, score_val, label in rules:
            if mode == "aligned":
                target_col = pos - 1
                if target_col < 0 or target_col >= aln_len:
                    target_col = None
            else:
                target_col = col_map.get(pos)
            if target_col is None:
                res_detail[label] = "-"
                continue

            aa = rec.seq[target_col].upper()
            if allowed_set == {"Uni"}:
                if aa != "-":
                    total_score += score_val
            else:
                if aa in allowed_set:
                    total_score += score_val
            res_detail[label] = aa

        scored_rows.append(
            {
                "id": rec.id,
                "seq_score": total_score,
                "pass_rule": total_score >= threshold,
                **res_detail,
            }
        )

    df = pd.DataFrame(scored_rows).sort_values("seq_score", ascending=False)
    df.to_csv(output_csv, index=False)
    return len(df), int(df["pass_rule"].sum())


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch_cmd = subparsers.add_parser("fetch-reference")
    fetch_cmd.add_argument("--work-dir", required=True)
    fetch_cmd.add_argument("--email", required=True)
    fetch_cmd.add_argument("--accessions-json", required=True)

    parse_tblout_cmd = subparsers.add_parser("parse-hmm-tblout")
    parse_tblout_cmd.add_argument("--tblout", required=True)
    parse_tblout_cmd.add_argument("--target-fasta", required=True)
    parse_tblout_cmd.add_argument("--output-csv", required=True)

    filter_cmd = subparsers.add_parser("filter-hits")
    filter_cmd.add_argument("--input-csv", required=True)
    filter_cmd.add_argument("--output-csv", required=True)
    filter_cmd.add_argument("--score-min", required=True, type=float)
    filter_cmd.add_argument("--len-min", required=True, type=int)
    filter_cmd.add_argument("--len-max", required=True, type=int)

    score_cmd = subparsers.add_parser("score-alignment")
    score_cmd.add_argument("--alignment", required=True)
    score_cmd.add_argument("--ref-id", required=False)
    score_cmd.add_argument("--output-csv", required=True)
    score_cmd.add_argument("--threshold", required=True, type=float)
    score_cmd.add_argument("--rules-json", required=False)
    score_cmd.add_argument("--position-mode", choices=["pre", "aligned"], default="pre")

    args = parser.parse_args()

    if args.command == "fetch-reference":
        work_dir = Path(args.work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        accessions = json.loads(args.accessions_json)

        uniprot_accs = [a for a in accessions if _is_uniprot_accession(a)]
        nucl_accs = [a for a in accessions if not _is_uniprot_accession(a) and _is_nucleotide_accession(a)]
        protein_accs = [a for a in accessions if not _is_uniprot_accession(a) and not _is_nucleotide_accession(a)]

        origin_map = {acc: (acc, "ncbi_protein") for acc in protein_accs}

        frames, fasta_parts = [], []
        if nucl_accs:
            resolved_pairs = resolve_nucleotide_to_protein_ids(nucl_accs, args.email)
            for pid, nuc_acc in resolved_pairs:
                protein_accs.append(pid)
                origin_map[pid] = (nuc_acc, "ncbi_nucleotide")
        if protein_accs:
            df_p, fa_p = fetch_from_ncbi(protein_accs, args.email, origin_map)
            frames.append(df_p)
            fasta_parts.append(fa_p)
        if uniprot_accs:
            df_u, fa_u = fetch_from_uniprot(uniprot_accs)
            frames.append(df_u)
            fasta_parts.append(fa_u)

        df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=_CSV_COLUMNS)
        fasta_text = "".join(fasta_parts)

        csv_path = work_dir / "ref.csv"
        fa_path = work_dir / "ref.fasta"
        df.to_csv(csv_path, index=False)
        fa_path.write_text(fasta_text, encoding="utf-8")
        print(json.dumps({"rows": len(df), "csv": str(csv_path), "fasta": str(fa_path)}))
        return

    if args.command == "parse-hmm-tblout":
        parse_hmm_tblout(args.tblout, args.target_fasta, args.output_csv)
        print(json.dumps({"ok": True, "csv": args.output_csv}))
        return

    if args.command == "filter-hits":
        total, kept = filter_hits(args.input_csv, args.output_csv, args.score_min, args.len_min, args.len_max)
        print(json.dumps({"total": total, "kept": kept, "csv": args.output_csv}))
        return

    if args.command == "score-alignment":
        custom_rules = None
        if args.rules_json:
            custom_rules = json.loads(Path(args.rules_json).read_text(encoding="utf-8"))
        total, passed = score_alignment(
            args.alignment,
            args.ref_id,
            args.output_csv,
            args.threshold,
            custom_rules,
            args.position_mode,
        )
        print(
            json.dumps(
                {
                    "total": total,
                    "passed": passed,
                    "csv": args.output_csv,
                    "rules_count": len(normalize_scoring_rules(custom_rules)),
                    "threshold": args.threshold,
                    "position_mode": args.position_mode,
                }
            )
        )
        return


if __name__ == "__main__":
    main()
