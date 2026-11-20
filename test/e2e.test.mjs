// End-to-end tests with pi-ai's faux provider: no network, no API key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "argon-home-"));
const work = mkdtempSync(join(tmpdir(), "argon-work-"));
process.env.ARGON_HOME = home;

const { registerFauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@mariozechner/pi-ai");
const core = await import("../dist/core/index.js");

const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 100_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
core.saveSettings({
	...core.loadSettings(),
	model: { ...core.loadSettings().model, default: "faux/faux-1" },
	general: { ...core.loadSettings().general, autoTitle: false },
	providers: { ...core.loadSettings().providers, custom: [{ id: "faux", name: "Faux", baseUrl: "http://localhost", api: faux.api, models: ["faux-1"], noAuth: true }] },
});

function collect(session) {
	const events = [];
	session.subscribe((e) => events.push(e));
	return events;
}

test("agent writes, reads and edits files through tools", async () => {
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "ciao mondo\n" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("edit", { path: "hello.txt", old_string: "mondo", new_string: "argon" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read", { path: "hello.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Fatto.")),
	]);
	const s = await core.ArgonSession.create({ cwd: work, mode: "auto" });
	const events = collect(s);
	await s.prompt("crea un file");
	assert.equal(readFileSync(join(work, "hello.txt"), "utf8"), "ciao argon\n");
	const ends = events.filter((e) => e.type === "tool_execution_end");
	assert.equal(ends.length, 3);
	assert.ok(ends.every((e) => !e.isError), JSON.stringify(ends.map((e) => e.result)));
	assert.match(ends[2].result.content[0].text, /ciao argon/);
	// persisted
	const saved = core.loadSession(s.id);
	assert.ok(saved.messages.length >= 8);
	// undo restores the file system state (file did not exist)
	const r = s.undo();
	assert.equal(r.files.length, 1);
	assert.equal(existsSync(join(work, "hello.txt")), false);
});

test("ask mode blocks edits when no user can approve, and approvals work", async () => {
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("ok")),
	]);
	const headless = await core.ArgonSession.create({ cwd: work, mode: "ask", interactive: false });
	const ev1 = collect(headless);
	await headless.prompt("run");
	const end1 = ev1.find((e) => e.type === "tool_execution_end");
	assert.equal(end1.isError, true);

	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "echo approved" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("ok")),
	]);
	const s = await core.ArgonSession.create({ cwd: work, mode: "ask" });
	const ev = [];
	s.subscribe((e) => {
		ev.push(e);
		if (e.type === "approval_request") setTimeout(() => s.respondApproval(e.id, "allow"), 10);
	});
	await s.prompt("run");
	const end = ev.find((e) => e.type === "tool_execution_end");
	assert.equal(end.isError, false);
	assert.match(end.result.content[0].text, /approved/);
});

test("plan mode exposes only read-only tools", async () => {
	const s = await core.ArgonSession.create({ cwd: work, mode: "plan" });
	const names = s.agent.state.tools.map((t) => t.name);
	assert.ok(names.includes("read"));
	assert.ok(!names.includes("write") && !names.includes("bash"));
});

test("usage is recorded and limits block new prompts", async () => {
	const before = core.computeStats("all").totalTokens;
	assert.ok(before > 0, "usage should have been recorded");
	core.updateSettings({ limits: { enabled: true, unit: "tokens", action: "block", fiveHour: { enabled: true, value: 1, mode: "block" } } });
	const st = core.limitStatus();
	assert.equal(st.exceeded, true);
	assert.ok(st.fiveHour.resetsAt > Date.now());
	faux.setResponses([fauxAssistantMessage(fauxText("should not run"))]);
	const s = await core.ArgonSession.create({ cwd: work, mode: "auto" });
	const ev = collect(s);
	const calls = faux.state.callCount;
	await s.prompt("hello");
	assert.equal(faux.state.callCount, calls, "LLM must not be called when blocked");
	assert.ok(ev.some((e) => e.type === "notice" && e.level === "error" && /limit/i.test(e.text)));
	// warn mode lets it through
	core.updateSettings({ limits: { action: "warn" } });
	await s.prompt("hello");
	assert.equal(faux.state.callCount, calls + 1);
	core.updateSettings({ limits: { enabled: false } });
});

test("weekly reset is computed on the configured day and hour", () => {
	const wed = new Date(2026, 10, 18, 9, 0, 0).getTime(); // Wed 18 Nov 2026 09:00
	const fri = new Date(2026, 10, 20, 12, 0, 0).getTime();
	assert.equal(core.lastWeeklyReset(fri, 3, 9), wed);
	assert.equal(core.lastWeeklyReset(wed - 1000, 3, 9), wed - 7 * 24 * 3600 * 1000);
});

test("skills, commands and memory are discovered", async () => {
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(work, ".argon", "skills", "greet"), { recursive: true });
	writeFileSync(join(work, ".argon", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Greets people\n---\nSay hello warmly.");
	mkdirSync(join(work, ".argon", "commands"), { recursive: true });
	writeFileSync(join(work, ".argon", "commands", "review.md"), "Review $ARGUMENTS carefully");
	core.addMemory("project", work, "Il progetto usa tab");
	const s = await core.ArgonSession.create({ cwd: work, mode: "auto" });
	assert.match(s.agent.state.systemPrompt, /greet: Greets people/);
	assert.match(s.agent.state.systemPrompt, /Il progetto usa tab/);
	assert.equal(s.expandSlash("/review src/a.ts"), "Review src/a.ts carefully");
	assert.match(s.expandSlash("/greet"), /greet/);
});

test("permission rules", () => {
	const st = core.loadSettings();
	assert.equal(core.decide("ask", st, "read", { path: "x" }, []).decision, "allow");
	assert.equal(core.decide("ask", st, "bash", { command: "rm -rf /" }, []).decision, "ask");
	assert.equal(core.decide("ask", st, "bash", { command: "git status" }, ["bash(git status*)"]).decision, "allow");
	assert.equal(core.decide("acceptEdits", st, "edit", {}, []).decision, "allow");
	assert.equal(core.decide("auto", { ...st, permissions: { ...st.permissions, deny: ["bash(rm *)"] } }, "bash", { command: "rm -rf x" }, []).decision, "deny");
});
