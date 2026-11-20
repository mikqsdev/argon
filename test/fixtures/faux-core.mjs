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

const faux = pi.registerFauxProvider({ provider: "demo", tokensPerSecond: 400, models: [{ id: "demo-model", name: "Demo Model", reasoning: true, contextWindow: 200000 }] });
const respond = (ctx) => {
	if ((ctx.systemPrompt || "").includes("# Sub-agent:")) {
		const n = ctx.messages.filter((m) => m.role === "toolResult").length;
		if (n === 0) return pi.fauxAssistantMessage([pi.fauxToolCall("glob", { pattern: "src/**/*.ts" })], { stopReason: "toolUse" });
		return pi.fauxAssistantMessage(pi.fauxText("Report: core in src/core, CLI in src/cli."));
	}
	const done = ctx.messages.filter((m) => m.role === "toolResult").length;
	const last = ctx.messages.filter((m) => m.role === "user").at(-1);
	const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((c) => c.text ?? "").join("");
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
	providers: { ...s.providers, custom: [...s.providers.custom.filter((p) => p.id !== "demo"), { id: "demo", name: "Demo", baseUrl: "http://localhost", api: faux.api, models: ["demo-model"], noAuth: true, reasoning: true }] },
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
