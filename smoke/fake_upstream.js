// A stand-in for mobile-mcp's stateless Streamable HTTP endpoint, so smoke/lease_test.py can run against gateway.js
// without docker or a phone (see smoke/run_lease_local.sh). 33 tools like the real one; every call answers "ok".
"use strict";
const http = require("node:http");

const PORT = Number(process.env.FAKE_UPSTREAM_PORT || 8932);
const tools = Array.from({ length: 33 }, (_, i) => ({
	name: i === 0 ? "mobile_list_available_devices" : `mobile_fake_tool_${i}`,
	description: "fake",
	inputSchema: { type: "object", properties: {} },
}));

const sse = (res, msg) => {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	res.end(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
};

http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		let msg = null;
		try { msg = JSON.parse(body); } catch { msg = null; }
		if (!msg || msg.id === undefined) { res.writeHead(202); return res.end(); }
		if (msg.method === "initialize") {
			return sse(res, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} },
				serverInfo: { name: "fake-mobile-mcp", version: "0" } } });
		}
		if (msg.method === "tools/list") return sse(res, { jsonrpc: "2.0", id: msg.id, result: { tools } });
		if (msg.method === "tools/call") {
			return sse(res, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
		}
		return sse(res, { jsonrpc: "2.0", id: msg.id, result: {} });
	});
}).listen(PORT, "127.0.0.1");
