#!/usr/bin/env python3
import sys
import pandas as pd
import requests
from io import StringIO
from Bio import SeqIO
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm

def normalize_accession(value):
    if pd.isna(value):
        return ""
    accession = str(value).strip()
    if not accession or accession.lower() in {"nan", "none", "null"}:
        return ""
    return accession


def fetch_uniprot_batch(acc_list):
    query = " OR ".join([f"accession:{acc}" for acc in acc_list])
    url = "https://rest.uniprot.org/uniprotkb/search"
    
    length_dict = {}
    taxonomy_dict = {}  # acc -> {kingdom, phylum, class, species}
    alias_to_primary = {}
    try:
        params = {"query": query, "fields": "accession,length,organism_name,lineage", "format": "json", "size": 500}
        response = requests.get(url, params=params, timeout=60)
        response.raise_for_status()
        for r in response.json().get("results", []):
            acc = r.get("primaryAccession")
            aliases = {acc} if acc else set()
            aliases.update(r.get("secondaryAccessions") or [])
            for requested in acc_list:
                if requested in aliases or (acc and requested.split("-", 1)[0] == acc):
                    aliases.add(requested)
            for alias in aliases:
                if alias and acc:
                    alias_to_primary[alias] = acc
            length = None
            if "sequence" in r and isinstance(r["sequence"], dict):
                length = r["sequence"].get("length")
            elif "length" in r:
                length = r["length"]
            if acc and length:
                for alias in aliases:
                    if alias:
                        length_dict[alias] = length

            # Extract taxonomy from lineages (has rank labels)
            if acc:
                tax = {}
                lineages = r.get("lineages", [])
                # Fallback: some API responses use organism.lineage (plain list)
                if not lineages:
                    org = r.get("organism", {})
                    if isinstance(org, dict):
                        plain_lineage = org.get("lineage", [])
                        if plain_lineage and isinstance(plain_lineage, list) and isinstance(plain_lineage[0], str):
                            if len(plain_lineage) > 0:
                                tax["kingdom"] = plain_lineage[0]
                            if len(plain_lineage) > 2:
                                tax["phylum"] = plain_lineage[2]
                            if len(plain_lineage) > 3:
                                tax["class"] = plain_lineage[3]
                        if org.get("scientificName"):
                            tax.setdefault("species", org["scientificName"])
                for ln in lineages:
                    rank = (ln.get("rank") or "").lower().strip()
                    name = (ln.get("scientificName") or "").strip()
                    if rank in ("kingdom", "superkingdom", "domain") and "kingdom" not in tax:
                        tax["kingdom"] = name
                    elif rank == "phylum" and "phylum" not in tax:
                        tax["phylum"] = name
                    elif rank == "class" and "class" not in tax:
                        tax["class"] = name
                    elif rank == "order" and "order" not in tax:
                        tax["order"] = name
                    elif rank == "family" and "family" not in tax:
                        tax["family"] = name
                    elif rank == "genus" and "genus" not in tax:
                        tax["genus"] = name
                    elif rank == "species" and "species" not in tax:
                        tax["species"] = name
                # Fallback: organism.scientificName for species
                if "species" not in tax:
                    org = r.get("organism", {})
                    if isinstance(org, dict) and org.get("scientificName"):
                        tax["species"] = org["scientificName"]
                for alias in aliases:
                    if alias:
                        taxonomy_dict[alias] = tax
    except Exception as e:
        print(f"JSON api error: {e}", file=sys.stderr)
        pass
    
    records = []
    try:
        params = {"query": query, "format": "fasta", "size": 500}
        response = requests.get(url, params=params, timeout=120)
        response.raise_for_status()
        if response.text.strip():
            records = list(SeqIO.parse(StringIO(response.text), "fasta"))
    except Exception as e:
        print(f"FASTA api error: {e}", file=sys.stderr)
        pass
    
    return length_dict, records, taxonomy_dict, alias_to_primary

def main():
    if len(sys.argv) < 2:
        print("Usage: uniprot_fill.py <hits_csv_path>")
        sys.exit(1)
        
    csv_path = sys.argv[1]
    print(f"🚀 读取 {csv_path}...")
    df = pd.read_csv(csv_path)
    
    # Check if we have uniprot_accession column
    if "uniprot_accession" not in df.columns:
        print("❌ 未找到 uniprot_accession 列。")
        sys.exit(1)
        
    accessions = [normalize_accession(value) for value in df["uniprot_accession"].tolist()]
    unique_accessions = sorted(set(accession for accession in accessions if accession))
    print(f"📋 需要查询 {len(unique_accessions)} 个唯一序列")
    
    batch_size = 100
    length_map = {}
    all_seq_records = []

    batches = [unique_accessions[i:i + batch_size] for i in range(0, len(unique_accessions), batch_size)]
    print(f"🚀 分成 {len(batches)} 个批次，开始并发查询...")

    failed_count = 0
    taxonomy_map = {}  # acc -> {kingdom, phylum, class, species}
    alias_to_primary = {}
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(fetch_uniprot_batch, batch): i for i, batch in enumerate(batches)}
        for future in tqdm(as_completed(futures), total=len(futures), desc="并发查询 UniProt"):
            batch_lengths, batch_records, batch_taxonomy, batch_aliases = future.result()
            if batch_lengths:
                length_map.update(batch_lengths)
            if batch_records:
                all_seq_records.extend(batch_records)
            else:
                failed_count += 1
            if batch_taxonomy:
                taxonomy_map.update(batch_taxonomy)
            if batch_aliases:
                alias_to_primary.update(batch_aliases)

    print(f"\n✅ 成功获取 {len(length_map)} 个序列的长度")
    print(f"✅ 成功下载 {len(all_seq_records)} 条FASTA序列")
    print(f"✅ 成功获取 {len(taxonomy_map)} 个序列的分类信息")
    if failed_count > 0:
        print(f"⚠️ 失败批次: {failed_count}")

    target_dict = {}
    for rec in all_seq_records:
        parts = rec.id.split("|")
        if len(parts) >= 2:
            acc = parts[1]
        else:
            acc = rec.id.split()[0]
        target_dict[acc] = rec
        
    sequence_map = {acc: str(rec.seq) for acc, rec in target_dict.items()}
    for alias, primary in alias_to_primary.items():
        if primary in sequence_map:
            sequence_map[alias] = sequence_map[primary]

    normalized_accessions = df["uniprot_accession"].map(normalize_accession)

    # Update df. Keep sequences already supplied by the EBI fullfasta download
    # whenever UniProt has no corresponding record.
    if "length" not in df.columns:
        df["length"] = ""
    if "sequence" not in df.columns:
        df["sequence"] = ""
    df["length"] = normalized_accessions.map(length_map).fillna(df["length"])
    df["sequence"] = normalized_accessions.map(sequence_map).fillna(df["sequence"])

    # Update taxonomy columns (only fill empty/missing values)
    for col_name, tax_key in [("kingdom", "kingdom"), ("phylum", "phylum"), ("class", "class"), ("order", "order"), ("family", "family"), ("genus", "genus"), ("species", "species")]:
        tax_series = normalized_accessions.map(
            lambda acc, _key=tax_key: taxonomy_map.get(acc, {}).get(_key, "")
        )
        if col_name not in df.columns:
            df[col_name] = ""
        df[col_name] = df[col_name].fillna("").astype(str)
        mask = df[col_name].str.strip() == ""
        df.loc[mask, col_name] = tax_series[mask]

    print(f"保存更新后的文件到: {csv_path}")
    df.to_csv(csv_path, index=False)
    print("✅ 完成。")

if __name__ == "__main__":
    main()
