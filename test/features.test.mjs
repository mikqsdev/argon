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

const until = async (fn, ms = 4000) => {
	const t0 = Date.now();
	while (!fn()) {
		if (Date.now() - t0 > ms) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 10));
	}
};
const userTexts = (s) => s.agent.state.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.find((c) => c.type === "text")?.text));
const fauxSession = async (id) => {
	const faux = pi.registerFauxProvider({ provider: id, models: [{ id: "m1" }] });
	core.updateSettings({
		model: { default: `${id}/m1` },
		general: { autoTitle: false },
		providers: { custom: [{ id, name: id, baseUrl: "http://localhost", api: faux.api, models: ["m1"], noAuth: true }] },
	});
	return { faux, s: await core.ArgonSession.create({ cwd: work, mode: "auto" }) };
};
const held = () => {
	let release;
	const gate = new Promise((r) => (release = r));
	return { release, reply: (text) => async () => (await gate, pi.fauxAssistantMessage(pi.fauxText(text))) };
};

test("queued messages wait for the run to end, go out in order, and pause after a stop", async () => {
	const { faux, s } = await fauxSession("fauxqueue");
	const ev = [];
	s.subscribe((e) => ev.push(e));
	const h = held();
	faux.setResponses([h.reply("r1"), pi.fauxAssistantMessage(pi.fauxText("r2")), pi.fauxAssistantMessage(pi.fauxText("r3"))]);
	const first = s.prompt("one");
	s.enqueue("two");
	s.enqueue("three");
	assert.deepEqual(s.queued.map((q) => q.text), ["two", "three"], "nothing leaves while the agent works");
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(userTexts(s), ["one"]);
	h.release();
	await first;
	await until(() => s.status === "idle" && !s.launching && userTexts(s).length === 3);
	assert.deepEqual(userTexts(s), ["one", "two", "three"]);
	assert.deepEqual(ev.filter((e) => e.type === "queue" && e.sent).map((e) => e.sent.text), ["two", "three"]);
	assert.equal(s.queued.length, 0);

	// A stop pauses the queue; "send now" (or a new run) takes it from there.
	const h2 = held();
	faux.setResponses([h2.reply("r4"), pi.fauxAssistantMessage(pi.fauxText("r5"))]);
	const fourth = s.prompt("four");
	s.enqueue("five");
	s.abort();
	h2.release();
	await fourth;
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(s.queued.map((q) => q.text), ["five"], "paused after the stop");
	s.sendQueued(s.queued[0].id);
	await until(() => s.status === "idle" && !s.launching && userTexts(s).includes("five"));
	assert.equal(s.queued.length, 0);

	// Removing gives the message back (with its images) and it never runs.
	const h3 = held();
	faux.setResponses([h3.reply("r6")]);
	const sixth = s.prompt("six");
	const q = s.enqueue("seven", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
	assert.equal(q.images, 1);
	assert.equal(s.unqueue(q.id).images[0].data, "AAAA");
	h3.release();
	await sixth;
	await new Promise((r) => setTimeout(r, 40));
	assert.ok(!userTexts(s).includes("seven"));
});

test("/btw: a read-only sub-agent answers from the conversation without touching it", async () => {
	const { faux, s } = await fauxSession("fauxbtw");
	let seen;
	faux.setResponses([
		pi.fauxAssistantMessage(pi.fauxText("Noted.")),
		(ctx) => {
			seen = ctx;
			return pi.fauxAssistantMessage(pi.fauxText("It is **TANGERINE**."));
		},
	]);
	await s.prompt("The code word is TANGERINE");
	const before = s.agent.state.messages.length;
	const ev = [];
	s.subscribe((e) => ev.push(e));
	const b = s.btw("what is the code word?");
	assert.equal(b.status, "running");
	await until(() => b.status !== "running");
	assert.equal(b.status, "done");
	assert.equal(b.text, "It is **TANGERINE**.");
	const sent = JSON.stringify(seen.messages);
	assert.match(sent, /TANGERINE/, "the sub-agent sees the conversation");
	assert.match(sent, /what is the code word/);
	assert.match(seen.systemPrompt, /Side question/);
	const tools = (seen.tools ?? []).map((t) => t.name);
	for (const t of ["write", "edit", "bash", "todo", "memory", "task", "ask_user"]) assert.ok(!tools.includes(t), `no ${t}`);
	assert.ok(tools.includes("read"));
	assert.equal(s.agent.state.messages.length, before, "the main conversation is untouched");
	assert.equal(ev.filter((e) => e.type === "btw").at(-1).btw.status, "done");
	s.dismissBtw(b.id);
	assert.equal(s.btws.length, 0);
	assert.ok(ev.some((e) => e.type === "btw_dismiss" && e.id === b.id));
});

test("pull requests: the agent's `gh pr create` is recorded, statuses merge into the session", async () => {
	const { faux, s } = await fauxSession("fauxpr");
	faux.setResponses([
		pi.fauxAssistantMessage([pi.fauxToolCall("bash", { command: 'echo https://github.com/example/demo/pull/7 # gh pr create --title "Demo PR"' })], { stopReason: "toolUse" }),
		pi.fauxAssistantMessage(pi.fauxText("Opened.")),
	]);
	await s.prompt("open a PR");
	assert.equal(s.data.meta.prs?.length, 1);
	assert.deepEqual([s.data.meta.prs[0].number, s.data.meta.prs[0].url, s.data.meta.prs[0].title], [7, "https://github.com/example/demo/pull/7", "Demo PR"]);
	// Imported PRs are listed too, newest first, without duplicates.
	s.data.meta.git = { capturedAt: Date.now(), prs: [{ number: 3, title: "Old", url: "https://github.com/example/demo/pull/3", state: "MERGED" }, { number: 7, title: "dup", url: "https://github.com/example/demo/pull/7", state: "OPEN" }] };
	assert.deepEqual(core.sessionPrs(s.data.meta).map((p) => p.number), [7, 3]);
	const changed = core.mergePrStatus(s.data.meta, [{ number: 7, url: "https://github.com/example/demo/pull/7", title: "Demo PR", state: "OPEN", draft: false, additions: 202, deletions: 28, checks: "pending", checkedAt: 1 }]);
	assert.ok(changed);
	const p7 = core.sessionPrs(s.data.meta)[0];
	assert.deepEqual([p7.state, p7.additions, p7.deletions, p7.checks], ["OPEN", 202, 28, "pending"]);
	assert.deepEqual(core.findPrUrl("see https://github.com/a/b/pull/12 now"), { url: "https://github.com/a/b/pull/12", number: 12 });
	assert.equal(core.findPrUrl("no link"), null);
});
