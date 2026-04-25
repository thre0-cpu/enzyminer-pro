#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
PID_DIR="$PROJECT_DIR/.pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

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
  local watch_path="$PROJECT_DIR/dist/index.html"
  local port="3000"
  local old_pid=""
  if [[ -f "$FRONTEND_PID_FILE" ]]; then
    old_pid="$(cat "$FRONTEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid"; then
      if ! pid_owns_port "$old_pid" "$port"; then
        stop_process "frontend" "$FRONTEND_PID_FILE" "$old_pid"
      elif needs_restart "$FRONTEND_PID_FILE" "$watch_path"; then
        stop_process "frontend" "$FRONTEND_PID_FILE" "$old_pid"
      else
        echo "[frontend] already running (pid=$old_pid)"
        return
      fi
    fi
  fi

  if [[ -z "$old_pid" ]] || ! is_running "$old_pid"; then
    cleanup_untracked_processes "frontend" "vite preview --port=3000 --host=0.0.0.0"
  fi

  if [[ -f "$FRONTEND_PID_FILE" ]]; then
    local old_pid
    old_pid="$(cat "$FRONTEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid"; then
      echo "[frontend] already running (pid=$old_pid)"
      return
    fi
  fi

  echo "[frontend] starting..."
  (
    cd "$PROJECT_DIR"
    nohup node ./node_modules/vite/bin/vite.js preview --port=3000 --host=0.0.0.0 >"$FRONTEND_LOG" 2>&1 &
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
    local old_pid
    old_pid="$(cat "$BACKEND_PID_FILE" 2>/dev/null || true)"
    if is_running "$old_pid"; then
      echo "[backend] already running (pid=$old_pid)"
      return
    fi
  fi

  echo "[backend] starting..."
  (
    cd "$PROJECT_DIR"
    nohup env "PATH=/home/threo/miniconda3/envs/mining/bin:$PATH" "PIPELINE_PYTHON=/home/threo/miniconda3/envs/mining/bin/python" node backend/server.mjs >"$BACKEND_LOG" 2>&1 &
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
