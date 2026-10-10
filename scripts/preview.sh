#!/usr/bin/env bash
# Start (or restart) the demo preview server for the screenshot harness.
#
# Keeps a pidfile so stopping it never relies on pkill pattern-matching, which
# happily matches the shell running the pkill.
#
#   ./scripts/preview.sh start|restart|stop [--stubs]
#
# --stubs also launches stand-ins for Deepgram's speech and agent endpoints
# and points the proxy at them, so the whole chain can be exercised without an
# API key. (--stub-tts is accepted as the old name for the same thing.)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${TMPDIR:-/tmp}/orb-preview.pid"
STUB_PIDFILE="${TMPDIR:-/tmp}/orb-stub-tts.pid"
AGENT_PIDFILE="${TMPDIR:-/tmp}/orb-stub-agent.pid"
LOG="${TMPDIR:-/tmp}/orb-preview.log"
STUB_LOG="${TMPDIR:-/tmp}/orb-stub-tts.log"
AGENT_LOG="${TMPDIR:-/tmp}/orb-stub-agent.log"
STUB_PORT=8787
AGENT_PORT=8788

ACTION="${1:-start}"
USE_STUB=0
for arg in "$@"; do
  [[ "$arg" == "--stubs" || "$arg" == "--stub-tts" ]] && USE_STUB=1
done

stop_one() {
  if [[ -f "$1" ]]; then
    kill "$(cat "$1")" 2>/dev/null || true
    rm -f "$1"
  fi
}

# Belt and braces. `npx` spawns the real binary as a grandchild, so a pidfile
# holding the npx pid leaves the server running and holding the port, and the
# next start silently fails to bind while the old build keeps answering. This
# script now launches the binary directly, but a sweep still catches anything
# orphaned by an earlier version of it.
sweep_orphans() {
  local pattern="$1"
  local pids
  pids="$(ps -eo pid,args | grep -F "$pattern" | grep -v grep | awk '{print $1}' || true)"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
}

stop() {
  stop_one "$PIDFILE"
  stop_one "$STUB_PIDFILE"
  stop_one "$AGENT_PIDFILE"
  sweep_orphans "vite preview --port 4173"
  sweep_orphans "scripts/stub-tts.mjs"
  sweep_orphans "scripts/stub-agent.mjs"
  # Give the port a moment to be released before anything tries to bind it.
  sleep 0.4
}

case "$ACTION" in
  stop) stop; echo "preview stopped" ;;
  start|restart)
    stop
    if [[ "$USE_STUB" == "1" ]]; then
      nohup node "$ROOT/scripts/stub-tts.mjs" "$STUB_PORT" > "$STUB_LOG" 2>&1 &
      echo $! > "$STUB_PIDFILE"
      nohup node "$ROOT/scripts/stub-agent.mjs" "$AGENT_PORT" > "$AGENT_LOG" 2>&1 &
      echo $! > "$AGENT_PIDFILE"
      export DEEPGRAM_API_KEY="stub-key-not-a-real-credential"
      export DEEPGRAM_BASE_URL="http://127.0.0.1:${STUB_PORT}"
      echo "stub Deepgram speech on :${STUB_PORT}, agent on :${AGENT_PORT}"
    fi

    cd "$ROOT/apps/demo"
    nohup "$ROOT/node_modules/.bin/vite" preview --port 4173 --host 127.0.0.1 > "$LOG" 2>&1 &
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
  *) echo "usage: preview.sh [start|restart|stop] [--stubs]" >&2; exit 2 ;;
esac
