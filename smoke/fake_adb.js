// smoke: stand-in for adb (screen.js runs .js stand-ins with node). State in FAKE_PHONE_STATE: {wake, pocket, stuck, calls}
"use strict";
const fs = require("node:fs");
const F = process.env.FAKE_PHONE_STATE;
const st = JSON.parse(fs.readFileSync(F, "utf8"));
const a = process.argv.slice(2);
st.calls.push(a.join(" "));
let out = "";
if (a[0] === "devices") out = "List of devices attached\nphone.lan:5555\tdevice\n";
else if (a[0] === "-s" && a[2] === "shell") {
	const cmd = a.slice(3).join(" ");
	if (cmd === "dumpsys power") out = `  mWakefulness=${st.wake}\n  mWakefulnessChanging=false\n`;
	else if (cmd === "input keyevent KEYCODE_WAKEUP") { if (!st.stuck) st.wake = "Awake"; }
	else if (cmd === "input keyevent KEYCODE_POWER") st.wake = st.wake === "Awake" ? "Asleep" : "Awake";
	else if (cmd === "input keyevent KEYCODE_VOLUME_UP") st.volUp = true;
	else if (cmd === "input keyevent KEYCODE_VOLUME_DOWN") { if (st.volUp && !st.pocketStuck) st.pocket = false; }
	else if (cmd === "wm dismiss-keyguard") st.keyguard = false;
}
fs.writeFileSync(F, JSON.stringify(st));
process.stdout.write(out);
