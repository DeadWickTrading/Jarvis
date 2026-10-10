#!/usr/bin/env bash
# Start (or restart) the demo preview server for the screenshot harness.
#
# Keeps a pidfile so stopping it never relies on pkill pattern-matching, which
# happily matches the shell running the pkill.
#
#   ./scripts/preview.sh start|restart|stop [--stub-tts]
#
# --stub-tts also launches a stand-in for Deepgram and points the speech proxy
# at it, so the whole speech chain can be exercised without an API key.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${TMPDIR:-/tmp}/orb-preview.pid"
STUB_PIDFILE="${TMPDIR:-/tmp}/orb-stub-tts.pid"
LOG="${TMPDIR:-/tmp}/orb-preview.log"
STUB_LOG="${TMPDIR:-/tmp}/orb-stub-tts.log"
STUB_PORT=8787

ACTION="${1:-start}"
USE_STUB=0
for arg in "$@"; do
  [[ "$arg" == "--stub-tts" ]] && USE_STUB=1
done

stop_one() {
  if [[ -f "$1" ]]; then
    kill "$(cat "$1")" 2>/dev/null || true
    rm -f "$1"
  fi
}

stop() {
  stop_one "$PIDFILE"
  stop_one "$STUB_PIDFILE"
}

case "$ACTION" in
  stop) stop; echo "preview stopped" ;;
  start|restart)
    stop
    if [[ "$USE_STUB" == "1" ]]; then
      nohup node "$ROOT/scripts/stub-tts.mjs" "$STUB_PORT" > "$STUB_LOG" 2>&1 &
      echo $! > "$STUB_PIDFILE"
      export DEEPGRAM_API_KEY="stub-key-not-a-real-credential"
      export DEEPGRAM_BASE_URL="http://127.0.0.1:${STUB_PORT}"
      echo "stub Deepgram on :${STUB_PORT} (pid $(cat "$STUB_PIDFILE"))"
    fi

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
  *) echo "usage: preview.sh [start|restart|stop] [--stub-tts]" >&2; exit 2 ;;
esac
