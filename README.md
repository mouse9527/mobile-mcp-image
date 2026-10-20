# mobile-mcp-image

Container image for [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp), which has no published image,
bundled with `adb` so it can drive an Android phone over Wi-Fi adb from a Kubernetes Pod or any container host.

- **Unmodified upstream**: `@mobilenext/mobile-mcp` from npm, every dependency pinned by `package-lock.json`
  (version + sha512). This repo only adds an entrypoint.
- **adb**: Google [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools), pinned by sha256.
- **Runtime**: `gcr.io/distroless/nodejs22-debian13` — no shell, no package manager; runs as uid 1000.
- **Image**: `ghcr.io/mouse9527/mobile-mcp-image:sha-<short commit>` (linux/amd64; built only from `main`; no `latest`).

| Component | Version |
|---|---|
| mobile-mcp | 1.0.12 (mobilecli 1.0.21) |
| platform-tools (adb) | 37.0.1 |
| Node.js | 22 (distroless, Debian 13) |

## What the entrypoint does

1. Refuses to start unless `MOBILEMCP_AUTH` is set (mobile-mcp otherwise serves without authentication),
   or `MOBILEMCP_AUTH_DISABLED=1` explicitly allows that (for use behind an authenticating proxy). Setting both is an error.
2. Copies `$ADB_KEY_DIR/adbkey` to `~/.android/adbkey` with mode 0600, so the phone's pairing survives restarts.
   adb derives the public key from the private key; no `adbkey.pub` is needed.
3. Starts the adb server with mDNS off (`ADB_MDNS=0`; container networks usually drop multicast).
4. If `PHONE_ADDR` is set, checks every `KEEPALIVE_SECONDS` whether the phone is connected and runs
   `adb connect` on each of `PHONE_ADB_PORTS` until one works. It logs one line only when the state changes.
5. Starts mobile-mcp's Streamable HTTP server on `MCP_LISTEN` (`/mcp`), in the same process.

Telemetry (PostHog, scarf.sh) is off by default (`MOBILEMCP_DISABLE_TELEMETRY=1`).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MOBILEMCP_AUTH` | — (**required** unless disabled) | Bearer token clients must send |
| `MOBILEMCP_AUTH_DISABLED` | unset | `1` = serve without authentication. Only behind something that enforces access (authenticating proxy + network policy) |
| `PHONE_ADDR` | empty | Phone host name or IP. Empty = do not connect (the MCP server still starts) |
| `PHONE_ADB_PORTS` | `5555` | Ports to try, space separated. `5555` after `adb tcpip 5555`; Android 11+ wireless debugging uses a random port |
| `KEEPALIVE_SECONDS` | `20` | Reconnect check interval (minimum 5) |
| `ADB_KEY_DIR` | empty | Directory containing `adbkey` (RSA private key, PEM). Mount a secret here |
| `MCP_LISTEN` | `0.0.0.0:8931` | `[host:]port` for the MCP endpoint |
| `HOME` | `/tmp/home` | Must be writable (adb key copy, mobilecli daemon socket) |
| `MOBILEMCP_ALLOW_UNSAFE_URLS` | unset | mobile-mcp: set `1` to let `mobile_open_url` open app deep links (non-http schemes) |
| `MOBILEMCP_DISABLE_TELEMETRY` | `1` | mobile-mcp telemetry switch |
| `LOG_FILE` | unset | mobile-mcp: also append each tool call, with timestamps, to this file |

Writable paths needed with a read-only root filesystem: `$HOME` (default `/tmp/home`) — mount an `emptyDir` on `/tmp`.

## Run

```bash
# generate a key once and keep it; pairing is bound to it
openssl genrsa -traditional -out adbkey 2048

docker run --rm -p 8931:8931 \
  -e MOBILEMCP_AUTH="$(openssl rand -hex 32)" \
  -e PHONE_ADDR=<phone host or IP> \
  -e ADB_KEY_DIR=/keys -v "$PWD/adbkey:/keys/adbkey:ro" \
  ghcr.io/mouse9527/mobile-mcp-image:sha-<short commit>
```

Pair the phone once from inside the container (Android 11+: Developer options → Wireless debugging → Pair device with pairing code):

```bash
docker exec -it <container> adb pair <phone>:<pairing port>     # enter the 6-digit code
docker exec -it <container> adb connect <phone>:<debug port>
docker exec -it <container> adb -s <phone>:<debug port> tcpip 5555   # switch to a fixed port
```

After a phone reboot `tcpip 5555` is lost: re-enable Wireless debugging and run the last two commands again with the new port.

## Security notes

- Anyone holding the Bearer token can fully control the phone (tap, type, install / uninstall apps, open any URL scheme).
  Keep the endpoint on a private network and restrict who can reach it.
- The adb server listens only inside the container; do not publish adb ports.

## Upgrading

- **mobile-mcp**: change the version in `package.json`, then regenerate the lockfile from the public npm registry:
  `npm install --package-lock-only --ignore-scripts --omit=dev --registry https://registry.npmjs.org`.
  Check the upstream changelog for new tools and update the expected tool count in `smoke.sh`.
- **platform-tools**: change `PLATFORM_TOOLS_VERSION` and `PLATFORM_TOOLS_SHA256` in the Dockerfile.
  Google's repository manifest (`https://dl.google.com/android/repository/repository2-3.xml`) lists sha1 only;
  download the zip, check its sha1 against the manifest, then record its sha256.
- **Base images**: update the digests in `NODE_IMAGE` / `RUNTIME_IMAGE`; keep both on the same Debian release.

## CI

`.github/workflows/image.yml`: build linux/amd64 → `audit.sh` (no adb keys, credentials or `.git` in the image;
file list and hashes uploaded as an artifact) → `smoke.sh` (refuses to start without a token, 401 without token,
33 tools, adb ≥ 37, uid 1000, no shell, telemetry off) → push to ghcr from `main` only.

## License

MIT for the files in this repository (`LICENSE`). The image also contains third-party software under its own
licenses; see `NOTICE.md`.
