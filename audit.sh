#!/bin/bash
# audit.sh <image> <out-dir>: export the image filesystem, prove it carries no keys / credentials / .git.
# Blocking checks run only on paths this repo controls; third-party matches are recorded, not blocking.
set -euo pipefail
IMG="$1"; OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
ROOTFS="$OUT/rootfs"
rm -rf "$ROOTFS" && mkdir -p "$ROOTFS"
trap 'rm -rf "$ROOTFS"' EXIT
docker history --no-trunc --format '{{.CreatedBy}}' "$IMG" > "$OUT/history.txt"
docker inspect "$IMG" --format '{{json .Config.Env}}' > "$OUT/env.json"
cid=$(docker create "$IMG")
docker export "$cid" | tar -x -C "$ROOTFS"
docker rm "$cid" >/dev/null
find "$ROOTFS" -xdev -type f | sed "s#^$ROOTFS##" | sort > "$OUT/files.txt"
echo "files: $(wc -l < "$OUT/files.txt")"

# 1) files that must not exist anywhere (blocking)
find "$ROOTFS" -xdev \( -name 'adbkey*' -o -name '.git' -o -name '.env' -o -name '.netrc' -o -name '.git-credentials' \
  -o -name 'id_rsa*' -o -name '*.key' -o -name '.npmrc' \) -print | sed "s#^$ROOTFS##" > "$OUT/forbidden-files.txt"

# private key bodies (BEGIN line followed by base64), blocking on our paths only
KEYRE='-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{40,}\r?\n'
for d in app/entrypoint.js app/gateway.js app/screen.js app/package.json app/package-lock.json opt/platform-tools tmp home root; do
  [ -e "$ROOTFS/$d" ] && grep -rlIPz -e "$KEYRE" "$ROOTFS/$d" 2>/dev/null | tr '\0' '\n' | sed "s#^$ROOTFS##" || true
done >> "$OUT/forbidden-files.txt"
# record only: third-party trees (test fixtures, CA bundles)
grep -rlPz -e "$KEYRE" "$ROOTFS/app/node_modules" "$ROOTFS/usr" "$ROOTFS/etc/ssl" 2>/dev/null | tr '\0' '\n' | sed "s#^$ROOTFS##" > "$OUT/thirdparty-key-like.txt" || true

# 2) credential-looking words in build history / ENV (blocking)
grep -inE 'password|secret|token=|_auth=|MOBILEMCP_AUTH=' "$OUT/history.txt" "$OUT/env.json" > "$OUT/suspicious-config.txt" || true

# 3) our own files, with hashes
sha256sum "$ROOTFS/app/entrypoint.js" "$ROOTFS/app/gateway.js" "$ROOTFS/app/screen.js" "$ROOTFS/app/package.json" "$ROOTFS/app/package-lock.json" \
  "$ROOTFS/opt/platform-tools/adb" "$ROOTFS"/app/node_modules/@mobilenext/mobilecli-*/mobilecli-* > "$OUT/ours.raw"
sed "s#$ROOTFS##" "$OUT/ours.raw" > "$OUT/ours.txt" && rm "$OUT/ours.raw"
ls "$ROOTFS/app/node_modules/@mobilenext/" > "$OUT/mobilenext-packages.txt"

echo "--- forbidden:"; cat "$OUT/forbidden-files.txt"
echo "--- suspicious config:"; cat "$OUT/suspicious-config.txt"
echo "--- third-party key-like (record only):"; cat "$OUT/thirdparty-key-like.txt"
echo "--- ours:"; cat "$OUT/ours.txt"
test ! -s "$OUT/forbidden-files.txt"
test ! -s "$OUT/suspicious-config.txt"
# exactly one mobilecli binary package (the build platform)
test "$(grep -c '^mobilecli-' "$OUT/mobilenext-packages.txt")" = 1
echo "audit ok"
