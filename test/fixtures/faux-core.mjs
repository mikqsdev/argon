// Argon core with a fake model, for testing clients (Rust CLI, desktop shell) without network.
// Usage: ARGON_HOME=<tmp> node test/fixtures/faux-core.mjs serve
// Prints the same `ARGON_READY {...}` line as `argon serve`.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ARGON_HOME ??= join(tmpdir(), "argon-faux-home");
mkdirSync(process.env.ARGON_HOME, { recursive: true });

const pi = await import("@mariozechner/pi-ai");
const core = await import("../../dist/core/index.js");
const { startServer } = await import("../../dist/server/server.js");

// ARGON_FAUX_MODELS=N adds demo-model-02…N (with prices) to test long model lists.
const extra = Array.from({ length: Math.max(0, Number(process.env.ARGON_FAUX_MODELS ?? 1) - 1) }, (_, i) => {
	const n = String(i + 2).padStart(2, "0");
	return { id: `demo-model-${n}`, name: `Demo Model ${n}`, reasoning: i % 2 === 0, contextWindow: 128000, cost: { input: (i % 7) + 0.5, output: ((i % 7) + 0.5) * 4, cacheRead: 0, cacheWrite: 0 } };
});
const fauxModels = [{ id: "demo-model", name: "Demo Model", reasoning: true, contextWindow: 200000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, ...extra];
const faux = pi.registerFauxProvider({ provider: "demo", tokensPerSecond: 400, models: fauxModels });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const respond = async (ctx) => {
	// /btw side question: one read-only step, then a short answer quoting the conversation.
	if ((ctx.systemPrompt || "").includes("# Side question (/btw)")) {
		if (!ctx.messages.some((m) => m.role === "toolResult")) {
			await wait(600);
			return pi.fauxAssistantMessage([pi.fauxToolCall("glob", { pattern: "src/**/*.ts" })], { stopReason: "toolUse" });
		}
		const c0 = ctx.messages[0]?.content;
		const q = (typeof c0 === "string" ? c0 : (c0 ?? []).map((c) => c.text ?? "").join("")).match(/Side question from the user: ([\s\S]*)$/)?.[1] ?? "";
		return pi.fauxAssistantMessage(pi.fauxText(`Short answer to *${q.trim()}*: the main agent is still working on your request.\n\n- It has not changed any file yet\n- The core lives in \`src/core\``));
	}
	if ((ctx.systemPrompt || "").includes("# Sub-agent:")) {
		const n = ctx.messages.filter((m) => m.role === "toolResult").length;
		if (n === 0) return pi.fauxAssistantMessage([pi.fauxToolCall("glob", { pattern: "src/**/*.ts" })], { stopReason: "toolUse" });
		if (n === 1) return pi.fauxAssistantMessage([pi.fauxToolCall("grep", { pattern: "export class", path: "src/core" })], { stopReason: "toolUse" });
		if (n === 2) return pi.fauxAssistantMessage([pi.fauxToolCall("read", { path: "src/core/session.ts", limit: 40 })], { stopReason: "toolUse" });
		return pi.fauxAssistantMessage(pi.fauxText("Report: core in src/core, CLI in src/cli."));
	}
	// Tool results of this turn only (after the last user message), so each request plays out on its own.
	const done = ctx.messages.slice(ctx.messages.map((m) => m.role).lastIndexOf("user") + 1).filter((m) => m.role === "toolResult").length;
	const last = ctx.messages.filter((m) => m.role === "user").at(-1);
	const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((c) => c.text ?? "").join("");
	// "background": starts two background tasks (a long one and a quick one) for the right panel.
	if (/background/i.test(text) && !done)
		return pi.fauxAssistantMessage(
			[
				pi.fauxToolCall("bash", { command: "node -e \"setTimeout(() => {}, 600000)\"", description: "Dev server (fake)", background: true }),
				pi.fauxToolCall("bash", { command: "node -e \"console.log('built')\"", description: "Build once", background: true }),
			],
			{ stopReason: "toolUse" },
		);
	// "slow": keeps the agent busy for a while (to try queued messages and /btw).
	if (/slow/i.test(text)) await wait(Number(process.env.ARGON_FAUX_SLOW ?? 6000));
	if (/write/i.test(text) && !done) return pi.fauxAssistantMessage([pi.fauxToolCall("write", { path: "../outside-faux.txt", content: "x" })], { stopReason: "toolUse" });
	if (/sub-agent/i.test(text) && !done)
		return pi.fauxAssistantMessage([pi.fauxThinking("Map the code first."), pi.fauxText("I'll map the project with a sub-agent."), pi.fauxToolCall("task", { agent: "explore", description: "Map the code", prompt: "Map src/" }), pi.fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
	return pi.fauxAssistantMessage(
		pi.fauxText("## The project at a glance\n\nArgon has three layers:\n\n- **Core** (`src/core`) — sessions, providers, tools\n- **CLI** — the terminal interface\n- **GUI** — the desktop app\n\n| Layer | Files |\n|---|---|\n| Core | 22 |\n| CLI | 5 |\n\nDone."),
	);
};
faux.setResponses(Array.from({ length: 200 }, () => respond));

const s = core.loadSettings();
core.saveSettings({
	...s,
	general: { ...s.general, userName: "Ada", autoTitle: false },
	model: { ...s.model, default: "demo/demo-model", effort: "medium" },
	providers: { ...s.providers, custom: [...s.providers.custom.filter((p) => p.id !== "demo"), { id: "demo", name: "Demo", baseUrl: "http://localhost", api: faux.api, models: fauxModels.map((m) => m.id), noAuth: true, reasoning: true }] },
	limits: { ...s.limits, enabled: true, unit: "cost", fiveHour: { enabled: true, value: 10, mode: "block" }, weekly: { enabled: true, value: 60, resetDay: 3, resetHour: 9 } },
	permissions: { ...s.permissions, mode: process.env.ARGON_FAUX_MODE ?? "auto" },
	cli: { ...s.cli, language: process.env.ARGON_LANG ?? "en" },
});

const { url, close } = await startServer({ port: 0, open: false });
const u = new URL(url);
console.log("ARGON_READY " + JSON.stringify({ url, port: Number(u.port), token: u.searchParams.get("t"), pid: process.pid }));
process.stdin.resume();
process.stdin.on("end", () => {
	close();
	process.exit(0);
});
