#!/bin/bash
# Real-n8n test helper. Starts a THROWAWAY local n8n: its own empty data folder, 127.0.0.1 only, no credentials, no tunnel.
# It never touches another n8n's database. It imports the three workflows (test clock on) and publishes workflows 1 and 2.
#   bash tests/live-n8n.sh up [port]    default port 5678 (refuses to start if something already listens there)
#   bash tests/live-n8n.sh down         stops the n8n that "up" started
# Then:  python3 tests/run_tests.py --live --n8n-url http://127.0.0.1:<port> --n8n-db tests/out/n8n-live/.n8n/database.sqlite
# N8N_BIN = the n8n binary (default ~/Tools/n8n/node_modules/.bin/n8n, n8n 2.44.7). LIVE_DIR = the throwaway data folder.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
N8N_BIN="${N8N_BIN:-$HOME/Tools/n8n/node_modules/.bin/n8n}"
LIVE_DIR="${LIVE_DIR:-$HERE/tests/out/n8n-live}"
PORT="${2:-5678}"
ENVV=(N8N_USER_FOLDER="$LIVE_DIR" N8N_LISTEN_ADDRESS=127.0.0.1 N8N_HOST=127.0.0.1 N8N_PORT="$PORT" N8N_PROTOCOL=http
      N8N_SECURE_COOKIE=false N8N_EDITOR_BASE_URL="http://127.0.0.1:$PORT" WEBHOOK_URL="http://127.0.0.1:$PORT/"
      N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false N8N_PERSONALIZATION_ENABLED=false
      N8N_HIRING_BANNER_ENABLED=false N8N_TEMPLATES_ENABLED=false N8N_ONBOARDING_FLOW_DISABLED=true
      GENERIC_TIMEZONE=UTC TZ=UTC N8N_EXPRESSION_ENGINE=legacy)

case "${1:-}" in
  up)
    if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "something already listens on port $PORT; not touching it. Use: bash tests/live-n8n.sh up <other port>"; exit 1
    fi
    mkdir -p "$LIVE_DIR"
    python3 "$HERE/tests/run_tests.py" --prepare-live || exit 1
    env "${ENVV[@]}" "$N8N_BIN" import:workflow --separate --input="$HERE/tests/out/live-workflows" || exit 1
    # n8n 2.x only calls an error workflow that is published too ("Workflow ... is not active and cannot be executed"), so publish all three.
    for id in hsdErrorAlert01 hsdMissedCall01 hsdCustomerReply01; do env "${ENVV[@]}" "$N8N_BIN" publish:workflow --id="$id" || exit 1; done
    env "${ENVV[@]}" "$N8N_BIN" --version 2>/dev/null | tail -1 > "$LIVE_DIR/n8n.version"
    nohup env "${ENVV[@]}" "$N8N_BIN" start >"$LIVE_DIR/n8n.log" 2>&1 &
    echo $! > "$LIVE_DIR/n8n.pid"
    # "healthz" answers before n8n has registered the webhooks: also wait until both webhook paths are known to n8n
    hook_ready() { local b; b=$(curl -s -m 2 "http://127.0.0.1:$PORT/webhook/$1"); [ -n "$b" ] && ! echo "$b" | grep -q "Cannot GET"; }
    for i in $(seq 1 60); do
      if curl -s -m 2 "http://127.0.0.1:$PORT/healthz" | grep -q ok && hook_ready hsd/missed-call && hook_ready hsd/customer-reply; then
        echo "n8n is up on 127.0.0.1:$PORT with both webhooks registered (pid $(cat "$LIVE_DIR/n8n.pid"))"; exit 0
      fi
      sleep 2
    done
    echo "n8n did not answer within 2 minutes; see $LIVE_DIR/n8n.log"; exit 1;;
  down)
    if [ -f "$LIVE_DIR/n8n.pid" ]; then
      pid=$(cat "$LIVE_DIR/n8n.pid"); pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; sleep 4; rm -f "$LIVE_DIR/n8n.pid"; echo "stopped the throwaway n8n"
    else echo "no throwaway n8n recorded"; fi;;
  *) echo "usage: bash tests/live-n8n.sh up [port] | down"; exit 2;;
esac
