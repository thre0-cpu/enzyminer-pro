#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8787}"
REPORT="${2:-/tmp/enzymeminer_pipeline_smoke_report.md}"

post_json() {
  local url="$1"
  local data="$2"
  curl -sS -X POST "$url" -H 'Content-Type: application/json' -d "$data"
}

write_section() {
  local title="$1"
  local body="$2"
  {
    echo "## $title"
    echo
    echo '```json'
    echo "$body"
    echo '```'
    echo
  } >> "$REPORT"
}

: > "$REPORT"
{
  echo "# EnzymeMiner Pipeline Smoke Report"
  echo
  echo "- Time: $(date -Iseconds)"
  echo "- Base URL: $BASE_URL"
  echo
} >> "$REPORT"

health_json="$(curl -sS "$BASE_URL/api/health")"
write_section "Health" "$health_json"

ref_json="$(post_json "$BASE_URL/api/reference/fetch" '{"email":"your-email@example.com","accessionList":["AAC72747.1"]}')"
write_section "Step1 Reference Fetch" "$ref_json"

hmm_json="$(post_json "$BASE_URL/api/hmm/build" '{}')"
write_section "Step2 HMM Build" "$hmm_json"

search_json="$(post_json "$BASE_URL/api/search/run" '{}')"
write_section "Step3 Search Run" "$search_json"

filter_json="$(post_json "$BASE_URL/api/search/filter" '{"scoreMin":200,"lenMin":520,"lenMax":570}')"
write_section "Step3 Search Filter" "$filter_json"

score_json="$(post_json "$BASE_URL/api/scoring/run" '{}')"
write_section "Step4 Scoring" "$score_json"

cluster_json="$(post_json "$BASE_URL/api/clustering/run" '{}')"
write_section "Step5 Clustering" "$cluster_json"

network_json="$(curl -sS "$BASE_URL/api/network/data")"
write_section "Network" "$network_json"

echo "Smoke report written to: $REPORT"
