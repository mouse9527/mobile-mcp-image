#!/bin/bash
# Runs smoke/lease_test.py against gateway.js + a fake mobile-mcp, all local: no docker, no phone.
# usage: smoke/run_lease_local.sh   (needs node and python3; ports LEASE_PORT / FAKE_UPSTREAM_PORT, default 18931 / 18932)
set -euo pipefail
cd "$(dirname "$0")/.."
GW_PORT="${LEASE_PORT:-18931}"; UP_PORT="${FAKE_UPSTREAM_PORT:-18932}"
pids=()
cleanup() { for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

FAKE_UPSTREAM_PORT="$UP_PORT" node smoke/fake_upstream.js & pids+=($!)
LEASE_PORT="$GW_PORT" LEASE_HOST=127.0.0.1 LEASE_UPSTREAM="http://127.0.0.1:${UP_PORT}/mcp" \
  LEASE_IDLE_S=3 LEASE_WAIT_S=2 LEASE_TICKET_S=4 LEASE_GRACE_S=3 LEASE_SESSION_FIRST_IDLE_S=1 LEASE_HOLD_MAX_S=8 \
  node gateway.js 2>/dev/null & pids+=($!)
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:${GW_PORT}/mcp" && break
  sleep 0.2
done
python3 -I smoke/lease_test.py "http://127.0.0.1:${GW_PORT}/mcp"
