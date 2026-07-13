#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$PROJECT_DIR/.pids"

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

stop_by_pid_file() {
  local name="$1"
  local pid_file="$2"
  local marker="$3"

  if [[ ! -f "$pid_file" ]]; then
    echo "[$name] pid file not found, skip"
    return
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    if ! pid_is_expected "$pid" "$marker"; then
      echo "[$name] refusing to stop unexpected pid=$pid; removing stale pid file" >&2
      rm -f "$pid_file"
      return
    fi
    echo "[$name] stopping pid=$pid"
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[$name] force killing pid=$pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    echo "[$name] process already not running (pid=$pid)"
  fi

  rm -f "$pid_file"
}

stop_by_pid_file "frontend" "$PID_DIR/frontend.pid" "node_modules/vite/bin/vite.js"
stop_by_pid_file "backend" "$PID_DIR/backend.pid" "backend/server.mjs"

echo "All project-owned services stopped."
