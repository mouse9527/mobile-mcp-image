// mobile-mcp-image entrypoint: prepare the adb key, start the adb server, keep the
// phone connected in the background, then run mobile-mcp in this same process.
//
// Written in JavaScript so the runtime image needs no shell.
//
// env:
//   MOBILEMCP_AUTH     Bearer token for the MCP endpoint; refuses to start without it unless
//                      MOBILEMCP_AUTH_DISABLED=1
//   MOBILEMCP_AUTH_DISABLED  "1" = serve without authentication (only behind something that enforces
//                      access, e.g. an authenticating proxy + NetworkPolicy). Setting both is an error.
//   PHONE_ADDR         phone host name or IP; empty = do not connect (MCP still starts)
//   PHONE_ADB_PORTS    ports to try in order, space separated (default "5555")
//   KEEPALIVE_SECONDS  check interval (default 20)
//   ADB_KEY_DIR        directory holding `adbkey` (RSA private key, PEM); the phone's pairing
//                      is bound to this key. adb derives the public key from it at runtime.
//   MCP_LISTEN         [host:]port for Streamable HTTP (default 0.0.0.0:8931)
//   PHONE_LEASE        "1" = one holder at a time (gateway.js) on MCP_LISTEN, mobile-mcp moves to
//                      LEASE_INNER_LISTEN (default 127.0.0.1:8932). Unset / "0" = mobile-mcp on MCP_LISTEN as before.
//                      Lease tuning: LEASE_* (see gateway.js / README)
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const log = (msg) => process.stderr.write(`mobile-mcp-image: ${msg}\n`);

const authDisabled = process.env.MOBILEMCP_AUTH_DISABLED === "1";
if (authDisabled && process.env.MOBILEMCP_AUTH) {
	log("both MOBILEMCP_AUTH and MOBILEMCP_AUTH_DISABLED=1 are set; refusing to start (pick one)");
	process.exit(1);
}
if (authDisabled) {
	// mobile-mcp treats an unset token as "no auth"; drop an empty one so the intent is unambiguous
	delete process.env.MOBILEMCP_AUTH;
	log("WARNING MOBILEMCP_AUTH_DISABLED=1: serving without authentication; access must be enforced in front of this server");
} else if (!process.env.MOBILEMCP_AUTH) {
	log("MOBILEMCP_AUTH is not set; refusing to start without authentication (set MOBILEMCP_AUTH_DISABLED=1 to allow)");
	process.exit(1);
}

// Telemetry off unless explicitly re-enabled (PostHog + scarf.sh in mobile-mcp)
if (process.env.MOBILEMCP_DISABLE_TELEMETRY === undefined) {
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
}

// mDNS discovery needs multicast, which container networks usually drop; ports come from env
process.env.ADB_MDNS = "0";

const home = process.env.HOME || "/tmp/home";
const androidDir = path.join(home, ".android");
fs.mkdirSync(androidDir, { recursive: true, mode: 0o700 });
fs.chmodSync(androidDir, 0o700);

const keyDir = process.env.ADB_KEY_DIR;
const keySrc = keyDir ? path.join(keyDir, "adbkey") : "";
if (keySrc && fs.existsSync(keySrc) && fs.statSync(keySrc).size > 0) {
	// copy rather than link: adb wants a 0600 private key, secret volumes are read-only
	const dst = path.join(androidDir, "adbkey");
	fs.copyFileSync(keySrc, dst);
	fs.chmodSync(dst, 0o600);
} else {
	log("WARNING no adbkey found; adb will generate a temporary key and the phone must be paired again after every restart");
}

const adb = (args, timeoutMs = 15000) => new Promise((resolve) => {
	execFile("adb", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
		resolve({ ok: !err, out: `${stdout || ""}${stderr || ""}`.trim() });
	});
});

const addr = (process.env.PHONE_ADDR || "").trim();
const ports = (process.env.PHONE_ADB_PORTS || "5555").split(/\s+/).filter(Boolean);
const interval = Math.max(5, Number(process.env.KEEPALIVE_SECONDS || 20)) * 1000;

const isConnected = async (serial) => (await adb(["-s", serial, "get-state"])).out === "device";

let last = "";
const keepalive = async () => {
	let current = "offline";
	for (const port of ports) {
		if (await isConnected(`${addr}:${port}`)) {
			current = `${addr}:${port}`;
			break;
		}
	}
	if (current === "offline") {
		for (const port of ports) {
			const serial = `${addr}:${port}`;
			await adb(["disconnect", serial]);
			const res = await adb(["connect", serial]);
			if (res.out.includes("connected to")) {
				await new Promise((r) => setTimeout(r, 1000));
				if (await isConnected(serial)) {
					current = serial;
					break;
				}
			}
		}
	}
	if (current !== last) {
		log(`phone ${addr} -> ${current}`);
		last = current;
	}
};

const loop = async () => {
	try {
		await keepalive();
	} catch (err) {
		log(`keepalive error: ${err.message}`);
	}
	setTimeout(loop, interval).unref();
};

(async () => {
	const started = await adb(["start-server"], 30000);
	if (!started.ok) {
		log(`adb start-server failed: ${started.out}`);
	}
	if (addr) {
		loop();
	}

	// hand over to mobile-mcp in this process (its CLI reads process.argv)
	let listen = process.env.MCP_LISTEN || "0.0.0.0:8931";
	if (process.env.PHONE_LEASE === "1") {
		// the lease gateway takes the public address; mobile-mcp only listens on loopback behind it
		const i = listen.lastIndexOf(":");
		const inner = process.env.LEASE_INNER_LISTEN || "127.0.0.1:8932";
		process.env.LEASE_HOST = i < 0 ? "0.0.0.0" : listen.slice(0, i);
		process.env.LEASE_PORT = i < 0 ? listen : listen.slice(i + 1);
		process.env.LEASE_UPSTREAM = `http://${inner}/mcp`;
		require("./gateway.js");
		log(`lease gateway on ${listen}, mobile-mcp on ${inner}`);
		listen = inner;
	}
	process.argv = [process.argv[0], "mobile-mcp", "--listen", listen];
	require("@mobilenext/mobile-mcp/lib/index.js");
})();
