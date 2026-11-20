import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARGON_HOME = mkdtempSync(join(tmpdir(), "argon-core2-"));
const root = mkdtempSync(join(tmpdir(), "argon-env-"));
mkdirSync(join(root, "sub"), { recursive: true });
const pi = await import("@mariozechner/pi-ai");
const core = await import("../dist/core/index.js");

test("sandbox: writes outside the environment always ask, even in auto", () => {
	const s = core.loadSettings();
	const sb = { root, cwd: root };
	assert.equal(core.decide("auto", s, "write", { path: "sub/a.txt" }, [], sb).decision, "allow", "subfolders are inside");
	const out = core.decide("auto", s, "write", { path: join(tmpdir(), "elsewhere.txt") }, [], sb);
	assert.equal(out.decision, "ask");
	assert.equal(out.reason, "outside");
	assert.equal(core.decide("auto", s, "edit", { path: "../x.ts" }, [], sb).decision, "ask");
	// bash heuristics
	assert.equal(core.decide("auto", s, "bash", { command: "npm test" }, [], sb).decision, "allow");
	assert.equal(core.decide("auto", s, "bash", { command: "cat C:/Windows/win.ini" }, [], sb).decision, "allow", "reading is fine");
	assert.equal(core.decide("auto", s, "bash", { command: `rm -rf "${join(tmpdir(), "x")}"` }, [], sb).decision, "ask");
	assert.equal(core.decide("auto", s, "bash", { command: "echo hi > ../out.txt" }, [], sb).decision, "ask");
	// "always" for that folder
	const allow = [core.outsideRule(join(tmpdir(), "elsewhere.txt"))];
	assert.equal(core.decide("auto", s, "write", { path: join(tmpdir(), "other.txt") }, allow, sb).decision, "allow");
	// no environment → no sandbox
	assert.equal(core.decide("auto", s, "write", { path: join(tmpdir(), "z.txt") }, [], { cwd: root }).decision, "allow");
	// can be turned off
	assert.equal(core.decide("auto", { ...s, permissions: { ...s.permissions, sandbox: false } }, "write", { path: join(tmpdir(), "z.txt") }, [], sb).decision, "allow");
});

test("sub-agent costs count in the session total and are itemised", async () => {
	const faux = pi.registerFauxProvider({ provider: "fx", models: [{ id: "m", cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } }] });
	core.updateSettings({ model: { default: "fx/m" }, general: { autoTitle: false }, providers: { customModels: [] } });
	// custom provider models have zero price, so register the faux model as a catalogued one
	const env = core.addEnvironment("sbx", root);
	faux.setResponses([
		pi.fauxAssistantMessage([pi.fauxToolCall("task", { agent: "explore", description: "d", prompt: "p" })], { stopReason: "toolUse" }),
		pi.fauxAssistantMessage(pi.fauxText("report")),
		pi.fauxAssistantMessage(pi.fauxText("done")),
	]);
	core.updateSettings({ providers: { custom: [{ id: "fx", name: "fx", baseUrl: "http://localhost", api: faux.api, models: ["m"], noAuth: true }] } });
	const s = await core.ArgonSession.create({ cwd: root, envId: env.id, mode: "auto" });
	await s.prompt("go");
	const d = core.usageDetail("all", s.id);
	const sub = d.byAgent.find((a) => a.agent === "explore");
	assert.ok(sub && sub.calls === 1, "sub-agent call recorded with its name");
	const main = d.byAgent.find((a) => a.agent === "main");
	assert.equal(main.calls, 2);
	assert.equal(d.totals.calls, 3, "total includes the sub-agent");
	assert.equal(core.sessionUsage(s.id).tokens, d.totals.tokens);
	assert.ok(d.rows[0].agents.includes("explore"));
});

test("background processes are tracked, readable and killable", async () => {
	const changes = [];
	const bg = new core.BackgroundManager(root, () => changes.push(1));
	const p = bg.start("node -e \"setInterval(()=>console.log('tick'),50)\"");
	await new Promise((r) => setTimeout(r, 600));
	const out = bg.read(p.id);
	assert.match(out.output, /tick/);
	assert.equal(bg.running(), 1);
	assert.ok(bg.kill(p.id));
	await new Promise((r) => setTimeout(r, 800));
	assert.equal(bg.list()[0].status, "killed");
	assert.ok(changes.length >= 2);
});

test("settings changed by another process are picked up", async () => {
	const s = core.loadSettings();
	const file = join(process.env.ARGON_HOME, "settings.json");
	const raw = JSON.parse(readFileSync(file, "utf8"));
	raw.general.userName = "FromOtherProcess";
	await new Promise((r) => setTimeout(r, 450));
	writeFileSync(file, JSON.stringify(raw));
	await new Promise((r) => setTimeout(r, 450));
	assert.equal(core.loadSettings().general.userName, "FromOtherProcess");
	void s;
});

test("init file is configurable and read as project instructions", () => {
	core.updateSettings({ context: { initFile: "AI_NOTES.md" } });
	writeFileSync(join(root, "AI_NOTES.md"), "Use tabs.");
	assert.ok(core.projectContextFiles(root, core.loadSettings()).includes("AI_NOTES.md"));
	assert.match(core.initPrompt(core.loadSettings()), /AI_NOTES\.md/);
});
