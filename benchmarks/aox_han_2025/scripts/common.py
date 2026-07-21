#!/usr/bin/env python3
"""Shared utilities for the Han 2025 AOX benchmark (stdlib only)."""
from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

BENCHMARK_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = BENCHMARK_ROOT / "data"
RESULTS_ROOT = BENCHMARK_ROOT / "results"


def read_json(path: Path | str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path | str, value: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_tsv(path: Path | str) -> list[dict[str, str]]:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def write_tsv(path: Path | str, rows: Iterable[Mapping[str, Any]], fields: Sequence[str]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(fields), delimiter="\t", extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def read_csv(path: Path | str) -> list[dict[str, str]]:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path | str, rows: Iterable[Mapping[str, Any]], fields: Sequence[str]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(fields), extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def parse_fasta(path: Path | str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    header: str | None = None
    sequence: list[str] = []
    with Path(path).open("r", encoding="utf-8-sig", errors="replace") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    records.append({"id": header.split()[0], "header": header, "sequence": "".join(sequence)})
                header = line[1:].strip()
                sequence = []
            else:
                sequence.append(re.sub(r"\s+", "", line))
    if header is not None:
        records.append({"id": header.split()[0], "header": header, "sequence": "".join(sequence)})
    return records


def fasta_text(records: Iterable[Mapping[str, str]], width: int = 80) -> str:
    chunks: list[str] = []
    for record in records:
        header = str(record.get("header") or record.get("id") or "").strip()
        seq = re.sub(r"[^A-Za-z*]", "", str(record.get("sequence") or "")).upper()
        if not header or not seq:
            continue
        chunks.append(f">{header}")
        chunks.extend(seq[i : i + width] for i in range(0, len(seq), width))
    return "\n".join(chunks) + ("\n" if chunks else "")


def write_fasta(path: Path | str, records: Iterable[Mapping[str, str]]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(fasta_text(records), encoding="utf-8")


def normalize_accession(value: str) -> str:
    """Normalize NCBI/UniProt/HMMER identifiers without erasing version suffixes."""
    token = str(value or "").strip().split()[0]
    if token.startswith(">"):
        token = token[1:]
    if "/" in token:
        token = token.split("/", 1)[0]
    if "|" in token:
        parts = token.split("|")
        if len(parts) >= 2 and parts[1]:
            token = parts[1]
    # UniProt entry names often append _SPECIES to the accession.
    if re.match(r"^(?:[A-NR-Z][0-9][A-Z0-9]{3}[0-9]|[A-Z0-9]{10})_[A-Z0-9]+$", token):
        token = token.split("_", 1)[0]
    return token


def accession_aliases(value: str) -> set[str]:
    raw = str(value or "").strip().split()[0]
    aliases = {raw, normalize_accession(raw)}
    if "|" in raw:
        aliases.update(part for part in raw.split("|") if part)
    if "/" in raw:
        aliases.add(raw.split("/", 1)[0])
    return {x for x in aliases if x}


def sha256_file(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def copy_file(src: Path | str, dst: Path | str) -> Path:
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return dst


def finite_float(value: Any, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


class ApiError(RuntimeError):
    pass


class ApiClient:
    def __init__(self, base_url: str, api_key: str = "", timeout: float = 7200.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def request(
        self,
        method: str,
        route: str,
        *,
        task_id: str | None = None,
        body: Mapping[str, Any] | None = None,
        query: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        params = {str(k): str(v) for k, v in (query or {}).items() if v is not None}
        if task_id:
            params["taskId"] = task_id
        url = f"{self.base_url}{route}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if self.api_key:
            headers["x-api-key"] = self.api_key
        request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw)
                detail = payload.get("details") or payload.get("message") or raw
            except json.JSONDecodeError:
                detail = raw
            raise ApiError(f"{method} {route} -> HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ApiError(f"Cannot reach {url}: {exc}") from exc
        if not payload.get("ok", False):
            raise ApiError(f"{method} {route}: {payload.get('details') or payload.get('message') or payload}")
        return payload

    def get(self, route: str, **kwargs: Any) -> dict[str, Any]:
        return self.request("GET", route, **kwargs)

    def post(self, route: str, **kwargs: Any) -> dict[str, Any]:
        return self.request("POST", route, **kwargs)


def create_task(client: ApiClient, prefix: str, module: str = "hmmer") -> dict[str, Any]:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    task_id = f"{prefix}-{stamp}-{os.getpid()}"
    result = client.post("/api/tasks", body={"taskId": task_id, "name": task_id, "module": module})
    return result["task"]


def stage_task_file(work_dir: Path | str, source: Path | str, name: str) -> Path:
    return copy_file(source, Path(work_dir) / name)


def save_api_payload(run_dir: Path, name: str, payload: Mapping[str, Any]) -> None:
    write_json(run_dir / "api" / f"{name}.json", payload)
