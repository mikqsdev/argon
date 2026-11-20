#!/usr/bin/env node
import "./console.js"; // must stay first: fixes console stdin on the installed Argon.exe runtime
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import chalk from "chalk";
import {
	ArgonSession,
	loadSettings,
	setApiKey,
	syncMcp,
	closeMcp,
	addEnvironment,
	listEnvironments,
	removeEnvironment,
	listSessions,
	VERSION,
	type Effort,
	type PermissionMode,
} from "../core/index.js";
import { accent, banner, dim, err, gradient, ok, setAccent } from "./ui.js";
import { doEnvRemove } from "./commands.js";
import { T, doLogin, doLogout, doLimits, doConfig, doMcp, printModels, printProviders, printSessions, printSkills, printMemory, printStats } from "./commands.js";

interface Flags {
	_: string[];
	print?: string | boolean;
	model?: string;
	effort?: Effort;
	mode?: PermissionMode;
	cwd?: string;
	resume?: string | boolean;
	continue?: boolean;
	json?: boolean;
	port?: string;
	open?: boolean;
	all?: boolean;
	help?: boolean;
	version?: boolean;
}

function parseArgs(argv: string[]): Flags {
	const f: Flags = { _: [] };
	const alias: Record<string, string> = { p: "print", m: "model", e: "effort", c: "continue", r: "resume", h: "help", v: "version", C: "cwd" };
	const booleans = new Set(["continue", "json", "help", "version", "all", "open", "no-open", "web", "delete-sessions", "keep-sessions"]);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			f._.push(...argv.slice(i + 1));
			break;
		}
		const m = a.match(/^--?([\w-]+)(?:=(.*))?$/);
		if (!m || /^-\d/.test(a)) {
			f._.push(a);
			continue;
		}
		let key = alias[m[1]] ?? m[1];
		let val: any = m[2];
		if (key === "no-open") {
			f.open = false;
			continue;
		}
		if (val === undefined) {
			if (booleans.has(key)) val = true;
			else if (key === "print" || key === "resume") val = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
			else val = argv[++i];
		}
		(f as any)[key] = val;
	}
	return f;
}

function help(): void {
	console.log(
		"\n" +
			banner([
				"",
				`${chalk.bold(gradient("Argon"))} ${dim("v" + VERSION)}`,
				dim(T("Agente AI open source · CLI + GUI", "Open-source AI agent · CLI + GUI")),
				"",
				"",
			]) +
			"\n",
	);
	const rows: [string, string][] = [
		["argon", T("sessione interattiva nel terminale", "interactive terminal session")],
		['argon "prompt"', T("avvia la sessione con un prompt", "start a session with a prompt")],
		['argon -p "prompt"', T("esegue e stampa la risposta (script/pipe)", "run headless and print the answer (scripts/pipes)")],
		["argon -c | -r [id]", T("continua l'ultima sessione / riprendi", "continue the last session / resume one")],
		["argon gui", T("apre l'interfaccia grafica", "open the graphical interface")],
		["argon login [provider]", T("collega account OAuth o API key", "connect an OAuth account or API key")],
		["argon key <provider> <key>", T("salva una API key", "save an API key")],
		["argon logout <provider>", T("rimuove le credenziali", "remove credentials")],
		[T("argon providers | models [filtro]", "argon providers | models [filter]"), T("provider e modelli disponibili", "available providers and models")],
		["argon limits [on|off|5h <n>|week <n>|unit tokens|cost]", T("limiti di utilizzo", "usage limits")],
		["argon stats [7d|30d|all]", T("statistiche d'uso", "usage statistics")],
		[T("argon sessions [testo]", "argon sessions [text]"), T("elenca le sessioni", "list sessions")],
		["argon mcp [add|remove|enable|disable]", T("server MCP", "MCP servers")],
		[T("argon env [add <nome> [cartella]|rm <nome>]", "argon env [add <name> [folder]|rm <name>]"), T("ambienti (progetti)", "environments (projects)")],
		["argon skills | memory", T("skill, comandi e memoria", "skills, commands and memory")],
		["argon config [get|set|path]", T("impostazioni", "settings")],
	];
	for (const [c, d] of rows) console.log(`  ${accent(c.padEnd(52))} ${dim(d)}`);
	console.log(`\n  ${dim(T("Opzioni", "Options"))}: -m <provider/model>  -e <off|low|medium|high|xhigh|max>  --mode <ask|acceptEdits|auto|plan>  -C <dir>  --json\n`);
}

async function printMode(f: Flags, cwd: string, prompt: string): Promise<void> {
	await syncMcp();
	let resumeId = typeof f.resume === "string" ? f.resume : undefined;
	if (f.continue) resumeId = listSessions().find((s) => s.cwd.toLowerCase() === cwd.toLowerCase())?.id;
	const session = await ArgonSession.create({ cwd, model: f.model, effort: f.effort, mode: f.mode, resumeId, interactive: false });
	let failed = false;
	session.subscribe((e) => {
		if (f.json) {
			if (e.type === "message_update") return;
			process.stdout.write(JSON.stringify(e) + "\n");
			return;
		}
		if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") process.stdout.write(e.assistantMessageEvent.delta);
		if (e.type === "message_update" && e.assistantMessageEvent.type === "text_end") process.stdout.write("\n");
		if (e.type === "tool_execution_start") process.stderr.write(dim(`⏺ ${e.toolName} ${JSON.stringify(e.args).slice(0, 120)}\n`));
		if (e.type === "notice" && e.level === "error") {
			failed = true;
			process.stderr.write(err(e.text) + "\n");
		}
	});
	await session.prompt(prompt);
	await closeMcp();
	process.exit(failed ? 1 : 0);
}

async function main() {
	const f = parseArgs(process.argv.slice(2));
	const s = loadSettings();
	setAccent(s.cli.accent);
	const cwd = resolve(f.cwd ?? process.cwd());
	const rl = () => createInterface({ input: process.stdin, output: process.stdout });
	const ask = async (q: string, signal?: AbortSignal) => {
		const r = rl();
		try {
			return await r.question(q, signal ? { signal } : {});
		} finally {
			r.close();
		}
	};

	if (f.version) return console.log(VERSION);
	if (f.help) return help();

	// Read stdin when piped: `cat file | argon -p "explain"`
	let piped = "";
	if (!process.stdin.isTTY && (f.print !== undefined || f._.length)) {
		for await (const chunk of process.stdin) piped += chunk;
	}

	if (f.print !== undefined) {
		const prompt = [typeof f.print === "string" ? f.print : f._.join(" "), piped].filter(Boolean).join("\n\n");
		if (!prompt) throw new Error("Nothing to do: pass a prompt to -p");
		return printMode(f, cwd, prompt);
	}

	const [cmd, ...args] = f._;
	switch (cmd) {
		case "help":
			return help();
		case "gui":
		case "app": {
			if (!(f as any).web && loadSettings().general.openGuiAs === "desktop") {
				const { launchDesktop } = await import("../core/desktop.js");
				if (launchDesktop()) {
					console.log(`\n  ${accent("●")} ${chalk.bold("Argon")} ${dim(T("— app desktop avviata", "— desktop app started"))}\n`);
					return process.exit(0);
				}
				console.log(dim(T("  App desktop non installata (npm i -D electron): apro la versione web.", "  Desktop app not installed (npm i -D electron): opening the web version.")));
			}
			const { startServer } = await import("../server/server.js");
			const { url } = await startServer({ port: f.port ? Number(f.port) : undefined, open: f.open !== false });
			console.log(`\n  ${accent("●")} ${chalk.bold("Argon GUI")} ${dim("→")} ${chalk.underline(url)}\n  ${dim(T("Ctrl+C per chiudere il server", "Ctrl+C to stop the server"))}\n`);
			return;
		}
		case "login":
			await doLogin(args[0], ask);
			return process.exit(0);
		case "key":
			if (args.length < 2) throw new Error("usage: argon key <provider> <api-key>");
			setApiKey(args[0], args[1]);
			return console.log(ok(`  ✓ ${args[0]}`));
		case "logout":
			if (!args[0]) throw new Error("usage: argon logout <provider>");
			return doLogout(args[0]);
		case "providers":
			return printProviders();
		case "models":
			printModels(args[0] ?? "", !!f.all);
			return;
		case "limits":
		case "usage":
			return doLimits(args);
		case "stats":
			return printStats((args[0] as any) ?? "all");
		case "sessions":
			printSessions(args.join(" ") || undefined);
			return;
		case "mcp":
			await doMcp(args);
			await closeMcp();
			return process.exit(0);
		case "skills":
		case "commands":
			return printSkills(cwd);
		case "memory":
			return printMemory(cwd);
		case "config":
			return doConfig(args);
		case "env": {
			if (args[0] === "add") {
				const dir = resolve(args[2] ?? cwd);
				const e = addEnvironment(args[1] ?? dir.split(/[\\/]/).pop()!, dir);
				return console.log(ok(`  ✓ ${e.name} → ${e.cwd} ${dim(e.id)}`));
			}
			if (args[0] === "rm" || args[0] === "remove" || args[0] === "delete") {
				await doEnvRemove(args.slice(1).join(" "), ask, (f as any)["delete-sessions"] ? "delete" : (f as any)["keep-sessions"] ? "keep" : undefined);
				return process.exit(0);
			}
			const envs = listEnvironments();
			if (!envs.length) console.log(dim(T("  Nessun ambiente. Aggiungi con: argon env add <nome> [cartella]", "  No environments. Add one: argon env add <name> [folder]")));
			for (const e of envs) console.log(`  ${accent(e.name.padEnd(24))} ${dim(e.cwd)} ${dim(`${listSessions({ envId: e.id }).length} ${T("sessioni", "sessions")}`)} ${dim(e.id)}`);
			return;
		}
	}

	// interactive
	let resumeId = typeof f.resume === "string" ? f.resume : undefined;
	if (f.continue) resumeId = listSessions().find((x) => x.cwd.toLowerCase() === cwd.toLowerCase())?.id;
	const initialPrompt = [f._.join(" "), piped].filter(Boolean).join("\n\n") || undefined;
	if (!process.stdin.isTTY) throw new Error("Interactive mode needs a terminal. Use argon -p \"…\" for scripts.");
	const { runTui } = await import("./tui.js");
	if (f.resume === true) {
		const ids = printSessions();
		const a = (await ask(accent(T("  Numero sessione: ", "  Session number: ")))).trim();
		resumeId = ids[Number(a) - 1];
	}
	await runTui({ cwd, model: f.model, effort: f.effort, mode: f.mode, resumeId, initialPrompt });
}

main().catch((e) => {
	console.error(err(`\n  ✖ ${e?.message ?? e}\n`));
	process.exit(1);
});
