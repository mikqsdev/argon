import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARGON_HOME = mkdtempSync(join(tmpdir(), "argon-feat-"));
const work = mkdtempSync(join(tmpdir(), "argon-feat-work-"));
const pi = await import("@mariozechner/pi-ai");
const core = await import("../dist/core/index.js");

test("reasoning profile comes from the provider (levels, default, mandatory, max)", () => {
	const known = pi.getModels("openrouter");
	const [m] = core.mergeLive("openrouter", known, [
		{ id: "anthropic/claude-sonnet-9", efforts: ["max", "xhigh", "high", "medium", "low"], defaultEffort: "high", reasoningMandatory: true },
	]);
	const p = core.effortProfile(m);
	assert.deepEqual(p.levels, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(p.default, "high");
	assert.equal(p.source, "provider");
	assert.equal(core.resolveEffort(m, "off"), "high", "mandatory reasoning cannot be turned off");
	assert.equal(core.resolveEffort(m, "minimal"), "low", "clamps to nearest level");
	const a = core.applyEffort(m, "max");
	assert.equal(a.level, "xhigh");
	assert.equal(a.model.thinkingLevelMap.xhigh, "max", "provider value is sent as-is");
	const [g] = core.mergeLive("openrouter", known, [{ id: "google/x", efforts: ["xhigh", "high", "medium", "low"] }]);
	assert.ok(!core.effortProfile(g).levels.includes("max"));
	assert.ok(core.effortProfile(g).levels.includes("off"), "non-mandatory models can turn reasoning off");
});

test("newer Claude models get adaptive thinking with effort", () => {
	assert.equal(core.claudeUsesAdaptiveThinking("claude-opus-5-5"), true);
	assert.equal(core.claudeUsesAdaptiveThinking("claude-sonnet-4-6"), true);
	assert.equal(core.claudeUsesAdaptiveThinking("claude-sonnet-4-5"), false);
	const model = { ...pi.getModel("anthropic", "claude-opus-4-7"), id: "claude-opus-5-5" };
	const out = core.adaptiveThinkingPatch(model, "max")({ thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" } });
	assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" });
	assert.equal(out.output_config.effort, "max");
});

test("sub-agents: built-ins, custom definitions, events and report", async () => {
	const faux = pi.registerFauxProvider({ provider: "fauxsub", models: [{ id: "m1" }] });
	core.updateSettings({
		model: { default: "fauxsub/m1" },
		general: { autoTitle: false },
		providers: { custom: [{ id: "fauxsub", name: "F", baseUrl: "http://localhost", api: faux.api, models: ["m1"], noAuth: true }] },
	});
	core.saveAgent({ name: "Shouter", description: "Shouts", tools: "read-only", model: "inherit", prompt: "Answer in capitals." });
	const names = core.listAgents(work, core.loadSettings()).map((a) => a.name);
	for (const n of ["explore", "general", "research", "reviewer", "planner", "shouter"]) assert.ok(names.includes(n), n);

	faux.setResponses([
		pi.fauxAssistantMessage([pi.fauxToolCall("task", { agent: "shouter", description: "test", prompt: "list files" })], { stopReason: "toolUse" }),
		pi.fauxAssistantMessage([pi.fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" }),
		pi.fauxAssistantMessage(pi.fauxText("REPORT DONE")),
		pi.fauxAssistantMessage(pi.fauxText("main done")),
	]);
	const s = await core.ArgonSession.create({ cwd: work, mode: "auto" });
	assert.match(s.agent.state.tools.find((t) => t.name === "task").description, /shouter: Shouts/);
	const ev = [];
	s.subscribe((e) => ev.push(e));
	await s.prompt("delegate");
	const sub = ev.filter((e) => e.type === "subagent");
	assert.deepEqual(sub.map((e) => e.phase), ["start", "step", "step_end", "end"]);
	assert.equal(sub[0].agent, "shouter");
	const end = ev.find((e) => e.type === "tool_execution_end" && e.toolName === "task");
	assert.match(end.result.content[0].text, /REPORT DONE/);
	assert.ok(core.deleteAgent("shouter"));
});

test("limit status always reports money spent", () => {
	const st = core.limitStatus();
	for (const k of ["fiveHour", "weekly", "today", "month", "total"]) assert.equal(typeof st.spend[k], "number");
	assert.ok(Array.isArray(st.spend.byProvider));
});

test("deleting an environment keeps or deletes its sessions, never the folder", async () => {
	const { existsSync } = await import("node:fs");
	const a = core.addEnvironment("Keep", work);
	const s1 = core.newSessionData({ envId: a.id, cwd: work, model: "x/y", effort: "low", mode: "ask" });
	core.saveSession(s1);
	assert.equal(core.sessionCountsByEnv()[a.id], 1);
	let r = core.removeEnvironment(a.id);
	assert.deepEqual(r, { sessions: 1, deleted: true });
	assert.equal(core.loadSession(s1.meta.id).meta.envId, null, "session moved to no environment");
	assert.ok(existsSync(work), "folder untouched");

	const b = core.addEnvironment("Drop", work);
	const s2 = core.newSessionData({ envId: b.id, cwd: work, model: "x/y", effort: "low", mode: "ask" });
	core.saveSession(s2);
	r = core.removeEnvironment(b.id, { deleteSessions: true });
	assert.equal(r.sessions, 1);
	assert.equal(core.loadSession(s2.meta.id), undefined, "session deleted");
	assert.equal(core.listEnvironments().some((e) => e.id === b.id), false);
	assert.deepEqual(core.removeEnvironment("nope"), { sessions: 0, deleted: false });
});
