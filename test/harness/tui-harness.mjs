// Runs Argon CLI inside a headless xterm with a fake model, types keys, and saves HTML snapshots.
// Usage: node test/harness/tui-harness.mjs <outDir> [cols] [rows]
process.env.FORCE_COLOR = "3";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import xtermHeadless from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializePkg;
const outDir = resolve(process.argv[2] ?? join(tmpdir(), "argon-tui-shots"));
const cols = Number(process.argv[3] ?? 120);
const rows = Number(process.argv[4] ?? 36);
mkdirSync(outDir, { recursive: true });

const home = join(tmpdir(), "argon-tui-home");
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
process.env.ARGON_HOME = home;
// Sample usage history so costs, rings and charts are populated in screenshots.
{
	const lines = [];
	let seed = 11;
	const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
	const now = Date.now();
	const models = [["anthropic", "claude-sonnet-4-6", 3, 15], ["openrouter", "anthropic/claude-sonnet-5.5", 3, 15], ["openai", "gpt-5.1", 1.25, 10]];
	for (let d = 29; d >= 0; d--) {
		const n = 1 + Math.floor(rnd() * 8);
		for (let i = 0; i < n; i++) {
			const [provider, model, ci, co] = models[Math.floor(rnd() * 3)];
			const input = 5000 + Math.floor(rnd() * 30000), output = 500 + Math.floor(rnd() * 3000);
			lines.push(JSON.stringify({ ts: now - d * 86400000 - Math.floor(rnd() * 5) * 3600000 - 60000, kind: "llm", provider, model, sessionId: "seed" + d, input, output, cacheRead: 0, cacheWrite: 0, cost: (input * ci + output * co) / 1e6, ...(rnd() < 0.25 ? { agent: "explore" } : {}) }));
		}
	}
	writeFileSync(join(home, "usage.jsonl"), lines.join("\n") + "\n");
}

const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
const ser = new SerializeAddon();
term.loadAddon(ser);

// stdout → terminal
const stdout = process.stdout;
const realWrite = stdout.write.bind(stdout);
stdout.write = (chunk, ...rest) => {
	term.write(typeof chunk === "string" ? chunk : chunk.toString());
	const cb = rest.find((r) => typeof r === "function");
	cb?.();
	return true;
};
Object.defineProperty(stdout, "columns", { value: cols, configurable: true });
Object.defineProperty(stdout, "rows", { value: rows, configurable: true });
Object.defineProperty(stdout, "isTTY", { value: true, configurable: true });

// keyboard ← fake stdin
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });

const pi = await import("@mariozechner/pi-ai");
const core = await import("../../dist/core/index.js");
const faux = pi.registerFauxProvider({ provider: "demo", tokensPerSecond: 300, models: [{ id: "demo-model", name: "Demo Model", reasoning: true, contextWindow: 200000 }] });
const respond = (ctx) => {
	if ((ctx.systemPrompt || "").includes("# Sub-agent:")) {
		const n = ctx.messages.filter((m) => m.role === "toolResult").length;
		if (n === 0) return pi.fauxAssistantMessage([pi.fauxToolCall("glob", { pattern: "src/**/*.ts" })], { stopReason: "toolUse" });
		if (n === 1) return pi.fauxAssistantMessage([pi.fauxToolCall("grep", { pattern: "export class", path: "src" })], { stopReason: "toolUse" });
		return pi.fauxAssistantMessage(pi.fauxText("Report: core in src/core, CLI in src/cli."));
	}
	const done = ctx.messages.filter((m) => m.role === "toolResult").map((m) => m.toolName);
	if (!done.length)
		return pi.fauxAssistantMessage(
			[pi.fauxThinking("Map the code first, then summarise."), pi.fauxText("I'll map the project with a sub-agent."), pi.fauxToolCall("task", { agent: "explore", description: "Map the code", prompt: "Map src/" }), pi.fauxToolCall("ls", { path: "." })],
			{ stopReason: "toolUse" },
		);
	return pi.fauxAssistantMessage(
		pi.fauxText(
			"## The project at a glance\n\nArgon is split into three layers:\n\n- **Core** (`src/core`) — sessions, providers, tools, limits\n- **CLI** (`src/cli`) — this full-screen terminal interface\n- **GUI** (`gui/`) — the Material 3 desktop app\n\n| Layer | Files |\n|---|---|\n| Core | 22 |\n| CLI | 5 |\n| GUI | 9 |\n\nEverything is shared through `~/.argon`, so sessions, skills and MCP servers are the same in the CLI and in the GUI.",
		),
	);
};
faux.setResponses(Array.from({ length: 60 }, () => respond));
const s = core.loadSettings();
core.saveSettings({
	...s,
	general: { ...s.general, userName: "Ada", autoTitle: false },
	model: { ...s.model, default: "demo/demo-model", effort: "medium" },
	providers: { ...s.providers, custom: [...s.providers.custom, { id: "demo", name: "Demo", baseUrl: "http://localhost", api: faux.api, models: ["demo-model"], noAuth: true, reasoning: true }] },
	limits: { ...s.limits, enabled: true, unit: "cost", fiveHour: { enabled: true, value: 10, mode: "block" }, weekly: { enabled: true, value: 60, resetDay: 3, resetHour: 9 } },
	permissions: { ...s.permissions, mode: "auto" },
	cli: { ...s.cli, language: process.env.ARGON_LANG ?? "en" },
});
const cwd = resolve(process.env.ARGON_DEMO_CWD ?? process.cwd());
core.addEnvironment("argon", cwd);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = async (name) => {
	await sleep(250);
	await new Promise((r) => term.write("", r));
	writeFileSync(join(outDir, name + ".html"), ser.serializeAsHTML({ includeGlobalBackground: true, scrollback: 0 }));
	const buf = term.buffer.active;
	const lines = [];
	for (let i = 0; i < term.rows; i++) lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
	writeFileSync(join(outDir, name + ".txt"), lines.join("\n"));
	realWrite(`snapshot ${name}\n`);
};
const type = async (s, delay = 15) => {
	for (const ch of s) {
		stdin.write(ch);
		await sleep(delay);
	}
};

const { runTui } = await import("../../dist/cli/tui.js");
void runTui({ cwd });
await sleep(1800);
await snap("01-start");
await type("/");
await sleep(300);
await snap("02-slash");
stdin.write("\x7f");
await type("Explain this project with a sub-agent");
stdin.write("\r");
await sleep(400);
await snap("03-running");
await sleep(4500);
await snap("04-answer");
await type("/model");
stdin.write("\r");
await sleep(600);
await snap("05-model-picker");
stdin.write("\x1b");
await sleep(300);
await type("/usage");
stdin.write("\r");
await sleep(800);
await snap("06-usage");
await type("/settings");
stdin.write("\r");
await sleep(600);
await snap("07-settings");
stdin.write("\x1b");
await sleep(200);
realWrite("done\n");
process.exit(0);
