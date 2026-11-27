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
// Usage guide (guide/*.md, shipped in the image; GUIDE_DIR overrides): phone_guide(topic?) returns the core guide or one
// topic. A holder's first phone call (again after GUIDE_TTL_S) gets the core guide appended to its result, unless it read
// it with phone_guide() within that time; never blocks. Numbers in the guide are {{placeholders}} filled from the lease
// settings below, so they are written in one place only.
//
// Logs (stderr, JSON lines): time, event, holder hash, via, tool, wait ms. Never arguments, results or raw ids.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const screen = require("./screen.js");

const env = (k, d) => Number(process.env[k] || d);
const LISTEN = env("LEASE_PORT", 8931);
const UPSTREAM = new URL(process.env.LEASE_UPSTREAM || "http://127.0.0.1:8932/mcp");
const IDLE = env("LEASE_IDLE_S", 120) * 1000;
const WAIT = env("LEASE_WAIT_S", 45) * 1000;
const TICKET = env("LEASE_TICKET_S", 90) * 1000;
const GRACE = env("LEASE_GRACE_S", 30) * 1000;
const HOLD_MAX = env("LEASE_HOLD_MAX_S", 120) * 1000;
const SESSION_TTL = env("LEASE_SESSION_MAP_TTL_S", 3600) * 1000;
// a client session seen for the first time may be a caller that opens a new session per call (a script, or OWUI
// without the chat id header): its lease is short until a second call shows the session persists
const FIRST_IDLE = env("LEASE_SESSION_FIRST_IDLE_S", 30) * 1000;
// level 4 (lease_acquire + optional `lease` argument on every tool) changes the tool schemas: off unless asked for
const TOKENS = process.env.LEASE_TOKENS === "1";
const GUIDE_DIR = process.env.GUIDE_DIR || path.join(__dirname, "guide");
const GUIDE_TTL = env("GUIDE_TTL_S", 1800) * 1000;

// guide/core.md = what every holder gets; every other <name>.md is a topic (app-<id>.md -> "app:<id>")
const GUIDE_VARS = { LEASE_IDLE_S: IDLE / 1000, LEASE_HOLD_MAX_S: HOLD_MAX / 1000, LEASE_WAIT_S: WAIT / 1000 };
function loadGuide(dir) {
	let files;
	try { files = fs.readdirSync(dir).filter((f) => /^[a-z0-9-]+\.md$/.test(f)).sort(); } catch { return null; }
	const topics = new Map(); // topic -> {title, short, text}
	for (const f of files) {
		const text = fs.readFileSync(path.join(dir, f), "utf8")
			.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in GUIDE_VARS ? String(GUIDE_VARS[k]) : m)).trim();
		const base = f.slice(0, -3);
		const title = ((text.match(/^# (.+)$/m) || [])[1] || base).trim();
		topics.set(base.startsWith("app-") ? "app:" + base.slice(4) : base, { title, short: title.split(/[（(]/)[0].trim(), text });
	}
	return topics.has("core") ? topics : null;
}
const GUIDE = loadGuide(GUIDE_DIR);
const GUIDE_TOPICS = GUIDE ? [...GUIDE.keys()].filter((t) => t !== "core") : [];
const GUIDE_INDEX = GUIDE_TOPICS.map((t) => `- ${t}：${GUIDE.get(t).title}`).join("\n");

// topic: empty / "core" = the core guide; else a topic key ("captcha", "app:taobao"), case-insensitive, with or
// without "app:", or an app's name as in its title ("淘宝")
function findTopic(topic) {
	const t = String(topic || "").trim().toLowerCase();
	if (!t || t === "core") return "core";
	const bare = t.replace(/^app[:：]\s*/, "");
	for (const k of [t, "app:" + bare, bare]) if (GUIDE.has(k)) return k;
	return GUIDE_TOPICS.find((k) => GUIDE.get(k).short.toLowerCase() === bare) || null;
}
function guideText(topic) {
	if (!GUIDE) return { text: `手机使用说明没有加载（${GUIDE_DIR} 里没有 core.md）。按一般常识谨慎操作，不下单、不付款。`, isError: true };
	const k = findTopic(topic);
	if (!k) return { text: `没有这一部分：${String(topic)}。可用的 topic：\n${GUIDE_INDEX}`, isError: true };
	if (k === "core") return { key: k, text: `${GUIDE.get("core").text}\n\n## 按需再读：phone_guide(topic=…)\n\n${GUIDE_INDEX}` };
	return { key: k, text: `${GUIDE.get(k).text}\n\n---\n核心说明：phone_guide()；其它部分：${GUIDE_TOPICS.join(" / ")}` };
}
const GUIDE_APPENDIX = GUIDE ? "\n\n======== 手机使用说明（核心）：本会话第一次调用手机工具时附上，先读完再继续；" +
	"之后可用 phone_guide 重读，某一部分用 phone_guide(topic=…) ========\n\n" + guideText("").text : null;
const guideSeen = new Map(); // holder id -> when it last got the core guide
const needsGuide = (who) => !!GUIDE && !who.transient && now() - (guideSeen.get(who.id) || 0) > GUIDE_TTL;

const LEASE_PARAM = {
	type: "string",
	description: "只在你用 lease_acquire 拿到了租约号时才填（原样回传）；其它情况不要填。",
};
const LEASE_TOOLS = [
	{ name: "lease_status", description: "手机现在是否空闲：你是否持有、别的任务占用了多久、你排第几。不操作手机。",
		inputSchema: { type: "object", properties: {} } },
	{ name: "lease_acquire", description: "显式占用手机并拿到租约号。只有在手机工具提示「无法识别你的会话」时才需要：之后每次调用手机工具都把租约号填进 lease 参数。",
		inputSchema: { type: "object", properties: {} } },
	{ name: "lease_hold", description: `同一轮里等用户在手机上点一下时，为当前任务保留手机，最多 ${HOLD_MAX / 1000} 秒。` +
		"不要用它跨轮保留：要等用户扫码、看验证码、回复你时，先 lease_release 再回复，下一轮重新拿。",
		inputSchema: { type: "object", properties: { seconds: { type: "number", description: `保留秒数，1–${HOLD_MAX / 1000}` },
			lease: LEASE_PARAM }, required: ["seconds"] } },
	{ name: "lease_release", description: "回复用户之前调用（做完、失败、放弃或要等用户时都一样），立刻释放手机，让排队的任务继续。只能释放自己持有的；" +
		"手机被别人的 lease_hold 保留占着（例如上一轮对话留下的）时，只有用户明确要求清理才传 force=true 强制结束那个保留，" +
		"正在操作手机的人不会被强制释放。",
		inputSchema: { type: "object", properties: { force: { type: "boolean",
			description: "仅用户明确要求清理时才填 true：强制结束别人留下的 lease_hold 保留（不影响正在操作的人）" }, lease: LEASE_PARAM } } },
];

const GUIDE_TOOL = { name: "phone_guide", description: "手机使用说明：硬规则、调用顺序、占用规则、各 App 怎么操作。操作手机之前先调用一次" +
	"（不填 topic = 核心说明），需要时再读某一部分。不操作手机，也不占用手机。",
	inputSchema: { type: "object", properties: { topic: { type: "string", description: "不填 = 核心说明。可选：" +
		GUIDE_TOPICS.map((t) => `${t}（${GUIDE.get(t).short}）`).join(" / ") } } } };

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
		if (!holder.transient) log("lease_expired", holder, { held_ms: t - holder.since, hold: !!holder.held });
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
	for (const [k, t] of guideSeen) if (now() - t > GUIDE_TTL) guideSeen.delete(k);
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

// what the current holder is doing, for the busy / status / release texts: an explicit lease_hold (waiting for a user,
// possibly left by an earlier turn of the SAME task under another client session id) or simply working
const holderKind = () => (holder && holder.held
	? `对方是用 lease_hold 保留的（在等用户操作，还剩约 ${Math.max(0, Math.round((holder.expiresAt - now()) / 1000))} 秒；` +
		"如果是你上一轮对话留下的，换了一轮会话号就认不出你，只能等它到期，或由用户要求后用 lease_release 传 force=true 清理）。"
	: "");

function busyText(who) {
	const busy = holder ? Math.round((now() - holder.since) / 1000) : 0;
	const left = holder ? Math.max(0, Math.round((holder.expiresAt - now()) / 1000)) : 0;
	return `手机正在被另一个任务使用（已占用 ${busy} 秒，若对方不再操作最晚约 ${left} 秒后释放）。${holderKind()}` +
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
			msg.result.tools.push(...(GUIDE ? [GUIDE_TOOL] : []), ...LEASE_TOOLS.filter((t) => TOKENS || t.name !== "lease_acquire"));
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
	if (tool === "phone_guide") { // no phone, no lease
		const g = guideText(args.topic);
		if (g.key === "core") guideSeen.set(who.id, now());
		if (!who.transient) log("guide", who, { topic: g.key || "unknown" });
		return sendJson(res, toolResult(msg.id, g.text, !!g.isError));
	}
	if (tool === "lease_status") {
		tick();
		const text = !holder ? `手机空闲（排队 ${queue.length}）。你被识别为：${who.via}。`
			: holder.id === who.id ? `你持有手机${holder.held ? "（lease_hold 保留）" : ""}，剩约 ${Math.max(0, Math.round((holder.expiresAt - now()) / 1000))} 秒（每次调用手机工具都会续期）。`
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
		tick();
		const i = queue.findIndex((q) => q.who.id === who.id);
		if (i >= 0 && queue[i].waiters.length === 0) queue.splice(i, 1);
		if (holder && holder.id === who.id) {
			log("lease_released", who, { held_ms: now() - holder.since });
			if (who.via === "token") tokens.delete(who.id.slice(6));
			holder = null;
			tick();
			return sendJson(res, toolResult(msg.id, "已释放手机。"));
		}
		if (!holder) return sendJson(res, toolResult(msg.id, "手机本来就是空闲的，没有需要释放的。"));
		// someone else holds it. Say so instead of "released": a new turn of the same task can carry another client session id
		// and is then a stranger to its own earlier hold. `force` ends a HOLD only (a caller that is merely working expires by
		// itself within LEASE_IDLE_S, and ending it would cut a task off in the middle of its steps).
		if (args.force === true) {
			if (holder.held && holder.inflight === 0) {
				log("lease_force_released", holder, { by: hash(who.id), held_ms: now() - holder.since });
				if (holder.via === "token") tokens.delete(holder.id.slice(6));
				holder = null;
				tick();
				// tick() may already have handed the phone to a caller waiting in the queue: do not claim it is free
				return sendJson(res, toolResult(msg.id, "已强制结束别人留下的保留。" +
					(holder ? "手机已交给排队在前面的任务，你要用就照常调用手机工具排队。" : "")));
			}
			return sendJson(res, toolResult(msg.id, "不能强制释放：对方不是在保留，而是正在操作手机，最晚约 " +
				`${Math.max(0, Math.round((holder.expiresAt - now()) / 1000))} 秒后会自己释放。`, true));
		}
		return sendJson(res, toolResult(msg.id, "你当前没有持有手机，没有可释放的东西，对方的占用没有变化。" + holderKind(), true));
	}
	if (tool === "lease_hold") {
		if (who.transient) return sendJson(res, toolResult(msg.id, "无法识别你的会话，先调用 lease_acquire 拿租约号。", true));
		const ms = Math.min(HOLD_MAX, Math.max(1, Number(args.seconds) || 0) * 1000);
		if (!(await acquire(who, 0))) {
			log("hold_refused_busy", who);
			return sendJson(res, toolResult(msg.id, busyText(who), true));
		}
		holder.expiresAt = Math.max(holder.expiresAt, now() + ms);
		holder.held = true;
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
		const appendix = needsGuide(who) ? GUIDE_APPENDIX : null;
		if (await callPhone(req, res, msg, tool, args, (event, extra) => log(event, who, extra), appendix)) {
			guideSeen.set(who.id, now());
			log("guide_appended", who, { tool });
		}
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
// element lists trimmed (ELEMENTS_TRIM), `appendix` (the core guide) added after the result. With both switches off and
// no appendix this is a plain pass-through. Returns true when the appendix went out.
async function callPhone(req, res, msg, tool, args, log, appendix) {
	const body = JSON.stringify({ ...msg, params: { ...msg.params, arguments: args } });
	if (!screen.WAKE && !screen.TRIM && !appendix) { await forward(req, body, res); return false; }
	const awake = await screen.ensureAwake(tool, log);
	if (!awake.ok) { sendJson(res, toolResult(msg.id, screen.WAKE_FAILED(awake.detail), true)); return false; }
	let r = await upstream(req, body);
	let out = unwrap(r.data);
	const failed = (o) => !o || o.error || (o.result && o.result.isError);
	if (screen.WAKE && screen.RETRYABLE.has(tool) && failed(out)
		&& await screen.recover(resultText(out) + JSON.stringify((out && out.error) || ""), log)) {
		r = await upstream(req, body);
		out = unwrap(r.data);
		if (failed(out)) {
			log("screen_still_failing", { tool });
			sendJson(res, toolResult(msg.id, screen.WAKE_FAILED("点亮后仍读不到界面（可能被遮挡，或是不允许读取的安全页面）"), true));
			return false;
		}
	}
	if (out && out.result && !out.result.isError) {
		if (screen.TRIM && (tool === "mobile_list_elements_on_screen" || tool === "mobile_batch_commands") && args.format !== "json") {
			for (const c of out.result.content || []) if (c.type === "text") c.text = screen.trimElements(c.text);
		}
	}
	const appended = !!(appendix && out && out.result);
	if (appended) out.result.content = [...(out.result.content || []), { type: "text", text: appendix }];
	const h = { ...r.headers };
	delete h["content-length"];
	res.writeHead(r.status, h);
	res.end(out ? rewrap(r.data, out) : r.data);
	return appended;
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
		first_idle_s: FIRST_IDLE / 1000, hold_max_s: HOLD_MAX / 1000, tokens: TOKENS,
		guide: GUIDE ? GUIDE.size : "missing", guide_ttl_s: GUIDE_TTL / 1000 }));
