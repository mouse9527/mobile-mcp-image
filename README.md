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

## Lease gateway (optional, `PHONE_LEASE=1`)

When several agents share one phone through an MCP gateway that opens a new upstream session for every tool call
(LiteLLM does), per-session locking is useless and multi-step tasks interleave (agent A reads the screen, agent B
opens another app, agent A taps). With `PHONE_LEASE=1` the entrypoint puts a small gateway (`gateway.js`, same
process, no dependencies) on `MCP_LISTEN` and moves mobile-mcp to `LEASE_INNER_LISTEN` (default `127.0.0.1:8932`).
mobile-mcp itself is unchanged; with the variable unset nothing changes.

- **One holder at a time.** A holder's tool call takes the phone if it is free and nobody is queued; every call extends
  the lease to now + `LEASE_IDLE_S`. Others wait FIFO inside their call for up to `LEASE_WAIT_S`, then get a tool error
  (`isError`) saying the phone is busy and their queue position (kept `LEASE_TICKET_S`, while someone holds the phone).
  When the lease ends, the first caller still **waiting** in a call gets it, reserved `LEASE_GRACE_S` for its next call;
  queued callers that are not waiting any more are skipped, so the phone is never parked for someone who left. State is in memory: a restart frees the phone.
- **Who is the holder** (first match): `x-phone-holder` header (set by the client's MCP config) > `x-openwebui-chat-id`
  (Open WebUI) > the client's MCP session id at the gateway in front, forwarded as `mcp-session-id` (mobile-mcp is
  stateless, so it is on every request) > nothing (call-level exclusion only, never keeps the phone). A client session
  seen for the first time only gets `LEASE_SESSION_FIRST_IDLE_S`, so callers that open a new session per call do not
  wait behind themselves. LiteLLM: list `mcp-session-id`, `x-openwebui-chat-id`, `x-phone-holder` in the server's
  `extra_headers`.
- **Extra tools** in `tools/list`: `phone_guide` (see below), `lease_status`, `lease_hold` (`seconds`, keep the phone
  while waiting for the user to tap something within the same turn, capped at `LEASE_HOLD_MAX_S`; the tool description
  is built from that value), `lease_release` (call it before replying). `LEASE_TOKENS=1` also adds `lease_acquire` and an optional `lease`
  argument on every tool, for callers that cannot be identified otherwise (off by default: it changes tool schemas).
- **A hold across chat turns.** The holder is only as stable as the id that identifies it. If the client gets a new MCP
  session id for every turn (a chat turn = a new client process), a `lease_hold` made to wait for the user is held by a
  session that no longer exists: the next turn is "someone else", cannot use the phone until the hold ends (at most
  `LEASE_HOLD_MAX_S`) and cannot release it. The proper fix is an id that is stable across turns (`x-phone-holder`, set
  per chat in the client's MCP config). Meanwhile: the busy / `lease_status` texts say when the holder is a `lease_hold`
  and for how long; `lease_release` answers "not yours, unchanged" instead of "released" when the caller is not the holder
  (and "already free" when nobody holds); `lease_release` with `force=true` ends **a hold** left by someone else (for the
  user's explicit "clean it up" — never a caller that is simply working; those expire after `LEASE_IDLE_S`). A forced
  release is logged as `lease_force_released` (hashed holder and hashed caller).
- **Logs**: one JSON line per event on stderr (`"src":"lease"`): time, event, a sha256 prefix of the holder, how it was
  identified, tool name, wait time. Never arguments, results or raw holder ids.

| Variable | Default |
|---|---|
| `LEASE_IDLE_S` | `120` |
| `LEASE_SESSION_FIRST_IDLE_S` | `30` |
| `LEASE_WAIT_S` | `45` |
| `LEASE_TICKET_S` | `90` |
| `LEASE_GRACE_S` | `30` |
| `LEASE_HOLD_MAX_S` | `120` |
| `LEASE_TOKENS` | unset (off) |
| `LEASE_INNER_LISTEN` | `127.0.0.1:8932` |
| `GUIDE_DIR` | `/app/guide` (the guide in the image) |
| `GUIDE_TTL_S` | `1800` |

## Usage guide (with the lease gateway)

The phone's usage guide (hard rules, call order, lease rules, how to use each app) ships with the gateway, so every
client of the phone MCP gets it without installing anything else. Source: `guide/*.md` (Chinese, for the model).

- `phone_guide(topic?)`: no topic = `guide/core.md` plus the list of topics; `topic` = another file's name
  (`captcha`, `input`, `screen`, `speed`), `app:<id>` for `guide/app-<id>.md`, or an app's name as in its title (`淘宝`).
  Unknown topic = tool error with the list. Needs no lease and never waits for the phone.
- **First call per holder**: when a holder (see above) calls a phone tool and has not had the core guide within
  `GUIDE_TTL_S`, the call runs as usual and the core guide is appended to its result as an extra text item (log event
  `guide_appended`). Reading `phone_guide()` first counts. Callers identified by nothing (`anon`) never get it appended.
  State is in memory.
- **Numbers live in one place**: the guide writes `{{LEASE_IDLE_S}}`, `{{LEASE_HOLD_MAX_S}}`, `{{LEASE_WAIT_S}}`, filled
  from the settings at start-up; `smoke/guide_check.py` (CI) refuses a bare 120 / 600 and unknown placeholders.
- **Changing the guide**: edit `guide/`, open a PR (run `scripts/preflight.sh` before pushing: this repository is
  public) → merged to `main` builds and pushes a new image (guide changes trigger the build) → deploy that image.
  `GUIDE_DIR` can point at a mounted directory instead, to change the text without a new image.

## Screen helpers (optional, with the lease gateway)

- `PHONE_WAKE=1`: before a tool that needs the screen, the gateway checks `dumpsys power` (at most every `WAKE_CHECK_S`,
  default 15 s, also refreshed by every successful call). If the screen is not `Awake`: `KEYCODE_WAKEUP` (never POWER,
  which toggles), `wm dismiss-keyguard` (for phones without a lock-screen password), wait `WAKE_SETTLE_MS` (800), check
  again; still off → a clear tool error, mobile-mcp is not called. A read-only call (elements, foreground app,
  screenshot) that still finds no UI hierarchy gets one recovery round (screen on: VOLUME_UP + VOLUME_DOWN, which ends
  MIUI's pocket mode; screen off: WAKEUP again) and one retry, then a clear error. Uses the adb server of the container.
- `ELEMENTS_TRIM=1`: shorter `mobile_list_elements_on_screen` text (also inside `mobile_batch_commands`): identical
  overlapping elements listed once, zero-size ones dropped, resource ids without the package prefix, a label equal to the
  text written once, centre point `c=x,y` instead of the top-left corner. No visible string is dropped and refs keep their
  original numbers (taps by ref re-read the screen). `format=json` is not touched.
- Both off unless set; with both off tool calls are passed through unchanged. Log events: `screen_woken`,
  `screen_recover`, `screen_still_no_ui`, `screen_check_failed`.

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

## Personal-data check (this repository is public)

Nothing in this repository may carry personal data (phone numbers, addresses, places, statements about the phone's
security settings or whereabouts). The rules and scripts are copied from `mouse9527/skills`; keep them in step.

```bash
git config --worktree core.hooksPath scripts/hooks   # once per checkout (plain `git config` if not a worktree)
scripts/preflight.sh                                  # before every push: clean tree -> public rules -> private scan
```

- `scripts/validate.py`: public rules (`policy/rules.py`) on every file; symlinks and binary files are refused. Run by CI
  (`.github/workflows/validate.yml`).
- `scripts/pii_scan.py` (via `scripts/preflight.sh`): the final tree and every commit in `origin/main..HEAD` (identity,
  message, every file version it adds) with the public rules **and a private term list kept outside every repository**
  (`$PII_TERMS`, else `$SKILLS_PII_TERMS`, default `~/.config/assistant-config/pii-terms.txt`, mode 0600). A missing,
  empty or group/world-readable list is a failure. Output names commit / file / line / kind only, never the match.
- `scripts/hooks/pre-push`: refuses a push unless preflight passed for exactly that commit.
- **CI green does not mean the private check passed**: CI never has the term list.

## CI

`.github/workflows/image.yml`: build linux/amd64 → `audit.sh` (no adb keys, credentials or `.git` in the image;
file list and hashes uploaded as an artifact) → `smoke.sh` (refuses to start without a token, 401 without token,
33 tools, adb ≥ 37, uid 1000, no shell, telemetry off; lease gateway with `PHONE_LEASE=1`: queueing, release, FIFO,
hold, holder identity, first-call probation, honest release / forced release of a hold, `phone_guide` and the
first-call guide — `smoke/lease_test.py`; guide content — `smoke/guide_check.py`; defaults: hold cap 120 s, guide
loaded from the image) → push to
ghcr from `main` only. The lease test also runs without docker or a phone: `smoke/run_lease_local.sh` (gateway.js against
`smoke/fake_upstream.js`).

## License

MIT for the files in this repository (`LICENSE`). The image also contains third-party software under its own
licenses; see `NOTICE.md`.
