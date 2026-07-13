#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
PID_DIR="$PROJECT_DIR/.pids"
FRONTEND_PID_FILE="$PID_DIR/frontend.pid"
BACKEND_PID_FILE="$PID_DIR/backend.pid"
FRONTEND_LOG="$LOG_DIR/frontend.log"
BACKEND_LOG="$LOG_DIR/backend.log"

mkdir -p "$LOG_DIR" "$PID_DIR"

# ── Ensure Node dependencies are installed ────────────────────────
if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
  echo "[setup] node_modules not found – running npm install (this may take a minute) …"
  (cd "$PROJECT_DIR" && npm install --no-fund --no-audit --ignore-optional) || {
    echo "[setup] npm install failed. Please run 'npm install' manually in $PROJECT_DIR" >&2
    exit 1
  }
  echo "[setup] npm install complete."
fi

# Load .env without evaluating it as shell code. Existing exported variables
# take precedence, matching dotenv's default behaviour.
if [[ -f "$PROJECT_DIR/.env" ]]; then
  while IFS= read -r -d '' assignment; do
    export "$assignment"
  done < <(PROJECT_DIR="$PROJECT_DIR" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const parsed = dotenv.parse(fs.readFileSync(path.join(process.env.PROJECT_DIR, '.env')));
for (const [key, value] of Object.entries(parsed)) {
  if (process.env[key] === undefined) process.stdout.write(`${key}=${value}\0`);
}
NODE
  )
  echo "[setup] loaded $PROJECT_DIR/.env"
fi

python_deps_ok() {
  "$1" -c 'import pandas, Bio, requests, tqdm' >/dev/null 2>&1
}

resolve_python() {
  local requested="${PIPELINE_PYTHON:-}"
  local candidate

  if [[ -n "$requested" ]]; then
    candidate="$(command -v "$requested" 2>/dev/null || true)"
    if [[ -z "$candidate" && -x "$requested" ]]; then
      candidate="$requested"
    fi
    if [[ -z "$candidate" ]]; then
      echo "[setup] PIPELINE_PYTHON is not executable: $requested" >&2
      return 1
    fi
    printf '%s\n' "$candidate"
    return
  fi

  # Prefer a ready-to-use mining environment before the system Python.
  for candidate in \
    "$HOME/miniconda3/envs/mining/bin/python" \
    "$HOME/miniforge3/envs/mining/bin/python" \
    "$HOME/anaconda3/envs/mining/bin/python" \
    "$(command -v python3 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]] && python_deps_ok "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  candidate="$(command -v python3 2>/dev/null || true)"
  if [[ -z "$candidate" ]]; then
    echo "[setup] python3 was not found" >&2
    return 1
  fi
  printf '%s\n' "$candidate"
}

PIPELINE_PYTHON="$(resolve_python)"
export PIPELINE_PYTHON
export PATH="$(dirname "$PIPELINE_PYTHON"):$PATH"
echo "[setup] pipeline Python: $PIPELINE_PYTHON"

# ── Ensure Python dependencies are installed ──────────────────────
if [[ -f "$PROJECT_DIR/requirements.txt" ]] && ! python_deps_ok "$PIPELINE_PYTHON"; then
  echo "[setup] Python dependencies not found – installing requirements.txt …"
  if ! "$PIPELINE_PYTHON" -m pip install -r "$PROJECT_DIR/requirements.txt" --quiet; then
    echo "[setup] pip install failed. Run '$PIPELINE_PYTHON -m pip install -r $PROJECT_DIR/requirements.txt' manually." >&2
    exit 1
  fi
  if ! python_deps_ok "$PIPELINE_PYTHON"; then
    echo "[setup] pip completed but required imports still fail (pandas, Bio, requests, tqdm)." >&2
    exit 1
  fi
  echo "[setup] pip install complete."
fi

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

listener_pid_for_port() {
  local port="$1"
  ss -ltnp "( sport = :$port )" 2>/dev/null \
    | awk 'NR>1 { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART + 4, RLENGTH - 4); exit } }'
}

pid_owns_port() {
  local pid="$1"
  local port="$2"
  [[ "$(listener_pid_for_port "$port")" == "$pid" ]]
}

pid_is_expected() {
  local pid="$1"
  local marker="$2"
  local cwd=""
  local command_line=""
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cwd" == "$PROJECT_DIR" && "$command_line" == *"$marker"* ]]
}

stop_expected_process() {
  local name="$1"
  local pid_file="$2"
  local pid="$3"
  local marker="$4"

  if is_running "$pid"; then
    if ! pid_is_expected "$pid" "$marker"; then
      echo "[$name] refusing to stop unexpected pid=$pid; removing stale pid file" >&2
      rm -f "$pid_file"
      return 1
    fi
    echo "[$name] stopping pid=$pid"
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      is_running "$pid" || break
      sleep 0.1
    done
    if is_running "$pid"; then
      echo "[$name] force killing pid=$pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file"
}

ensure_port_available() {
  local name="$1"
  local port="$2"
  local marker="$3"
  local listener
  listener="$(listener_pid_for_port "$port")"
  [[ -z "$listener" ]] && return 0

  if pid_is_expected "$listener" "$marker"; then
    echo "[$name] stopping untracked project process on port $port (pid=$listener)"
    kill "$listener" 2>/dev/null || true
    for _ in {1..20}; do
      is_running "$listener" || break
      sleep 0.1
    done
    is_running "$listener" && kill -9 "$listener" 2>/dev/null || true
    return 0
  fi

  echo "[$name] port $port is occupied by unrelated pid=$listener; refusing to kill it." >&2
  return 1
}

frontend_sources_changed() {
  local since_file="$1"
  find "$PROJECT_DIR/src" "$PROJECT_DIR/index.html" "$PROJECT_DIR/vite.config.ts" \
    "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" \
    -type f -newer "$since_file" -print -quit 2>/dev/null | grep -q .
}

start_frontend() {
  local port="3000"
  local frontend_host="${FRONTEND_HOST:-127.0.0.1}"
  local frontend_mode="${FRONTEND_MODE:-dev}"
  local vite_bin="$PROJECT_DIR/node_modules/vite/bin/vite.js"
  local marker="node_modules/vite/bin/vite.js"
  local old_pid=""

  if [[ "$frontend_mode" != "dev" && "$frontend_mode" != "preview" ]]; then
    echo "[frontend] FRONTEND_MODE must be 'dev' or 'preview'" >&2
    return 1
  fi

  if [[ -f "$FRONTEND_PID_FILE" ]]; then
    old_pid="$(cat "$FRONTEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid" && pid_is_expected "$old_pid" "$marker" && pid_owns_port "$old_pid" "$port"; then
      if [[ "$frontend_mode" == "preview" ]] && frontend_sources_changed "$FRONTEND_PID_FILE"; then
        stop_expected_process "frontend" "$FRONTEND_PID_FILE" "$old_pid" "$marker"
      else
        echo "[frontend] already running (pid=$old_pid)"
        return
      fi
    else
      rm -f "$FRONTEND_PID_FILE"
    fi
  fi

  ensure_port_available "frontend" "$port" "$marker"

  if [[ "$frontend_mode" == "preview" ]]; then
    echo "[frontend] building a fresh production bundle..."
    (cd "$PROJECT_DIR" && npm run build)
  fi

  echo "[frontend] starting in $frontend_mode mode..."
  (
    cd "$PROJECT_DIR"
    if [[ "$frontend_mode" == "preview" ]]; then
      nohup node "$vite_bin" preview --port="$port" --host="$frontend_host" >"$FRONTEND_LOG" 2>&1 &
    else
      nohup node "$vite_bin" --port="$port" --host="$frontend_host" >"$FRONTEND_LOG" 2>&1 &
    fi
    echo $! >"$FRONTEND_PID_FILE"
  )
  echo "[frontend] started (pid=$(cat "$FRONTEND_PID_FILE"), log=$FRONTEND_LOG)"
}

start_backend() {
  local port="${API_PORT:-8787}"
  local marker="backend/server.mjs"
  local old_pid=""

  if [[ -f "$BACKEND_PID_FILE" ]]; then
    old_pid="$(cat "$BACKEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid" && pid_is_expected "$old_pid" "$marker" && pid_owns_port "$old_pid" "$port"; then
      if [[ "$PROJECT_DIR/backend/server.mjs" -nt "$BACKEND_PID_FILE" ]]; then
        stop_expected_process "backend" "$BACKEND_PID_FILE" "$old_pid" "$marker"
      else
        echo "[backend] already running (pid=$old_pid)"
        return
      fi
    else
      rm -f "$BACKEND_PID_FILE"
    fi
  fi

  ensure_port_available "backend" "$port" "$marker"

  echo "[backend] starting..."
  (
    cd "$PROJECT_DIR"
    nohup node --max-old-space-size=4096 backend/server.mjs >"$BACKEND_LOG" 2>&1 &
    echo $! >"$BACKEND_PID_FILE"
  )
  echo "[backend] started (pid=$(cat "$BACKEND_PID_FILE"), log=$BACKEND_LOG)"
}

start_frontend
start_backend

echo ""
echo "All services requested."
echo "Frontend: http://${FRONTEND_HOST:-127.0.0.1}:3000"
echo "Backend : http://${API_HOST:-127.0.0.1}:${API_PORT:-8787}/api/health"
