import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.ARGON_HOME = mkdtempSync(join(tmpdir(), "argon-mcp-"));
const core = await import("../dist/core/index.js");

test("connects to a stdio MCP server and calls its tool", async () => {
	core.updateSettings({ mcp: { servers: { echo: { command: process.execPath, args: [resolve("test/fixtures/echo-mcp.mjs")] } } } });
	await core.syncMcp();
	const st = core.mcpStatus();
	assert.equal(st[0].status, "connected", st[0].error);
	const tool = core.mcpTools().find((t) => t.name === "mcp__echo__shout");
	assert.ok(tool);
	const res = await tool.execute("1", { text: "argon" });
	assert.equal(res.content[0].text, "ARGON!");
	await core.closeMcp();
});
