#!/usr/bin/env bash
set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
TASK_NAME="blast-smoke-$(date +%m%d%H%M)"

auth_args=()
if [[ -n "${API_KEY:-}" ]]; then
  auth_args=(-H "x-api-key: $API_KEY")
fi

post() {
  curl -sS --max-time 600 -X POST "$BASE_URL$1" "${auth_args[@]}" -H 'Content-Type: application/json' -d "$2"
}
get() {
  curl -sS --max-time 30 "$BASE_URL$1" "${auth_args[@]}"
}

echo "=== EnzymeMiner BLAST Smoke Test ==="
echo ""

echo "[0/9] Health..."
HEALTH=$(get "/api/health")
echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Health' if d.get('ok') else 'FAIL | Health')" 2>/dev/null
TASKS_ROOT=$(echo "$HEALTH" | python3 -c "import sys,json,os; d=json.load(sys.stdin); print(os.path.dirname(d.get('workDir','')))" 2>/dev/null)
[[ -n "$TASKS_ROOT" ]] || { echo "FATAL: health response did not include workDir" >&2; exit 1; }

echo "[1/9] Creating task..."
CREATE=$(post "/api/tasks" "{\"name\":\"$TASK_NAME\",\"module\":\"blast\"}")
TASK_ID=$(echo "$CREATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('task',{}).get('id',''))" 2>/dev/null)
echo "  -> Task ID: $TASK_ID"
[ -z "$TASK_ID" ] && echo "FATAL" && exit 1
WORK="$TASKS_ROOT/$TASK_ID"

echo "[2/9] Fetching references (P07003, P0ABI8)..."
REF=$(post "/api/reference/fetch" "{\"taskId\":\"$TASK_ID\",\"email\":\"smoke@test.com\",\"accessionList\":[\"P07003\",\"P0ABI8\"]}")
echo "$REF" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Ref Fetch - rows:', d.get('rows',0))" 2>/dev/null

echo "[3/9] Building local BLAST DB..."
cp "$WORK/ref.fasta" "$WORK/target.fasta"
BUILD=$(post "/api/blast/build-db" "{\"taskId\":\"$TASK_ID\",\"dbSource\":\"local\",\"deduplicateRefs\":true}")
echo "$BUILD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Build DB' if d.get('ok') else 'FAIL | Build DB -', d.get('message',''))" 2>/dev/null

echo "[4/9] Running local BLAST search..."
SEARCH=$(post "/api/blast/search" "{\"taskId\":\"$TASK_ID\",\"dbSource\":\"local\",\"evalue\":\"10\",\"maxTargetSeqs\":100,\"numThreads\":2}")
echo "$SEARCH" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | BLAST Search - hits:', d.get('totalHits', d.get('hitCount','?'))) if d.get('ok') else print('FAIL | BLAST Search -', d.get('message',''), d.get('details','')[:200])" 2>/dev/null

echo "[5/9] Filtering BLAST hits (relaxed)..."
FILTER=$(post "/api/blast/filter" "{\"taskId\":\"$TASK_ID\",\"evalueMax\":100,\"identityMin\":0,\"identityMax\":100,\"queryCovMin\":0,\"subjectLenMin\":0,\"subjectLenMax\":99999}")
echo "$FILTER" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Filter - total:', d.get('total',0), 'kept:', d.get('kept',0)) if d.get('ok') else print('FAIL | Filter -', d.get('message',''))" 2>/dev/null

echo "[6/9] Running NCBI annotation..."
ANNOTATE=$(post "/api/blast/annotate" "{\"taskId\":\"$TASK_ID\",\"email\":\"smoke@test.com\"}")
echo "$ANNOTATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Annotation' if d.get('ok') else 'FAIL | Annotation -', d.get('message',''))" 2>/dev/null

echo "[7/9] Running scoring..."
SCORE=$(post "/api/scoring/run" "{\"taskId\":\"$TASK_ID\",\"autoFromFiltered\":true,\"threshold\":0}")
echo "$SCORE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Scoring - passed:', d.get('passedCount','?')) if d.get('ok') else print('FAIL | Scoring -', d.get('message',''), d.get('details','')[:200])" 2>/dev/null

echo "[8/9] Running CD-HIT clustering..."
CLUSTER=$(post "/api/clustering/run" "{\"taskId\":\"$TASK_ID\",\"identity\":0.85}")
echo "$CLUSTER" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Clustering' if d.get('ok') else 'FAIL | Clustering -', d.get('message',''))" 2>/dev/null

echo "[9/9] Computing pairwise similarity..."
SIMILARITY=$(post "/api/network/compute-similarity" "{\"taskId\":\"$TASK_ID\",\"method\":\"global\"}")
echo "$SIMILARITY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS | Similarity' if d.get('ok') else 'FAIL | Similarity -', d.get('message',''))" 2>/dev/null

echo ""
echo "=== Network Data ==="
NETWORK=$(get "/api/network/data?taskId=$TASK_ID")
echo "$NETWORK" | python3 -c "import sys,json; d=json.load(sys.stdin); nodes=d.get('nodes',[]); edges=d.get('edges',[]); print('Nodes:', len(nodes), 'Edges:', len(edges)); [print(' ', n.get('id','?'), '|', n.get('species','?')) for n in nodes[:5]]" 2>/dev/null

echo ""
echo "=== Key Files ==="
for f in ref.fasta ref.csv blast_hits_all.csv blast_hits_filtered.csv hits_filtered.fasta scored_results.csv scored_passed.fasta candidates.fasta; do
  [ -f "$WORK/$f" ] && echo "  [OK] $f ($(wc -c < "$WORK/$f") bytes)"
done
echo "=== DONE ==="
