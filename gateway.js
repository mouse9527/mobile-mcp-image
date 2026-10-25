// mobile-mcp-image lease gateway (PHONE_LEASE=1; k8s#87). Sits in front of mobile-mcp's Streamable HTTP endpoint in the
// same process and lets ONE holder use the phone at a time, across MCP sessions (an MCP gateway such as LiteLLM may open
// a new upstream session for every tool call). The entrypoint starts it; mobile-mcp itself is unmodified.
//
// Holder = who is asking. Resolved per request, first match wins (the "via" in the logs):
//   1 header   x-phone-holder: <id>          explicit, from the client's MCP config (env var); shared by sub-processes
//   2 chat     x-openwebui-chat-id: <id>     Open WebUI, one per chat, stable across turns
//   3 session  the CLIENT's MCP session id at LiteLLM, forwarded as mcp-session-id (extra_headers). With a stateless
//              upstream (mobile-mcp) it stays on every request; with a stateful one it is only on `initialize` and the
//              gateway remembers upstream session -> client session
//   4 token    `lease` argument = a token from lease_acquire (for callers with none of the above)
//   5 anon     nothing: the call runs alone (call-level exclusion, FIFO with everyone else) but never keeps the phone
// The MCP gateway in front must forward mcp-session-id, x-openwebui-chat-id and x-phone-holder (LiteLLM: extra_headers).
//
// Lease rules: a holder's call takes the lease when the phone is free and nobody is queued ahead; every call extends
// it to now + LEASE_IDLE_S (running calls never expire). Others wait FIFO up to LEASE_WAIT_S inside their call, then
// get a "phone busy" tool error with their position (kept LEASE_TICKET_S, but only while someone holds the phone). When a
// lease ends, the first caller still WAITING in a call gets it (reserved LEASE_GRACE_S to make its next call); queued
// callers that are not waiting are skipped, so a finished hold never parks the phone for someone who left. lease_hold(seconds) keeps it while waiting for the user (<= LEASE_HOLD_MAX_S);
// lease_release ends it. State is in memory: a restart frees the phone.
//
// Logs (stderr, JSON lines): time, event, holder hash, via, tool, wait ms. Never arguments, results or raw ids.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const screen = require("./screen.js");

const env = (k, d) => Number(process.env[k] || d);
const LISTEN = env("LEASE_PORT", 8931);
const UPSTREAM = new URL(process.env.LEASE_UPSTREAM || "http://127.0.0.1:8932/mcp");
const IDLE = env("LEASE_IDLE_S", 120) * 1000;
const WAIT = env("LEASE_WAIT_S", 45) * 1000;
const TICKET = env("LEASE_TICKET_S", 90) * 1000;
const GRACE = env("LEASE_GRACE_S", 30) * 1000;
const HOLD_MAX = env("LEASE_HOLD_MAX_S", 600) * 1000;
const SESSION_TTL = env("LEASE_SESSION_MAP_TTL_S", 3600) * 1000;
// a client session seen for the first time may be a caller that opens a new session per call (a script, or OWUI
// without the chat id header): its lease is short until a second call shows the session persists
const FIRST_IDLE = env("LEASE_SESSION_FIRST_IDLE_S", 30) * 1000;
// level 4 (lease_acquire + optional `lease` argument on every tool) changes the tool schemas: off unless asked for
const TOKENS = process.env.LEASE_TOKENS === "1";

const LEASE_PARAM = {
	type: "string",
	description: "只在你用 lease_acquire 拿到了租约号时才填（原样回传）；其它情况不要填。",
};
const LEASE_TOOLS = [
	{ name: "lease_status", description: "手机现在是否空闲：你是否持有、别的任务占用了多久、你排第几。不操作手机。",
		inputSchema: { type: "object", properties: {} } },
	{ name: "lease_acquire", description: "显式占用手机并拿到租约号。只有在手机工具提示「无法识别你的会话」时才需要：之后每次调用手机工具都把租约号填进 lease 参数。",
		inputSchema: { type: "object", properties: {} } },
	{ name: "lease_hold", description: "等用户操作（扫码、看验证码、回复）时为当前任务保留手机，最多 600 秒；用户回来后照常继续调用手机工具。",
		inputSchema: { type: "object", properties: { seconds: { type: "number", description: "保留秒数，1–600" },
			lease: LEASE_PARAM }, required: ["seconds"] } },
	{ name: "lease_release", description: "当前任务不再需要手机时立刻释放，让排队的任务继续。",
		inputSchema: { type: "object", properties: { lease: LEASE_PARAM } } },
];

let holder = null; // {id, via, since, expiresAt, inflight, transient}
const queue = []; // [{id, ticketUntil, waiters: [fn]}]
const sessions = new Map(); // upstream session id -> {client, at}
const seenClients = new Map(); // client session -> calls so far
const tokens = new Map(); // lease token -> at
let anonSeq = 0;
const now = () => Date.now();
const hash = (id) => "h-" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
const log = (event, who, extra = {}) => process.stderr.write(JSON.stringify({ t: new Date().toISOString(), src: "lease", event,
	holder: who ? hash(who.id) : undefined, via: who ? who.via : undefined, ...extra }) + "\n");

function resolveHolder(req, args) {
	const h = (k) => String(req.headers[k] || "").trim();
	if (h("x-phone-holder")) return { id: "header:" + h("x-phone-holder"), via: "header" };
	if (h("x-openwebui-chat-id")) return { id: "chat:" + h("x-openwebui-chat-id"), via: "chat" };
	// a stateful upstream: its own session id maps to the client's (recorded at initialize); a stateless upstream such as
	// mobile-mcp issues none, so the forwarded client session id stays on every request and is used as is
	const sid = h("mcp-session-id");
	if (sid) return { id: "session:" + ((sessions.get(sid) || {}).client || sid), via: "session" };
	if (TOKENS && args && typeof args.lease === "string" && tokens.has(args.lease)) return { id: "token:" + args.lease, via: "token" };
	return { id: `anon#${++anonSeq}`, via: "anon", transient: true };
}

function tick() {
	const t = now();
	if (holder && holder.inflight === 0 && t >= holder.expiresAt) {
		if (!holder.transient) log("lease_expired", holder, { held_ms: t - holder.since });
		if (holder.via === "token") tokens.delete(holder.id.slice(6));
		holder = null;
	}
	if (holder) {
		// expired places of callers that stopped waiting
		for (let i = queue.length - 1; i >= 0; i--) if (queue[i].ticketUntil < t && queue[i].waiters.length === 0) queue.splice(i, 1);
		return;
	}
	// The phone is free: it goes to the first caller that is WAITING right now (a call blocked in the gateway). Places of
	// callers that are not waiting (gave up after LEASE_WAIT_S, chat over) only count while someone else holds the phone;
	// once it is free they are dropped and the next caller, waiting or new, gets it at once (k8s#87).
	while (queue.length && queue[0].waiters.length === 0) {
		const gone = queue.shift();
		if (!gone.who.transient) log("queue_skipped_not_waiting", gone.who);
	}
	const next = queue.shift();
	if (!next) return;
	holder = { ...next.who, since: t, expiresAt: t + (next.who.transient ? 0 : GRACE), inflight: 0 };
	if (!next.who.transient) log("lease_granted_from_queue", next.who);
	for (const w of next.waiters) w(true);
}
setInterval(tick, 250).unref();
setInterval(() => {
	for (const [k, v] of sessions) if (now() - v.at > SESSION_TTL) sessions.delete(k);
	if (seenClients.size > 10000) seenClients.clear();
}, 60000).unref();

const position = (who) => {
	const i = queue.findIndex((q) => q.who.id === who.id);
	return i < 0 ? queue.length + 1 : i + 1;
};

function acquire(who, waitMs) {
	tick();
	if (holder && holder.id === who.id) return Promise.resolve(true);
	if (!holder && queue.length === 0) {
		// expiry is set when the call finishes (a running call never expires); lease_hold sets its own
		holder = { ...who, since: now(), expiresAt: now(), inflight: 0 };
		if (!who.transient) log("lease_acquired", who);
		return Promise.resolve(true);
	}
	let entry = queue.find((q) => q.who.id === who.id);
	if (!entry) queue.push((entry = { who, ticketUntil: 0, waiters: [] }));
	entry.ticketUntil = now() + waitMs + (who.transient ? 0 : TICKET);
	if (waitMs <= 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		const w = (ok) => { clearTimeout(timer); resolve(ok); };
		const timer = setTimeout(() => {
			entry.waiters = entry.waiters.filter((x) => x !== w);
			if (who.transient) queue.splice(queue.indexOf(entry), 1);
			resolve(false);
		}, waitMs);
		entry.waiters.push(w);
	});
}

function busyText(who) {
	const busy = holder ? Math.round((now() - holder.since) / 1000) : 0;
	const left = holder ? Math.max(0, Math.round((holder.expiresAt - now()) / 1000)) : 0;
	return `手机正在被另一个任务使用（已占用 ${busy} 秒，若对方不再操作最晚约 ${left} 秒后释放）。` +
		(who.transient ? "" : `你排在第 ${position(who)} 位；对方占着期间位置保留 ${TICKET / 1000} 秒，手机空出来时你若没有在等的调用就不再保留（先到先得）。`) +
		"不要改用别的方式操作手机；稍后重试同一个操作，或先告诉用户手机正被占用、问要不要等。";
}

const toolResult = (id, text, isError = false) =>
	({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });

function sendJson(res, msg) {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(msg));
}

function forward(req, body, res, { rewrite, dropHeaders = [], onHeaders } = {}) {
	const headers = { ...req.headers, host: UPSTREAM.host };
	delete headers["content-length"];
	for (const h of dropHeaders) delete headers[h];
	return new Promise((resolve) => {
		// agent: false = a fresh loopback connection per request; reusing a keep-alive socket after mobile-mcp's
		// (stateless) SSE reply got an empty 400 on the next request
		const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: UPSTREAM.pathname, agent: false,
			method: req.method, headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (ur) => {
			if (onHeaders) onHeaders(ur.headers);
			if (!rewrite) {
				res.writeHead(ur.statusCode, ur.headers);
				ur.pipe(res);
				ur.on("end", resolve);
				return;
			}
			let data = "";
			ur.on("data", (c) => (data += c));
			ur.on("end", () => {
				const h = { ...ur.headers };
				delete h["content-length"];
				res.writeHead(ur.statusCode, h);
				res.end(rewrite(data, ur.headers["content-type"] || ""));
				resolve();
			});
		});
		up.on("error", (e) => {
			if (!res.headersSent) res.writeHead(502);
			res.end(String(e.message));
			resolve();
		});
		if (body) up.write(body);
		up.end();
	});
}

// tools/list: optional `lease` argument on every phone tool + the lease tools, keeping the upstream framing
function patchTools(data, ctype) {
	const patch = (msg) => {
		if (msg.result && Array.isArray(msg.result.tools)) {
			for (const t of TOKENS ? msg.result.tools : []) {
				t.inputSchema = t.inputSchema || { type: "object", properties: {} };
				t.inputSchema.properties = { ...(t.inputSchema.properties || {}), lease: LEASE_PARAM };
			}
			msg.result.tools.push(...LEASE_TOOLS.filter((t) => TOKENS || t.name !== "lease_acquire"));
		}
		return msg;
	};
	if (ctype.includes("text/event-stream")) {
		return data.replace(/^data: (.*)$/m, (_, j) => "data: " + JSON.stringify(patch(JSON.parse(j))));
	}
	return JSON.stringify(patch(JSON.parse(data)));
}

async function onToolCall(req, res, msg) {
	const tool = msg.params && msg.params.name;
	const args = { ...((msg.params && msg.params.arguments) || {}) };
	const who = resolveHolder(req, args);
	// a stale / made-up token only matters when nothing else identifies the caller
	const badToken = TOKENS && who.via === "anon" && typeof args.lease === "string" && args.lease !== "";
	delete args.lease; // never reaches mobile-mcp
	if (tool === "lease_status") {
		tick();
		const text = !holder ? `手机空闲（排队 ${queue.length}）。你被识别为：${who.via}。`
			: holder.id === who.id ? `你持有手机，剩约 ${Math.max(0, Math.round((holder.expiresAt - now()) / 1000))} 秒（每次调用手机工具都会续期）。`
				: busyText(who);
		return sendJson(res, toolResult(msg.id, text));
	}
	if (tool === "lease_acquire" && TOKENS) {
		if (who.via !== "anon") {
			return sendJson(res, toolResult(msg.id, "不需要租约号：已经能识别你的会话，直接调用手机工具即可（会自动占用 / 排队）。"));
		}
		const token = crypto.randomBytes(6).toString("hex");
		const tw = { id: "token:" + token, via: "token" };
		tokens.set(token, now());
		if (!(await acquire(tw, WAIT))) {
			log("acquire_refused_busy", tw);
			return sendJson(res, toolResult(msg.id, busyText(tw) + `（租约号 ${token} 已排队，重试时把它填进 lease 参数）`, true));
		}
		holder.expiresAt = Math.max(holder.expiresAt, now() + IDLE);
		log("lease_acquired_token", tw);
		return sendJson(res, toolResult(msg.id, `已占用手机。租约号：${token}。之后每次调用手机工具都在 lease 参数里填它；做完调用 lease_release。`));
	}
	if (tool === "lease_release") {
		if (holder && holder.id === who.id) {
			log("lease_released", who, { held_ms: now() - holder.since });
			if (who.via === "token") tokens.delete(who.id.slice(6));
			holder = null;
			tick();
		}
		const i = queue.findIndex((q) => q.who.id === who.id);
		if (i >= 0 && queue[i].waiters.length === 0) queue.splice(i, 1);
		return sendJson(res, toolResult(msg.id, "已释放手机。"));
	}
	if (tool === "lease_hold") {
		if (who.transient) return sendJson(res, toolResult(msg.id, "无法识别你的会话，先调用 lease_acquire 拿租约号。", true));
		const ms = Math.min(HOLD_MAX, Math.max(1, Number(args.seconds) || 0) * 1000);
		if (!(await acquire(who, 0))) {
			log("hold_refused_busy", who);
			return sendJson(res, toolResult(msg.id, busyText(who), true));
		}
		holder.expiresAt = Math.max(holder.expiresAt, now() + ms);
		log("lease_hold", who, { seconds: ms / 1000 });
		return sendJson(res, toolResult(msg.id, `已为当前任务保留手机 ${ms / 1000} 秒；期间别的任务会排队。用户回来后照常继续。`));
	}
	if (badToken) {
		return sendJson(res, toolResult(msg.id, "租约号无效或已过期：不填 lease 参数重试；若仍提示无法识别会话，再调用 lease_acquire。", true));
	}
	const t0 = now();
	if (!(await acquire(who, WAIT))) {
		log("call_refused_busy", who, { tool, wait_ms: now() - t0, position: who.transient ? undefined : position(who) });
		return sendJson(res, toolResult(msg.id, busyText(who), true));
	}
	const waited = now() - t0;
	holder.inflight++;
	try {
		await callPhone(req, res, msg, tool, args, (event, extra) => log(event, who, extra));
	} finally {
		if (holder && holder.id === who.id) {
			holder.inflight--;
			let idle = IDLE;
			if (who.via === "session") {
				const n = (seenClients.get(who.id) || 0) + 1;
				seenClients.set(who.id, n);
				if (n === 1) idle = FIRST_IDLE;
			}
			holder.expiresAt = holder.transient ? now() : Math.max(holder.expiresAt, now() + idle);
		}
		log("call", who, { tool, wait_ms: waited, total_ms: now() - t0 });
		tick();
	}
}

// one buffered upstream request -> {status, headers, data}
function upstream(req, body) {
	const headers = { ...req.headers, host: UPSTREAM.host, "content-length": Buffer.byteLength(body) };
	return new Promise((resolve) => {
		const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: UPSTREAM.pathname, agent: false,
			method: "POST", headers }, (ur) => {
			let data = "";
			ur.on("data", (c) => (data += c));
			ur.on("end", () => resolve({ status: ur.statusCode, headers: ur.headers, data }));
		});
		up.on("error", (e) => resolve({ status: 502, headers: {}, data: String(e.message) }));
		up.write(body);
		up.end();
	});
}

// the JSON-RPC message inside an upstream reply (SSE or plain JSON), and a writer that keeps the framing
function unwrap(data) {
	const m = data.match(/^data: (.*)$/m);
	try { return m ? JSON.parse(m[1]) : JSON.parse(data); } catch { return null; }
}
const rewrap = (data, msg) => (/^data: /m.test(data) ? data.replace(/^data: .*$/m, () => "data: " + JSON.stringify(msg)) : JSON.stringify(msg));
const resultText = (msg) => ((msg && msg.result && msg.result.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// a phone tool call: screen on first (PHONE_WAKE), one recovery + retry when a read-only call finds no UI hierarchy,
// element lists trimmed (ELEMENTS_TRIM). With both switches off this is a plain pass-through.
async function callPhone(req, res, msg, tool, args, log) {
	const body = JSON.stringify({ ...msg, params: { ...msg.params, arguments: args } });
	if (!screen.WAKE && !screen.TRIM) return forward(req, body, res);
	const awake = await screen.ensureAwake(tool, log);
	if (!awake.ok) return sendJson(res, toolResult(msg.id, screen.WAKE_FAILED(awake.detail), true));
	let r = await upstream(req, body);
	let out = unwrap(r.data);
	if (screen.WAKE && screen.RETRYABLE.has(tool) && screen.NO_UI.test(resultText(out) + JSON.stringify((out && out.error) || ""))) {
		await screen.recover(log);
		r = await upstream(req, body);
		out = unwrap(r.data);
		if (screen.NO_UI.test(resultText(out) + JSON.stringify((out && out.error) || ""))) {
			log("screen_still_no_ui", { tool });
			return sendJson(res, toolResult(msg.id, screen.WAKE_FAILED("点亮后仍读不到界面（可能被遮挡，或是不允许读取的安全页面）"), true));
		}
	}
	if (out && out.result && !out.result.isError) {
		screen.markAwake();
		if (screen.TRIM && (tool === "mobile_list_elements_on_screen" || tool === "mobile_batch_commands") && args.format !== "json") {
			for (const c of out.result.content || []) if (c.type === "text") c.text = screen.trimElements(c.text);
		}
	}
	const h = { ...r.headers };
	delete h["content-length"];
	res.writeHead(r.status, h);
	res.end(out ? rewrap(r.data, out) : r.data);
}

http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", async () => {
		let msg = null;
		if (req.method === "POST" && body) {
			try { msg = JSON.parse(body); } catch { msg = null; }
		}
		if (msg && msg.method === "initialize") {
			// LiteLLM forwards the client's session id here (and only here): remember upstream -> client, strip it
			const client = String(req.headers["mcp-session-id"] || "").trim();
			return forward(req, body, res, { dropHeaders: ["mcp-session-id"], onHeaders: (h) => {
				if (client && h["mcp-session-id"]) sessions.set(h["mcp-session-id"], { client, at: now() });
			} });
		}
		if (msg && msg.method === "tools/call") return onToolCall(req, res, msg);
		if (msg && msg.method === "tools/list") return forward(req, body, res, { rewrite: patchTools });
		if (req.method === "DELETE") sessions.delete(String(req.headers["mcp-session-id"] || ""));
		return forward(req, body || null, res);
	});
}).listen(LISTEN, process.env.LEASE_HOST || "0.0.0.0", () =>
	log("listening", null, { port: LISTEN, upstream: UPSTREAM.href, idle_s: IDLE / 1000, wait_s: WAIT / 1000,
		first_idle_s: FIRST_IDLE / 1000, tokens: TOKENS }));
