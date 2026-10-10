#!/usr/bin/env bash
# Start (or restart) the demo preview server in the background for the
# screenshot harness. Keeps a pidfile so stopping it never relies on pkill
# pattern-matching, which happily matches the shell running the pkill.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${TMPDIR:-/tmp}/orb-preview.pid"
LOG="${TMPDIR:-/tmp}/orb-preview.log"

stop() {
  if [[ -f "$PIDFILE" ]]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

case "${1:-start}" in
  stop) stop; echo "preview stopped" ;;
  start|restart)
    stop
    cd "$ROOT/apps/demo"
    nohup npx vite preview --port 4173 --host 127.0.0.1 > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 40); do
      if curl -sS -o /dev/null http://127.0.0.1:4173/ 2>/dev/null; then
        echo "preview up at http://127.0.0.1:4173 (pid $(cat "$PIDFILE"))"
        exit 0
      fi
      sleep 0.25
    done
    echo "preview failed to start; log:" >&2
    tail -20 "$LOG" >&2
    exit 1 ;;
  *) echo "usage: preview.sh [start|restart|stop]" >&2; exit 2 ;;
esac
