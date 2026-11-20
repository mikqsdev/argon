import chalk from "chalk";
import type { Interface } from "node:readline/promises";
import {
	loadSettings,
	saveSettings,
	getPath,
	setPath,
	listProviders,
	availableModels,
	modelsFor,
	modelKey,
	loginOAuth,
	setApiKey,
	removeCredential,
	limitStatus,
	computeStats,
	formatTokens,
	mcpStatus,
	syncMcp,
	listSkills,
	listCommands,
	listMemory,
	listSessions,
	listEnvironments,
	removeEnvironment,
	paths,
} from "../core/index.js";
import { openUrl } from "../core/open.js";
import { accent, box, dim, err, heatmap, limitLine, muted, ok, table, warn } from "./ui.js";

export const it = () => (loadSettings().cli?.language ?? loadSettings().general.language) === "it";
export const T = (itText: string, enText: string) => (it() ? itText : enText);

export type Ask = (q: string, signal?: AbortSignal) => Promise<string>;

export function printProviders(): void {
	const rows = listProviders().map((p) => [
		p.connected ? ok("●") : dim("○"),
		chalk.bold(p.id),
		p.name,
		p.connected ? ok(p.connected) : dim(T("non collegato", "not connected")),
		[p.oauth ? "OAuth" : "", p.apiKey ? "API key" : ""].filter(Boolean).join(" / "),
		dim(`${p.modelCount} ${T("modelli", "models")}`),
	]);
	console.log(table(rows));
	console.log(dim(`\n  ${T("Collega con", "Connect with")}: argon login <provider>   ·   argon key <provider> <api-key>`));
}

export function printModels(filter = "", all = false): string[] {
	const list = (all ? listProviders().flatMap((p) => modelsFor(p.id)) : availableModels()).filter((m) => !filter || modelKey(m).toLowerCase().includes(filter.toLowerCase()));
	if (!list.length) {
		console.log(warn(T("  Nessun modello. Collega un provider con /login.", "  No models. Connect a provider with /login.")));
		return [];
	}
	const def = loadSettings().model.default;
	const shown = list.slice(0, 60);
	console.log(
		table(
			shown.map((m, i) => [
				dim(String(i + 1).padStart(2)),
				modelKey(m) === def ? accent("★ " + modelKey(m)) : "  " + modelKey(m),
				dim(`${formatTokens(m.contextWindow)} ctx`),
				dim(m.cost.input || m.cost.output ? `$${m.cost.input}/$${m.cost.output} per M` : T("gratis/abbonamento", "free/subscription")),
				m.reasoning ? muted("reasoning") : "",
			]),
		),
	);
	if (list.length > shown.length) console.log(dim(`  … ${list.length - shown.length} ${T("altri, filtra con", "more, filter with")} /model <${T("testo", "text")}>`));
	return shown.map(modelKey);
}

export async function doLogin(provider: string | undefined, ask: Ask): Promise<void> {
	const providers = listProviders();
	if (!provider) {
		const featured = providers.filter((p) => ["anthropic", "openai", "openai-codex", "openrouter", "google", "github-copilot", "xai", "groq", "mistral", "deepseek"].includes(p.id));
		console.log(table(featured.map((p, i) => [dim(String(i + 1).padStart(2)), chalk.bold(p.name), p.connected ? ok("✓ " + p.connected) : "", dim(p.hint ?? "")])));
		console.log(dim(`  ${T("Altri provider", "Other providers")}: argon providers`));
		const a = (await ask(accent(T("  Provider (numero o id): ", "  Provider (number or id): ")))).trim();
		provider = featured[Number(a) - 1]?.id ?? a;
	}
	const info = providers.find((p) => p.id === provider);
	if (!info) throw new Error(`Unknown provider "${provider}"`);
	let method: "oauth" | "api" = info.oauth && !info.apiKey ? "oauth" : "api";
	if (info.oauth && info.apiKey) {
		const a = (await ask(accent(T(`  ${info.name}: [1] Login con account (OAuth)  [2] API key › `, `  ${info.name}: [1] Sign in with account (OAuth)  [2] API key › `)))).trim();
		method = a === "1" || a.toLowerCase().startsWith("o") ? "oauth" : "api";
	}
	if (method === "api") {
		const key = (await ask(accent(T("  Incolla la API key: ", "  Paste the API key: ")))).trim();
		if (!key) throw new Error(T("Nessuna chiave inserita", "No key entered"));
		setApiKey(info.id, key);
		console.log(ok(`  ✓ ${info.name} ${T("collegato con API key", "connected with API key")}`));
		return;
	}
	if (info.id === "anthropic") {
		console.log(warn(T(
			"  Nota: i termini di Anthropic possono limitare l'uso degli abbonamenti Pro/Max fuori dalle app ufficiali. Usalo a tuo rischio; la API key è l'opzione supportata.",
			"  Note: Anthropic's terms may restrict using Pro/Max subscriptions outside official apps. Use at your own risk; an API key is the supported option.",
		)));
	}
	const manual = new AbortController();
	await loginOAuth(info.id, {
		onAuth: ({ url, instructions }) => {
			console.log(`\n  ${T("Apri questo link per accedere", "Open this link to sign in")}:\n  ${chalk.underline(url)}\n`);
			if (instructions) console.log(dim("  " + instructions));
			openUrl(url);
		},
		onPrompt: async (p) => (await ask(accent(`  ${p.message}${p.placeholder ? dim(` (${p.placeholder})`) : ""}: `))).trim(),
		onManualCodeInput: () =>
			ask(dim(T("  (oppure incolla qui il codice / URL di ritorno) › ", "  (or paste the code / redirect URL here) › ")), manual.signal).catch(() => new Promise<string>(() => {})),
		onProgress: (m) => console.log(dim("  " + m)),
		onSelect: async (p) => {
			console.log("  " + p.message);
			p.options.forEach((o, i) => console.log(`   ${dim(String(i + 1))} ${o.label}`));
			const a = await ask(accent("  › "));
			return p.options[Number(a) - 1]?.id;
		},
	});
	manual.abort();
	console.log(ok(`\n  ✓ ${info.name} ${T("collegato", "connected")}`));
}

export function doLogout(provider: string): void {
	removeCredential(provider);
	console.log(ok(`  ✓ ${T("Credenziali rimosse per", "Credentials removed for")} ${provider}`));
}

export function printLimits(): void {
	const l = limitStatus();
	const s = loadSettings();
	const state = s.limits.enabled ? ok(T("attivi", "on")) : dim(T("disattivati", "off"));
	console.log(box(T("Limiti di utilizzo", "Usage limits"), [
		`${T("Stato", "Status")}: ${state}   ${T("Unità", "Unit")}: ${s.limits.unit === "cost" ? T("credito ($)", "credit ($)") : "token"}   ${T("Al 100%", "At 100%")}: ${s.limits.action === "block" ? T("blocca", "block") : T("avvisa", "warn")}`,
		"",
		limitLine(l, it()),
		"",
		`${T("Speso", "Spent")}: ${chalk.bold("$" + l.spend.today.toFixed(2))} ${dim(T("oggi", "today"))}  ·  $${l.spend.fiveHour.toFixed(2)} ${dim("5h")}  ·  $${l.spend.weekly.toFixed(2)} ${dim(T("settimana", "week"))}  ·  $${l.spend.month.toFixed(2)} ${dim(T("mese", "month"))}  ·  $${l.spend.total.toFixed(2)} ${dim(T("totale", "total"))}`,
		"",
		dim(`${T("5h", "5h")}: ${s.limits.fiveHour.mode === "block" ? T("finestra che parte dal primo messaggio", "window starting at first message") : T("ultime 5 ore (mobile)", "rolling last 5 hours")} · ${T("reset settimanale", "weekly reset")}: ${(it() ? ["dom", "lun", "mar", "mer", "gio", "ven", "sab"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])[s.limits.weekly.resetDay]} ${s.limits.weekly.resetHour}:00`),
		dim(`/limits on|off · /limits 5h <n> · /limits week <n> · /limits unit tokens|cost · /limits action block|warn`),
	].join("\n")));
}

/** Parse "2M", "500k", "$5", "5" into a number. */
export function parseAmount(v: string): number {
	const m = v.trim().replace(/^\$/, "").match(/^([\d.]+)\s*([kmb])?$/i);
	if (!m) throw new Error(`Invalid amount "${v}"`);
	const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k"] ?? 1;
	return Number(m[1]) * mult;
}

export function doLimits(args: string[]): void {
	const s = loadSettings();
	const [a, b] = args;
	if (!a) return printLimits();
	if (a === "on" || a === "off") s.limits.enabled = a === "on";
	else if (a === "5h") {
		if (b === "on" || b === "off") s.limits.fiveHour.enabled = b === "on";
		else if (b === "rolling" || b === "block") s.limits.fiveHour.mode = b;
		else s.limits.fiveHour.value = parseAmount(b);
	} else if (a === "week" || a === "weekly") {
		if (b === "on" || b === "off") s.limits.weekly.enabled = b === "on";
		else s.limits.weekly.value = parseAmount(b);
	} else if (a === "unit") s.limits.unit = b === "cost" ? "cost" : "tokens";
	else if (a === "action") s.limits.action = b === "warn" ? "warn" : "block";
	else if (a === "warn") s.limits.warnAt = Number(b);
	else if (a === "reset") {
		const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
		const d = days.indexOf((b ?? "").toLowerCase().slice(0, 3));
		if (d >= 0) s.limits.weekly.resetDay = d;
		if (args[2]) s.limits.weekly.resetHour = Number(args[2]);
	} else throw new Error(`Unknown option "${a}"`);
	saveSettings(s);
	printLimits();
}

export function printStats(range: "all" | "30d" | "7d" = "all"): void {
	const st = computeStats(range, it() ? "it" : "en");
	const cell = (k: string, v: string) => `${dim(k)}\n${chalk.bold(v)}`;
	const rows = [
		[T("Sessioni", "Sessions"), String(st.sessions), T("Messaggi", "Messages"), String(st.messages), T("Token totali", "Total tokens"), formatTokens(st.totalTokens), T("Giorni attivi", "Active days"), String(st.activeDays)],
		[T("Serie attuale", "Current streak"), `${st.currentStreak}d`, T("Serie record", "Longest streak"), `${st.longestStreak}d`, T("Ora di punta", "Peak hour"), st.peakHour === null ? "—" : String(st.peakHour), T("Modello preferito", "Favorite model"), st.favoriteModel ?? "—"],
	];
	void cell;
	console.log("");
	const grid: string[][] = [];
	for (const r of rows) {
		grid.push([0, 2, 4, 6].map((i) => dim(r[i])));
		grid.push([0, 2, 4, 6].map((i) => chalk.bold(r[i + 1])));
	}
	console.log(table(grid, 4));
	console.log("\n" + heatmap(st.days));
	console.log(`\n  ${dim(st.funFact)}   ${dim(T("Spesa equivalente", "Equivalent spend"))}: ${chalk.bold("$" + st.totalCost.toFixed(2))}`);
	if (st.models.length) {
		console.log("");
		console.log(table(st.models.slice(0, 8).map((m) => [accent(m.model), dim(m.provider), formatTokens(m.tokens), `$${m.cost.toFixed(2)}`, dim(`${m.calls} calls`)])));
	}
}

export function doConfig(args: string[]): void {
	const s = loadSettings();
	const [sub, key, ...rest] = args;
	if (!sub || sub === "path") {
		console.log(`  ${paths.settings}`);
		return;
	}
	if (sub === "get") {
		console.log(JSON.stringify(key ? getPath(s, key) : s, null, 2));
		return;
	}
	if (sub === "set") {
		if (!key) throw new Error("usage: config set <path> <value>");
		setPath(s, key, rest.join(" "));
		saveSettings(s);
		console.log(ok(`  ✓ ${key} = ${JSON.stringify(getPath(loadSettings(), key))}`));
		return;
	}
	throw new Error("usage: config [path|get [key]|set <key> <value>]");
}

export async function doMcp(args: string[]): Promise<void> {
	const s = loadSettings();
	const [sub, name, ...rest] = args;
	if (sub === "add") {
		if (!name || !rest.length) throw new Error("usage: mcp add <name> <command> [args…]   |   mcp add <name> <https://url>");
		const first = rest[0];
		s.mcp.servers[name] = /^https?:\/\//.test(first) ? { url: first, enabled: true } : { command: first, args: rest.slice(1), enabled: true };
		saveSettings(s);
	} else if (sub === "remove" || sub === "rm") {
		delete s.mcp.servers[name];
		saveSettings(s);
	} else if (sub === "enable" || sub === "disable") {
		if (s.mcp.servers[name]) s.mcp.servers[name].enabled = sub === "enable";
		saveSettings(s);
	}
	await syncMcp();
	const st = mcpStatus();
	if (!st.length) {
		console.log(dim(T("  Nessun server MCP. Aggiungi con: /mcp add <nome> <comando> [args]", "  No MCP servers. Add one with: /mcp add <name> <command> [args]")));
		return;
	}
	console.log(table(st.map((m) => [
		m.status === "connected" ? ok("●") : m.status === "error" ? err("●") : dim("○"),
		chalk.bold(m.name),
		dim(m.transport),
		m.status === "connected" ? `${m.tools.length} tools` : m.status === "error" ? err(m.error ?? "error") : dim(m.status),
	])));
}

export function printSkills(cwd: string): void {
	const s = loadSettings();
	const skills = listSkills(cwd, s, true);
	const cmds = listCommands(cwd, s);
	console.log(chalk.bold("  Skills"));
	if (!skills.length) console.log(dim(`  ${T("Nessuna skill. Crea", "No skills. Create")} ${paths.skills}/<name>/SKILL.md`));
	console.log(table(skills.map((k) => [k.enabled ? ok("●") : dim("○"), accent("/" + k.name), dim(k.source), k.description.slice(0, 70)])));
	console.log(chalk.bold(`\n  ${T("Comandi personalizzati", "Custom commands")}`));
	if (!cmds.length) console.log(dim(`  ${T("Nessuno. Crea", "None. Create")} ${paths.commands}/<name>.md`));
	console.log(table(cmds.map((c) => [accent("/" + c.name), dim(c.source), c.description.slice(0, 70)])));
}

export function printMemory(cwd: string): void {
	const mem = listMemory(cwd);
	if (!mem.length) return console.log(dim(T("  Nessun ricordo salvato.", "  No memories saved.")));
	console.log(table(mem.map((m) => [dim(m.id), m.scope === "global" ? accent("global") : muted("project"), m.content.slice(0, 90)])));
}

export function printSessions(query?: string): string[] {
	const list = listSessions({ query }).slice(0, 25);
	if (!list.length) {
		console.log(dim(T("  Nessuna sessione.", "  No sessions.")));
		return [];
	}
	console.log(table(list.map((m, i) => [dim(String(i + 1).padStart(2)), dim(m.id), chalk.bold(m.title.slice(0, 50)), dim(m.cwd.length > 40 ? "…" + m.cwd.slice(-39) : m.cwd), dim(new Date(m.updatedAt).toLocaleString())])));
	return list.map((m) => m.id);
}

export type { Interface };

/** Find an environment by id, exact name or folder (case-insensitive). */
export function findEnv(ref: string) {
	const r = ref.trim().toLowerCase();
	const envs = listEnvironments();
	return envs.find((e) => e.id === ref) ?? envs.find((e) => e.name.toLowerCase() === r) ?? envs.find((e) => e.cwd.toLowerCase() === r);
}

/** Delete an environment; asks what to do with its sessions unless decided by flags. */
export async function doEnvRemove(ref: string | undefined, ask: Ask, mode?: "keep" | "delete"): Promise<void> {
	if (!ref) throw new Error("usage: env rm <name|id> [--keep-sessions|--delete-sessions]");
	const env = findEnv(ref);
	if (!env) throw new Error(T(`Ambiente "${ref}" non trovato`, `Environment "${ref}" not found`));
	const n = listSessions({ envId: env.id, includeArchived: true }).length;
	console.log(`  ${chalk.bold(env.name)} ${dim(env.cwd)} ${dim(`· ${n} ${T("sessioni", "sessions")}`)}`);
	console.log(dim(T("  La cartella sul disco non viene toccata.", "  The folder on disk is not touched.")));
	if (!mode) {
		if (n) {
			const a = (await ask(accent(T(`  Sessioni: [1] mantieni (passano a "nessun ambiente")  [2] elimina  [invio] annulla › `, `  Sessions: [1] keep (move to "no environment")  [2] delete  [enter] cancel › `)))).trim();
			if (a !== "1" && a !== "2") return console.log(dim(T("  Annullato.", "  Cancelled.")));
			mode = a === "2" ? "delete" : "keep";
		} else {
			const a = (await ask(accent(T("  Eliminare l'ambiente? [s/N] ", "  Delete the environment? [y/N] ")))).trim().toLowerCase();
			if (a !== "s" && a !== "y") return console.log(dim(T("  Annullato.", "  Cancelled.")));
			mode = "keep";
		}
	}
	const r = removeEnvironment(env.id, { deleteSessions: mode === "delete" });
	console.log(ok(`  ✓ ${T("Ambiente eliminato", "Environment deleted")}${r.sessions ? ` · ${r.sessions} ${T("sessioni", "sessions")} ${mode === "delete" ? T("eliminate", "deleted") : T("spostate in «nessun ambiente»", "moved to “no environment”")}` : ""}`));
}
