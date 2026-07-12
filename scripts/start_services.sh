#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
PID_DIR="$PROJECT_DIR/.pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

# ── Ensure Node dependencies are installed ────────────────────────
# After a fresh clone, node_modules/ will be missing (gitignored).
if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
    echo "[setup] node_modules not found – running npm install (this may take a minute) …"
    (cd "$PROJECT_DIR" && npm install --no-fund --no-audit --ignore-optional 2>&1) || {
    echo "[setup] npm install failed. Please run 'npm install' manually in $PROJECT_DIR" >&2
    exit 1
  }
  echo "[setup] npm install complete."
fi

# ── Ensure Python dependencies are installed (for the pipeline) ───
if [[ -f "$PROJECT_DIR/requirements.txt" ]]; then
  local_python="${PIPELINE_PYTHON:-python3}"
  if ! "$local_python" -c "import Bio" >/dev/null 2>&1; then
    echo "[setup] Python Bio package not found – installing from requirements.txt …"
    "$local_python" -m pip install -r "$PROJECT_DIR/requirements.txt" --quiet 2>&1 || {
      echo "[setup] pip install failed. Please run 'pip install -r requirements.txt' manually." >&2
    }
    echo "[setup] pip install complete."
  fi
fi

FRONTEND_PID_FILE="$PID_DIR/frontend.pid"
BACKEND_PID_FILE="$PID_DIR/backend.pid"
FRONTEND_LOG="$LOG_DIR/frontend.log"
BACKEND_LOG="$LOG_DIR/backend.log"

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
  local listener_pid
  listener_pid="$(listener_pid_for_port "$port")"
  [[ -n "$listener_pid" && "$listener_pid" = "$pid" ]]
}

stop_process() {
  local name="$1"
  local pid_file="$2"
  local pid="$3"

  if is_running "$pid"; then
    echo "[$name] restarting stale process (pid=$pid)"
    kill "$pid" 2>/dev/null || true
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file"
}

needs_restart() {
  local pid_file="$1"
  local watch_path="$2"
  [[ -f "$pid_file" && -e "$watch_path" && "$watch_path" -nt "$pid_file" ]]
}

cleanup_untracked_processes() {
  local name="$1"
  local pattern="$2"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "[$name] cleaning untracked process(es) matching: $pattern"
    pkill -f "$pattern" 2>/dev/null || true
  fi
}

start_frontend() {
  local port="3000"
  local old_pid=""

  # Determine how to serve the frontend.
  # Use `npm run dev` (vite dev server) which does NOT require a prior build step.
  # This avoids the "blank page on new machine" issue caused by missing dist/.
  local use_dev_server=true
  local vite_bin="$PROJECT_DIR/node_modules/vite/bin/vite.js"

  # If dist/index.html already exists, prefer preview mode (faster, production-like)
  if [[ -f "$PROJECT_DIR/dist/index.html" ]]; then
    use_dev_server=false
  fi

  if [[ -f "$FRONTEND_PID_FILE" ]]; then
    old_pid="$(cat "$FRONTEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid"; then
      if ! pid_owns_port "$old_pid" "$port"; then
        stop_process "frontend" "$FRONTEND_PID_FILE" "$old_pid"
      elif needs_restart "$FRONTEND_PID_FILE" "$vite_bin"; then
        stop_process "frontend" "$FRONTEND_PID_FILE" "$old_pid"
      else
        echo "[frontend] already running (pid=$old_pid)"
        return
      fi
    fi
  fi

  if [[ -z "$old_pid" ]] || ! is_running "$old_pid"; then
    cleanup_untracked_processes "frontend" "node.*vite.*--port=3000"
  fi

  if [[ -f "$FRONTEND_PID_FILE" ]]; then
    local check_pid
    check_pid="$(cat "$FRONTEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$check_pid"; then
      echo "[frontend] already running (pid=$check_pid)"
      return
    fi
  fi

  echo "[frontend] starting..."
  (
    cd "$PROJECT_DIR"
    if $use_dev_server; then
      echo "[frontend] dist/ not found, using vite dev server (port=$port)"
      nohup node "$vite_bin" --port="$port" --host=0.0.0.0 >"$FRONTEND_LOG" 2>&1 &
    else
      echo "[frontend] using vite preview (port=$port)"
      nohup node "$vite_bin" preview --port="$port" --host=0.0.0.0 >"$FRONTEND_LOG" 2>&1 &
    fi
    echo $! >"$FRONTEND_PID_FILE"
  )
  echo "[frontend] started (pid=$(cat "$FRONTEND_PID_FILE"), log=$FRONTEND_LOG)"
}

start_backend() {
  local watch_path="$PROJECT_DIR/backend/server.mjs"
  local port="8787"
  local old_pid=""

  if [[ -f "$BACKEND_PID_FILE" ]]; then
    old_pid="$(cat "$BACKEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid"; then
      if ! pid_owns_port "$old_pid" "$port"; then
        stop_process "backend" "$BACKEND_PID_FILE" "$old_pid"
      elif needs_restart "$BACKEND_PID_FILE" "$watch_path"; then
        stop_process "backend" "$BACKEND_PID_FILE" "$old_pid"
      else
        echo "[backend] already running (pid=$old_pid)"
        return
      fi
    fi
  fi

  if [[ -z "$old_pid" ]] || ! is_running "$old_pid"; then
    cleanup_untracked_processes "backend" "node backend/server.mjs"
  fi

  if [[ -f "$BACKEND_PID_FILE" ]]; then
    local check_pid
    check_pid="$(cat "$BACKEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$check_pid"; then
      echo "[backend] already running (pid=$check_pid)"
      return
    fi
  fi

  echo "[backend] starting..."
  (
    cd "$PROJECT_DIR"

    # Build the environment for the backend process.
    # If PIPELINE_PYTHON is set, use it; otherwise fall back to python3 on PATH.
    # If a conda mining environment is detected on this machine, auto-activate it.
    local extra_env=()
    if [[ -z "${PIPELINE_PYTHON:-}" ]]; then
      # Auto-detect common conda env locations
      for candidate in \
        "$HOME/miniconda3/envs/mining/bin/python" \
        "$HOME/miniforge3/envs/mining/bin/python" \
        "$HOME/anaconda3/envs/mining/bin/python"; do
        if [[ -x "$candidate" ]]; then
          local candidate_dir
          candidate_dir="$(dirname "$candidate")"
          extra_env+=("PATH=${candidate_dir}:${PATH}" "PIPELINE_PYTHON=$candidate")
          echo "[backend] auto-detected conda python: $candidate"
          break
        fi
      done
    fi

    nohup env "${extra_env[@]+"${extra_env[@]}"}" node --max-old-space-size=4096 backend/server.mjs >"$BACKEND_LOG" 2>&1 &
    echo $! >"$BACKEND_PID_FILE"
  )
  echo "[backend] started (pid=$(cat "$BACKEND_PID_FILE"), log=$BACKEND_LOG)"
}

start_frontend
start_backend

echo ""
echo "All services requested."
echo "Frontend: http://127.0.0.1:3000"
echo "Backend : http://127.0.0.1:8787/api/health"