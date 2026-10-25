// mobile-mcp-image screen helpers for the lease gateway (PHONE_LEASE=1):
//   A. PHONE_WAKE=1   make sure the screen is on before a tool that needs it, so the model never has to wake the phone
//   B. ELEMENTS_TRIM=1 shorter mobile_list_elements_on_screen text: no visible string or ref is dropped
// Both off unless set. Uses the adb server of this container (the entrypoint keeps the phone connected).
"use strict";
const { execFile } = require("node:child_process");

const env = (k, d) => Number(process.env[k] || d);
const WAKE = process.env.PHONE_WAKE === "1";
const TRIM = process.env.ELEMENTS_TRIM === "1";
const CHECK_EVERY = env("WAKE_CHECK_S", 15) * 1000; // reads trust an "Awake" from dumpsys this long
const SETTLE = env("WAKE_SETTLE_MS", 800); // let the foreground app draw after waking
const ADB = process.env.WAKE_ADB || "adb";

// tools that never need the screen (no check before them)
const NO_SCREEN = new Set(["mobile_list_available_devices", "mobile_list_apps", "mobile_install_app", "mobile_uninstall_app",
	"mobile_get_device_logs", "mobile_list_crashes", "mobile_get_crash", "mobile_set_location", "mobile_clipboard",
	"mobile_get_orientation", "mobile_set_orientation", "mobile_fold_device", "mobile_get_screen_size"]);
// read-only tools that are safe to run again after a "no UI hierarchy" failure
const RETRYABLE = new Set(["mobile_list_elements_on_screen", "mobile_get_foreground_app", "mobile_take_screenshot"]);
const NO_UI = /No UI hierarchy|screen is most likely off or locked/;

// WAKE_ADB may point at a .js stand-in (smoke test): run it with this node, the image has no /usr/bin/env
const run = (args, timeout = 8000) => new Promise((resolve) => {
	const [cmd, pre] = ADB.endsWith(".js") ? [process.execPath, [ADB]] : [ADB, []];
	execFile(cmd, [...pre, ...args], { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ""}${stderr || ""}` }));
});

let serial = null;
let awakeUntil = 0;

async function device() {
	if (serial) return serial;
	const r = await run(["devices"]);
	const ids = r.out.split("\n").map((l) => l.split("\t")).filter((p) => p[1] && p[1].trim() === "device").map((p) => p[0]);
	serial = ids.length === 1 ? ids[0] : null; // exactly one phone per Pod
	return serial;
}

const shell = async (...cmd) => {
	const s = await device();
	if (!s) return { ok: false, out: "no device" };
	const r = await run(["-s", s, "shell", ...cmd]);
	if (!r.ok) serial = null; // reconnects get re-detected
	return r;
};

// mWakefulness=Awake | Asleep | Dozing | Dreaming
async function wakefulness() {
	const r = await shell("dumpsys", "power");
	const m = r.out.match(/mWakefulness=(\w+)/);
	return m ? m[1] : null;
}

// -> {ok, woke, detail}; never presses POWER (a toggle). KEYCODE_WAKEUP is a no-op on a screen that is already on.
async function ensureAwake(tool, log) {
	if (!WAKE || NO_SCREEN.has(tool)) return { ok: true, woke: false };
	// reads may trust a recent check (a failed read is woken and retried); actions (tap, swipe, type, keys, launch) are
	// never retried, so they always check: the user may have switched the screen off a moment ago
	if (RETRYABLE.has(tool) && Date.now() < awakeUntil) return { ok: true, woke: false };
	const w = await wakefulness();
	if (w === "Awake") {
		awakeUntil = Date.now() + CHECK_EVERY;
		return { ok: true, woke: false };
	}
	if (w === null) {
		log("screen_check_failed", { tool });
		return { ok: true, woke: false }; // let the call run; mobile-mcp reports its own error
	}
	await shell("input", "keyevent", "KEYCODE_WAKEUP");
	await shell("wm", "dismiss-keyguard"); // the phones have no lock-screen password; no-op without a keyguard
	await new Promise((r) => setTimeout(r, SETTLE));
	const after = await wakefulness();
	log("screen_woken", { tool, from: w, to: after });
	if (after !== "Awake") return { ok: false, detail: `屏幕没能点亮（${w} → ${after}）` };
	awakeUntil = Date.now() + CHECK_EVERY;
	return { ok: true, woke: true };
}

// a read-only call failed. Screen off (switched off since the last check; on some phones the read then fails with a
// generic mobilecli error, not "no UI hierarchy") -> wake. Screen on but no UI hierarchy -> MIUI pocket mode
// ("已进入防误触模式"), which volume up + down ends. Otherwise the error is not about the screen: no retry.
// -> true when the call should be retried (once)
async function recover(errorText, log) {
	awakeUntil = 0;
	const w = await wakefulness();
	let action = null;
	if (w && w !== "Awake") {
		await shell("input", "keyevent", "KEYCODE_WAKEUP");
		await shell("wm", "dismiss-keyguard");
		action = "wakeup";
	} else if (w === "Awake" && NO_UI.test(errorText)) {
		await shell("input", "keyevent", "KEYCODE_VOLUME_UP"); // both: the volume ends up unchanged
		await shell("input", "keyevent", "KEYCODE_VOLUME_DOWN");
		action = "volume_up_down";
	}
	if (!action) return false;
	await new Promise((r) => setTimeout(r, SETTLE));
	log("screen_recover", { from: w, action });
	return true;
}

const WAKE_FAILED = (detail) => `手机屏幕没能自动点亮或解除遮挡：${detail}。不要按电源键反复尝试；` +
	"告诉用户手机屏幕可能被遮挡 / 需要人看一眼，等用户处理后再继续。";

// ---- B: trim the text format of mobile_list_elements_on_screen (refs unchanged; only lines dropped / shortened)
const LINE = /^(@e\d+) (\S+)(.*?) at=(-?\d+),(-?\d+) size=(\d+)x(\d+)(.*)$/;
const HEADER_IN = "One element per line: @ref Type";
const HEADER_OUT = "One element per line: @ref Type text= label= value= id= c=centerX,centerY size=WxH [focused] [selected] [checked] [disabled]" +
	" (c = the point to tap; identical overlapping elements listed once)";

function trimBlock(block) {
	const lines = block.split("\n");
	const out = [HEADER_OUT];
	const seen = new Set();
	let dropped = 0;
	for (const l of lines.slice(1)) {
		const m = l.match(LINE);
		if (!m) {
			out.push(l);
			continue;
		}
		let [, ref, type, mid, x, y, w, h, flags] = m;
		[x, y, w, h] = [x, y, w, h].map(Number);
		const key = `${mid.replace(/ id="[^"]*"/, "").trim()}|${x},${y},${w},${h}`;
		if (seen.has(key) || w * h === 0) {
			dropped++;
			continue;
		}
		seen.add(key);
		mid = mid.replace(/ id="[\w.]+:id\/([^"]*)"/, ' id="$1"');
		const t = mid.match(/ text=("(?:[^"\\]|\\.)*")/);
		const lb = mid.match(/ label=("(?:[^"\\]|\\.)*")/);
		if (t && lb && t[1] === lb[1]) mid = mid.replace(` label=${lb[1]}`, "");
		out.push([ref, type.slice(type.lastIndexOf(".") + 1), mid.trim(), `c=${x + Math.floor(w / 2)},${y + Math.floor(h / 2)} size=${w}x${h}`,
			flags.trim()].filter(Boolean).join(" "));
	}
	return { text: out.join("\n"), dropped };
}

// works on a single list result and on mobile_batch_commands output that embeds one or more of them
function trimElements(text) {
	if (!TRIM || !text.includes(HEADER_IN)) return text;
	const parts = text.split(new RegExp(`(?=${HEADER_IN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`));
	return parts.map((p) => {
		if (!p.startsWith(HEADER_IN)) return p;
		const end = p.search(/\n(?!@e\d+ )/); // the block ends at the first line that is not an element
		const block = end < 0 ? p : p.slice(0, end);
		return trimBlock(block).text + (end < 0 ? "" : p.slice(end));
	}).join("");
}

module.exports = { WAKE, TRIM, NO_SCREEN, RETRYABLE, NO_UI, ensureAwake, recover, trimElements, trimBlock, WAKE_FAILED };
