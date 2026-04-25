#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.pids"

FRONTEND_PID_FILE="$PID_DIR/frontend.pid"
BACKEND_PID_FILE="$PID_DIR/backend.pid"

stop_by_pid_file() {
  local name="$1"
  local pid_file="$2"

  if [[ ! -f "$pid_file" ]]; then
    echo "[$name] pid file not found, skip"
    return
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    echo "[$name] pid file empty, remove"
    rm -f "$pid_file"
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "[$name] stopping pid=$pid"
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      echo "[$name] force kill pid=$pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    echo "[$name] process already not running (pid=$pid)"
  fi

  rm -f "$pid_file"
}

stop_by_pid_file "frontend" "$FRONTEND_PID_FILE"
stop_by_pid_file "backend" "$BACKEND_PID_FILE"

# fallback: kill by command signature in case pid files are stale
pkill -f "vite --port=3000 --host=0.0.0.0" 2>/dev/null || true
pkill -f "node backend/server.mjs" 2>/dev/null || true

echo "All stop commands issued."
