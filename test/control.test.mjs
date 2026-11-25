// AI agent control: the tools, their permission groups, and Argon as an MCP server (HTTP and stdio).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "argon-ctl-"));
process.env.ARGON_HOME = home;
const core = await import("../dist/core/index.js");
const { startServer } = await import("../dist/server/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const MAIN = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const ctx = {};
const settingsFile = () => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));

test("off by default: no tools, every call refused", async () => {
	assert.equal(core.loadSettings().agentControl.enabled, false);
	assert.equal(core.allowedControlTools().length, 0);
	const r = await core.callControlTool("set_appearance", { palette: "neon" }, ctx);
	assert.ok(r.isError);
	assert.match(r.text, /turned off/);
});

test("tools change Argon, inside the allowed groups only", async () => {
	core.updateSettings({ agentControl: { enabled: true } });
	const names = core.allowedControlTools().map((t) => t.name);
	for (const n of ["set_appearance", "create_agent", "add_connector", "start_session"]) assert.ok(names.includes(n), n);
	assert.ok(!names.includes("set_permission_mode"), "security is off by default");

	let r = await core.callControlTool("set_appearance", { palette: "neon", theme: "light", size: 112 }, ctx);
	assert.ok(!r.isError, r.text);
	assert.equal(core.loadSettings().appearance.seed, "#ff4b2b");
	assert.equal(core.loadSettings().appearance.scale, 110, "size snaps to 5%");
	assert.equal(core.loadSettings().general.theme, "light");

	r = await core.callControlTool("create_agent", { name: "Translator", description: "Translates text", prompt: "Translate.", tools: ["read"] }, ctx);
	assert.ok(!r.isError, r.text);
	assert.ok(core.listAgents(home, core.loadSettings()).some((a) => a.name === "translator"));

	r = await core.callControlTool("add_connector", { name: "files", command: "npx", args: ["-y", "some-server"], env: { TOKEN: "secret" } }, ctx);
	assert.ok(!r.isError, r.text);
	assert.deepEqual(core.loadSettings().mcp.servers.files.args, ["-y", "some-server"]);
	const shown = await core.callControlTool("get_settings", { section: "mcp" }, ctx);
	assert.ok(!shown.text.includes("secret"), "secrets are hidden");

	r = await core.callControlTool("update_settings", { changes: { permissions: { mode: "auto" } } }, ctx);
	assert.ok(r.isError, "permissions need the security group");
	r = await core.callControlTool("update_settings", { changes: { agentControl: { allow: { security: true } } } }, ctx);
	assert.ok(r.isError, "agentControl is the user's");
	r = await core.callControlTool("update_settings", { changes: { general: { userName: "Ada" } } }, ctx);
	assert.ok(!r.isError, r.text);
	assert.equal(core.loadSettings().general.userName, "Ada");

	r = await core.callControlTool("start_session", { prompt: "hi" }, {});
	assert.ok(r.isError, "sessions need a running server");
	r = await core.callControlTool("remove_connector", { name: "files" }, ctx);
	assert.ok(!r.isError);
	assert.equal(core.loadSettings().mcp.servers.files, undefined);
});

test("MCP over HTTP: token required, tools listed and called", async () => {
	const srv = await startServer({ port: 0, open: false });
	const base = new URL(srv.url).origin;
	try {
		const s = core.ensureControlToken();
		assert.ok(s.agentControl.token.length > 20, "a token is generated once control is on");
		let res = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		assert.equal(res.status, 401);
		res = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Authorization: `Bearer ${s.agentControl.token}` }, body: "{}" });
		assert.equal(res.status, 403, "browsers are kept out");

		const client = new Client({ name: "test", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${s.agentControl.token}` } } }));
		const { tools } = await client.listTools();
		assert.ok(tools.some((t) => t.name === "set_appearance"));
		assert.equal(tools.find((t) => t.name === "list_sessions").annotations.readOnlyHint, true);
		const r = await client.callTool({ name: "set_appearance", arguments: { palette: "chromium" } });
		assert.ok(!r.isError, JSON.stringify(r));
		assert.equal(settingsFile().appearance.seed, "#2e9d5b");
		await client.close();

		core.updateSettings({ agentControl: { enabled: false } });
		res = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.agentControl.token}` }, body: "{}" });
		assert.equal(res.status, 403, "turned off again: refused");
		core.updateSettings({ agentControl: { enabled: true } });
	} finally {
		srv.close();
	}
});

test("argon mcp serve: stdio MCP server (own core when the app isn't running)", async () => {
	const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "serve"], env: { ...process.env, ARGON_HOME: home }, stderr: "pipe" });
	const client = new Client({ name: "test", version: "1" });
	await client.connect(transport);
	try {
		const info = client.getServerVersion();
		assert.equal(info.name, "argon");
		const { tools } = await client.listTools();
		assert.ok(tools.length >= 20, `${tools.length} tools`);
		const r = await client.callTool({ name: "set_appearance", arguments: { color: "#123456", shapes: "round" } });
		assert.ok(!r.isError, JSON.stringify(r));
		assert.equal(settingsFile().appearance.seed, "#123456");
		assert.equal(settingsFile().appearance.radius, "round");
		const list = await client.callTool({ name: "list_sessions", arguments: {} });
		assert.ok(!list.isError);
	} finally {
		await client.close();
	}
});

test("fixed HTTP port and the built-in connector for Argon's own agent", async () => {
	const srv = await startServer({ port: 0, open: false, controlPort: true });
	const u = new URL(srv.url);
	const api = (path, body, method = "PUT") => fetch(`${u.origin}/api${path}`, { method, headers: { "Content-Type": "application/json", "X-Argon-Token": u.searchParams.get("t") }, body: body && JSON.stringify(body) }).then((r) => r.json());
	try {
		const free = 40000 + Math.floor(Math.random() * 9000);
		const s = core.loadSettings();
		s.agentControl.port = free;
		await api("/settings", s);
		await new Promise((r) => setTimeout(r, 300));
		const info = await api("/agent-control", undefined, "GET");
		assert.equal(info.http.url, `http://127.0.0.1:${free}/mcp`);
		assert.equal(info.http.listening, true, JSON.stringify(info.http));
		assert.equal(info.tools.length, 32);
		const client = new Client({ name: "test", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL(info.http.url), { requestInit: { headers: { Authorization: `Bearer ${info.token}` } } }));
		assert.ok((await client.listTools()).tools.length >= 20);
		await client.close();

		// Argon's own agent: the same tools as mcp__argon__*, listed as a built-in connector.
		const sess = await core.ArgonSession.create({ cwd: home, mode: "ask" });
		const names = sess.buildTools().map((t) => t.name);
		assert.ok(names.includes("mcp__argon__set_appearance"));
		assert.equal(core.builtinConnectorStatus().status, "connected");
		const st = core.loadSettings();
		st.agentControl.builtin = false;
		await api("/settings", st);
		assert.ok(!sess.buildTools().some((t) => t.name.startsWith("mcp__argon__")), "connector off: no tools");
	} finally {
		srv.close();
	}
	assert.equal(core.builtinConnectorStatus().status, "disabled", "no server, no built-in tools");
});
