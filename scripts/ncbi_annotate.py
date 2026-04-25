#!/usr/bin/env python3
"""
Annotate BLAST hits CSV with taxonomy info from NCBI Entrez.
Adds kingdom, phylum, class, order, family, genus, species columns by querying NCBI Protein → Taxonomy.
Usage: ncbi_annotate.py <blast_hits_csv_path> [--email <email>]
"""
import os
import sys
import time
import pandas as pd
import requests
from xml.etree import ElementTree
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm

NCBI_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
NCBI_EPOST  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/epost.fcgi"
NCBI_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"

BATCH_SIZE = 150
MAX_WORKERS = 3  # conservative to respect NCBI rate limits
TIMEOUT = 60

import re

def extract_accession(target_str):
    """Extract clean accession from formats like 'ref|WP_013440946.1|' or plain 'WP_013440946.1'."""
    target_str = target_str.strip()
    # Match patterns like ref|ACC|, gb|ACC|, emb|ACC|, etc.
    m = re.match(r'^[a-z]+\|([^|]+)\|?$', target_str, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    # Already a plain accession
    return target_str


def fetch_taxonomy_batch(acc_list, email="enzymeminer@example.com"):
    """Fetch taxonomy info for a batch of NCBI protein accessions."""
    tax_map = {}
    try:
        # Step 1: efetch protein records to get TaxId
        params = {
            "db": "protein",
            "id": ",".join(acc_list),
            "rettype": "docsum",
            "retmode": "xml",
            "email": email,
            "tool": "enzymeminer-pro",
        }
        resp = requests.get(NCBI_ESUMMARY, params=params, timeout=TIMEOUT)
        if resp.status_code != 200:
            print(f"⚠️ NCBI esummary HTTP {resp.status_code}", file=sys.stderr)
            return tax_map

        root = ElementTree.fromstring(resp.text)
        taxid_to_accs = {}  # taxid -> [acc, ...]
        acc_to_species = {}

        for doc in root.findall(".//DocSum"):
            uid = (doc.findtext("Id") or "").strip()
            acc_val = ""
            taxid = ""
            organism = ""
            for item in doc.findall("Item"):
                name = item.get("Name", "")
                if name == "AccessionVersion":
                    acc_val = (item.text or "").strip()
                elif name == "Caption":
                    if not acc_val:
                        acc_val = (item.text or "").strip()
                elif name == "TaxId":
                    taxid = (item.text or "").strip()
                elif name == "Organism":
                    organism = (item.text or "").strip()
            if acc_val and taxid:
                taxid_to_accs.setdefault(taxid, []).append(acc_val)
                acc_to_species[acc_val] = organism
                # Also index by base accession (without version suffix) for fuzzy matching
                base = acc_val.rsplit(".", 1)[0]
                if base != acc_val:
                    taxid_to_accs[taxid].append(base)
                    acc_to_species[base] = organism

        # Step 2: fetch taxonomy lineage for each unique taxid
        unique_taxids = list(taxid_to_accs.keys())
        if not unique_taxids:
            return tax_map

        tax_params = {
            "db": "taxonomy",
            "id": ",".join(unique_taxids),
            "retmode": "xml",
            "email": email,
            "tool": "enzymeminer-pro",
        }
        tax_resp = requests.get(NCBI_EFETCH, params=tax_params, timeout=TIMEOUT)
        if tax_resp.status_code != 200:
            print(f"⚠️ NCBI taxonomy efetch HTTP {tax_resp.status_code}", file=sys.stderr)
            return tax_map

        tax_root = ElementTree.fromstring(tax_resp.text)
        taxid_info = {}  # taxid -> {kingdom, phylum, class, species}

        for taxon in tax_root.findall(".//Taxon"):
            tid = (taxon.findtext("TaxId") or "").strip()
            sci_name = (taxon.findtext("ScientificName") or "").strip()
            info = {"kingdom": "", "phylum": "", "class": "", "order": "", "family": "", "genus": "", "species": ""}

            lineage_ex = taxon.find("LineageEx")
            if lineage_ex is not None:
                for lt in lineage_ex.findall("Taxon"):
                    rank = (lt.findtext("Rank") or "").lower().strip()
                    name = (lt.findtext("ScientificName") or "").strip()
                    if rank in ("superkingdom", "kingdom", "domain") and not info["kingdom"]:
                        info["kingdom"] = name
                    elif rank == "phylum" and not info["phylum"]:
                        info["phylum"] = name
                    elif rank == "class" and not info["class"]:
                        info["class"] = name
                    elif rank == "order" and not info["order"]:
                        info["order"] = name
                    elif rank == "family" and not info["family"]:
                        info["family"] = name
                    elif rank == "genus" and not info["genus"]:
                        info["genus"] = name

            # The taxon itself might be the species
            taxon_rank = (taxon.findtext("Rank") or "").lower().strip()
            if taxon_rank == "species":
                info["species"] = sci_name
            elif not info["species"]:
                info["species"] = sci_name  # best guess

            taxid_info[tid] = info

        # Map back to accessions
        for tid, accs in taxid_to_accs.items():
            info = taxid_info.get(tid, {})
            for acc in accs:
                entry = dict(info)
                # Prefer Organism field for species if we have it
                if acc in acc_to_species and acc_to_species[acc]:
                    entry["species"] = acc_to_species[acc]
                tax_map[acc] = entry

    except Exception as e:
        print(f"⚠️ batch error: {e}", file=sys.stderr)

    return tax_map


def main():
    if len(sys.argv) < 2:
        print("Usage: ncbi_annotate.py <blast_hits_csv_path> [--email <email>]")
        sys.exit(1)

    csv_path = sys.argv[1]
    email = "enzymeminer@example.com"
    if "--email" in sys.argv:
        idx = sys.argv.index("--email")
        if idx + 1 < len(sys.argv):
            email = sys.argv[idx + 1]

    print(f"🚀 读取 {csv_path}...")
    df = pd.read_csv(csv_path)

    if "target" not in df.columns:
        print("❌ 未找到 target 列。", file=sys.stderr)
        sys.exit(1)

    accessions = df["target"].dropna().astype(str).str.strip().tolist()
    # Build mapping: original target -> clean accession
    target_to_acc = {}
    acc_to_targets = {}  # clean acc -> list of original target strings
    for t in accessions:
        if not t:
            continue
        clean = extract_accession(t)
        target_to_acc[t] = clean
        acc_to_targets.setdefault(clean, []).append(t)

    unique_accs = list(set(target_to_acc.values()))
    print(f"📋 需要查询 {len(unique_accs)} 个唯一蛋白质序列的分类信息")

    batches = [unique_accs[i:i + BATCH_SIZE] for i in range(0, len(unique_accs), BATCH_SIZE)]
    print(f"🚀 分成 {len(batches)} 个批次，开始查询 NCBI...")

    taxonomy_map = {}  # acc -> {kingdom, phylum, class, species}
    failed_count = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_taxonomy_batch, batch, email): i for i, batch in enumerate(batches)}
        for future in tqdm(as_completed(futures), total=len(futures), desc="查询 NCBI 分类信息"):
            try:
                batch_tax = future.result()
                if batch_tax:
                    taxonomy_map.update(batch_tax)
                else:
                    failed_count += 1
            except Exception as e:
                print(f"⚠️ batch exception: {e}", file=sys.stderr)
                failed_count += 1
            # Rate limiting: small delay between results
            time.sleep(0.35)

    print(f"\n✅ 成功获取 {len(taxonomy_map)} 个序列的分类信息")
    if failed_count > 0:
        print(f"⚠️ 失败批次: {failed_count}")

    # Build lookup from original target string -> taxonomy info
    target_taxonomy = {}
    for clean_acc, info in taxonomy_map.items():
        for orig_target in acc_to_targets.get(clean_acc, []):
            target_taxonomy[orig_target] = info

    # Add taxonomy columns to DataFrame
    for col_name in ["kingdom", "phylum", "class", "order", "family", "genus", "species"]:
        tax_series = df["target"].map(
            lambda acc, _key=col_name: target_taxonomy.get(str(acc).strip(), {}).get(_key, "")
        )
        if col_name not in df.columns:
            df[col_name] = ""
        df[col_name] = df[col_name].fillna("").astype(str)
        mask = df[col_name].str.strip() == ""
        df.loc[mask, col_name] = tax_series[mask]

    filled = sum(1 for _, row in df.iterrows() if str(row.get("kingdom", "")).strip())
    print(f"📊 已填充分类信息的行数: {filled}/{len(df)}")
    print(f"💾 保存更新后的文件到: {csv_path}")
    df.to_csv(csv_path, index=False)
    print("✅ 完成。")


if __name__ == "__main__":
    main()
