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
echo "SMOKE PASS"
