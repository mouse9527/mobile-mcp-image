#!/bin/bash
# smoke.sh <image>: no phone needed. Checks auth, tool list, adb version, uid, no shell, telemetry env.
set -euo pipefail
IMG="$1"; NAME="mobile-mcp-smoke-$$"; PORT="${SMOKE_PORT:-18931}"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { echo "SMOKE FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }

# refuses to start without a token: must exit non-zero within 20 s
docker run -d --name "$NAME-noauth" "$IMG" >/dev/null
trap 'cleanup; docker rm -f "$NAME-noauth" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME-noauth")" = false ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$NAME-noauth")" = false ] || fail "still running without MOBILEMCP_AUTH"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME-noauth")" != 0 ] || fail "exited 0 without MOBILEMCP_AUTH"
docker rm -f "$NAME-noauth" >/dev/null
echo "ok: refuses to start without MOBILEMCP_AUTH"

# both set: ambiguous, must refuse
docker run -d --name "$NAME-both" -e MOBILEMCP_AUTH=x -e MOBILEMCP_AUTH_DISABLED=1 "$IMG" >/dev/null
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME-both")" = false ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$NAME-both")" = false ] || fail "still running with both auth settings"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$NAME-both")" != 0 ] || fail "exited 0 with both auth settings"
docker rm -f "$NAME-both" >/dev/null
echo "ok: refuses MOBILEMCP_AUTH together with MOBILEMCP_AUTH_DISABLED"

# explicitly disabled: serves without a token
DPORT=$((PORT + 1))
docker run -d --name "$NAME-open" -p "127.0.0.1:${DPORT}:8931" -e MOBILEMCP_AUTH_DISABLED=1 "$IMG" >/dev/null
trap 'cleanup; docker rm -f "$NAME-noauth" "$NAME-open" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  docker logs "$NAME-open" 2>&1 | grep -q "streamable http server listening" && break
  sleep 1
done
docker logs "$NAME-open" 2>&1 | grep -q "streamable http server listening" || fail "auth-disabled server did not start"
n=$(curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "http://127.0.0.1:${DPORT}/mcp" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | sed -n 's/^data: //p' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))')
[ "$n" = 33 ] || fail "auth disabled: expected 33 tools without token, got $n"
docker rm -f "$NAME-open" >/dev/null
echo "ok: MOBILEMCP_AUTH_DISABLED=1 serves without token"

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8931" -e MOBILEMCP_AUTH=smoke "$IMG" >/dev/null
for _ in $(seq 1 60); do
  docker logs "$NAME" 2>&1 | grep -q "streamable http server listening" && break
  sleep 1
done
docker logs "$NAME" 2>&1 | grep -q "streamable http server listening" || fail "server did not start"

URL="http://127.0.0.1:${PORT}/mcp"
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${H[@]}" "$URL" -d '{}')
[ "$code" = 401 ] || fail "expected 401 without token, got $code"
echo "ok: 401 without token"

n=$(curl -s "${H[@]}" -H 'Authorization: Bearer smoke' "$URL" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | sed -n 's/^data: //p' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))')
[ "$n" = 33 ] || fail "expected 33 tools, got $n"
echo "ok: tools/list = $n"

v=$(docker exec "$NAME" /opt/platform-tools/adb version | sed -n 's/^Version \([0-9]*\)\..*/\1/p')
[ -n "$v" ] && [ "$v" -ge 37 ] || fail "adb major version '$v' < 37"
echo "ok: adb major version $v"

u=$(docker exec "$NAME" /nodejs/bin/node -e 'process.stdout.write(String(process.getuid()))')
[ "$u" = 1000 ] || fail "uid $u != 1000"
echo "ok: uid 1000"

if docker exec "$NAME" /bin/sh -c true >/dev/null 2>&1; then fail "/bin/sh exists"; fi
echo "ok: no shell"

docker exec "$NAME" /nodejs/bin/node -e 'process.exit(process.env.MOBILEMCP_DISABLE_TELEMETRY==="1"?0:1)' || fail "telemetry not disabled"
echo "ok: telemetry disabled"
# lease gateway (PHONE_LEASE=1, k8s#87): one holder at a time across MCP sessions; short timings for the test
LPORT=$((PORT + 2))
docker run -d --name "$NAME-lease" -p "127.0.0.1:${LPORT}:8931" -e MOBILEMCP_AUTH_DISABLED=1 -e PHONE_LEASE=1 \
  -e LEASE_IDLE_S=3 -e LEASE_WAIT_S=2 -e LEASE_TICKET_S=4 -e LEASE_GRACE_S=3 -e LEASE_SESSION_FIRST_IDLE_S=1 -e LEASE_HOLD_MAX_S=8 \
  "$IMG" >/dev/null
trap 'cleanup; docker rm -f "$NAME-noauth" "$NAME-open" "$NAME-lease" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  docker logs "$NAME-lease" 2>&1 | grep "streamable http server listening" >/dev/null && break
  sleep 1
done
docker logs "$NAME-lease" 2>&1 | grep '"event":"listening"' >/dev/null || fail "lease gateway did not start"
python3 "$(dirname "$0")/smoke/lease_test.py" "http://127.0.0.1:${LPORT}/mcp" || { docker logs "$NAME-lease" 2>&1 | tail -20 >&2; fail "lease"; }
# the log has holder hashes only: no raw holder ids from the test
if docker logs "$NAME-lease" 2>&1 | grep -E 'chat-1|cs-1|"holder":"[^h]' >/dev/null; then fail "raw holder id in the lease log"; fi
docker rm -f "$NAME-lease" >/dev/null
echo "ok: lease gateway (PHONE_LEASE=1)"

# screen helpers (PHONE_WAKE / ELEMENTS_TRIM): trimming unit test, then waking with a stand-in adb (no phone)
node "$(dirname "$0")/smoke/screen_test.js" || fail "element trimming"
WPORT=$((PORT + 3)); WDIR=$(mktemp -d); chmod 777 "$WDIR"
wake_run() { # wake_run <state json>: one list_elements call through the gateway with PHONE_WAKE=1; prints the tool text
  echo "$1" > "$WDIR/phone.json"; chmod 666 "$WDIR/phone.json"
  docker rm -f "$NAME-wake" >/dev/null 2>&1 || true
  docker run -d --name "$NAME-wake" -p "127.0.0.1:${WPORT}:8931" -e MOBILEMCP_AUTH_DISABLED=1 -e PHONE_LEASE=1 -e PHONE_WAKE=1 \
    -e ELEMENTS_TRIM=1 -e WAKE_ADB=/smoke/fake_adb.js -e FAKE_PHONE_STATE=/state/phone.json -e WAKE_SETTLE_MS=50 \
    -v "$(cd "$(dirname "$0")" && pwd)/smoke:/smoke:ro" -v "$WDIR:/state" "$IMG" >/dev/null
  for _ in $(seq 1 60); do docker logs "$NAME-wake" 2>&1 | grep "streamable http server listening" >/dev/null && break; sleep 1; done
  python3 - "http://127.0.0.1:${WPORT}/mcp" <<'PY'
import json, re, sys, urllib.request
def post(b):
    r = urllib.request.Request(sys.argv[1], data=json.dumps(b).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'x-phone-holder': 'smoke'})
    raw = urllib.request.urlopen(r, timeout=60).read().decode()
    m = re.search(r'^data: (.*)$', raw, re.M)
    return json.loads(m.group(1)) if m else (json.loads(raw) if raw.strip() else {})  # gateway errors are plain JSON
post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 's', 'version': '0'}}})
post({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'mobile_list_available_devices', 'arguments': {}}})  # what models call first
r = post({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'mobile_list_elements_on_screen', 'arguments': {'device': 'phone.lan:5555'}}})
print(''.join(c.get('text', '') for c in (r.get('result') or {}).get('content', [])))
PY
}
wake_run '{"wake":"Dozing","calls":[]}' >/dev/null
grep -q KEYCODE_WAKEUP "$WDIR/phone.json" || fail "wake: no KEYCODE_WAKEUP"
grep -q '"wake":"Awake"' "$WDIR/phone.json" || fail "wake: still asleep"
if grep -q POWER "$WDIR/phone.json"; then fail "wake pressed POWER"; fi
docker logs "$NAME-wake" 2>&1 | grep '"event":"screen_woken"' >/dev/null || fail "wake: no screen_woken log"
echo "ok: PHONE_WAKE wakes a dozing screen with KEYCODE_WAKEUP (never POWER) before the call, also right after listing devices"
out=$(wake_run '{"wake":"Dozing","stuck":true,"calls":[]}')
echo "$out" | grep -q "没能自动点亮" || fail "wake: no clear error when the screen stays off"
[ "$(grep -o KEYCODE_WAKEUP "$WDIR/phone.json" | wc -l)" -eq 1 ] || fail "wake: more than one WAKEUP when it does not wake"
echo "ok: a screen that will not wake gives a clear error after one attempt"
wake_run '{"wake":"Awake","calls":[]}' >/dev/null
# (no phone here, so the read itself fails and is followed by one more check; what matters: no key on an awake screen)
[ "$(grep -o "dumpsys power" "$WDIR/phone.json" | wc -l)" -le 2 ] || fail "wake: awake screen checked too often"
if grep -q keyevent "$WDIR/phone.json"; then fail "wake: key pressed on an awake screen"; fi
echo "ok: an awake screen is only checked, no keys"
# the user switched the screen off right after a check: an action (tap) is checked again and woken first
echo '{"wake":"Awake","calls":[]}' > "$WDIR/phone.json"
python3 - "http://127.0.0.1:${WPORT}/mcp" "$WDIR/phone.json" <<'PY'
import json, re, sys, urllib.request
def post(b):
    r = urllib.request.Request(sys.argv[1], data=json.dumps(b).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'x-phone-holder': 'smoke'})
    urllib.request.urlopen(r, timeout=60).read()
post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 's', 'version': '0'}}})
post({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'mobile_list_elements_on_screen', 'arguments': {'device': 'phone.lan:5555'}}})
st = json.load(open(sys.argv[2])); st['wake'] = 'Dozing'; json.dump(st, open(sys.argv[2], 'w'))
post({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'mobile_click_on_screen_at_coordinates', 'arguments': {'device': 'phone.lan:5555', 'x': 1, 'y': 1}}})
PY
grep -q '"wake":"Awake"' "$WDIR/phone.json" || fail "an action right after the screen went off was not woken"
echo "ok: actions are always checked (screen switched off right after a check gets woken before a tap)"
docker rm -f "$NAME-wake" >/dev/null; rm -rf "$WDIR"

echo "SMOKE PASS"
