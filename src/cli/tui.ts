// Argon CLI — full-screen interactive interface.
import { emitKeypressEvents } from "node:readline";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import chalk from "chalk";
import type { ImageContent } from "@mariozechner/pi-ai";
import {
	ArgonSession,
	loadSettings,
	saveSettings,
	getPath,
	setPath,
	limitStatus,
	sessionUsage,
	usageDetail,
	listCommands,
	listSkills,
	listAgents,
	syncMcp,
	mcpStatus,
	reconnectMcp,
	addMemory,
	removeMemory,
	listMemory,
	listSessions,
	loadSession,
	updateSessionMeta,
	deleteSession,
	searchSessions,
	listEnvironments,
	addEnvironment,
	updateEnvironment,
	environmentForCwd,
	sessionToMarkdown,
	gitInfo,
	projectContextFiles,
	initPrompt,
	listProviders,
	refreshModels,
	modelKey,
	effortProfile,
	githubStatus,
	connectGithubToken,
	disconnectGithub,
	createPullRequest,
	gitState,
	formatTokens,
	paths,
	MODES,
	VERSION,
	type ArgonEvent,
	type Effort,
	type PermissionMode,
	type LimitStatus,
} from "../core/index.js";
import { walk } from "../core/tools/util.js";
import { accent, accentDeep, dim, err, gradient, MarkdownStream, muted, ok, setAccent, table, warn, heatmap } from "./ui.js";
import { Screen, padAnsi, truncateAnsi, visibleWidth, wrapAnsi } from "./screen.js";
import { T, it, doLogin, doLogout, doLimits, doMcp, printLimits, printProviders, printStats, printSkills, doEnvRemove } from "./commands.js";

export interface TuiOptions {
	cwd: string;
	model?: string;
	effort?: Effort;
	mode?: PermissionMode;
	resumeId?: string;
	initialPrompt?: string;
}

interface PickItem<V = string> {
	label: string;
	value: V;
	detail?: string;
	right?: string;
	disabled?: boolean;
}

interface Picker {
	title: string;
	items: PickItem<any>[];
	sel: number;
	resolve: (v: any) => void;
	hint?: string;
}

interface PromptState {
	title: string;
	secret?: boolean;
	resolve: (v: string | undefined) => void;
}

const MODE_ORDER: PermissionMode[] = ["ask", "acceptEdits", "auto", "plan"];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORDS = { it: ["Ionizzando", "Eccitando elettroni", "Distillando", "Ragionando", "Sintetizzando", "Calibrando"], en: ["Ionizing", "Exciting electrons", "Distilling", "Reasoning", "Synthesizing", "Calibrating"] };

const LABELS: Record<string, [string, string]> = {
	read: ["Leggi", "Read"], write: ["Scrivi", "Write"], edit: ["Modifica", "Edit"], bash: ["Shell", "Shell"], ls: ["Elenca", "List"],
	glob: ["Trova file", "Glob"], grep: ["Cerca", "Search"], web_fetch: ["Web", "Fetch"], web_search: ["Ricerca web", "Web search"],
	todo: ["Attività", "Tasks"], memory: ["Memoria", "Memory"], skill: ["Skill", "Skill"], task: ["Sub-agente", "Sub-agent"],
	ask_user: ["Domanda", "Question"], bash_output: ["Output", "Output"], kill_bash: ["Ferma processo", "Stop process"],
};
const label = (n: string) => (LABELS[n] ? LABELS[n][it() ? 0 : 1] : n.startsWith("mcp__") ? n.split("__").slice(1).join(" · ") : n);
const argOf = (a: any) => String(a?.command ?? a?.path ?? a?.pattern ?? a?.url ?? a?.query ?? a?.description ?? a?.name ?? "").replace(/\s+/g, " ");
const effortName = (e: string) =>
	({ off: T("nessuno", "off"), minimal: T("minimo", "minimal"), low: T("basso", "low"), medium: T("medio", "medium"), high: T("alto", "high"), xhigh: "extra", max: T("massimo", "max") })[e] ?? e;
const fmt$ = (v: number) => "$" + (v < 1 ? v.toFixed(3) : v.toFixed(2));

/** Coloured ring glyph like the GUI's usage ring. */
function ring(pct: number): string {
	const g = ["○", "◔", "◑", "◕", "●"][Math.min(4, Math.floor(Math.max(0, pct) / 25))];
	return (pct >= 100 ? err : pct >= 80 ? warn : ok)(g);
}

export async function runTui(opts: TuiOptions): Promise<void> {
	const settings = loadSettings();
	setAccent(settings.cli.accent);
	const screen = new Screen();
	const out = process.stdout;
	const stdin = process.stdin;

	// ───────────── state ─────────────
	let session!: ArgonSession;
	let unsub: (() => void) | null = null;
	let text = "";
	let cur = 0;
	const history: string[] = existsSync(paths.history) ? readFileSync(paths.history, "utf8").split("\n").filter(Boolean).slice(-500) : [];
	let hIndex = history.length;
	let suggest: { items: PickItem[]; sel: number; kind: "slash" | "file"; start: number } | null = null;
	let picker: Picker | null = null;
	let promptState: PromptState | null = null;
	let approval: { e: Extract<ArgonEvent, { type: "approval_request" }>; sel: number } | null = null;
	let question: { e: Extract<ArgonEvent, { type: "question" }>; sel: number } | null = null;
	let pasting = false;
	let exitArmed = 0;
	let spinFrame = 0;
	let word = WORDS.en[0];
	let runStart = 0;
	let thinkStart = 0;
	let outTokens = 0;
	let lastTurn: { secs: number; cost: number; tokens: number } | null = null;
	let md: MarkdownStream | null = null;
	let thinking: MarkdownStream | null = null;
	let lastLimitLevel = 0;
	const subagents = new Map<string, { agent: string; model?: string; steps: { tool: string; text: string; ok?: boolean }[]; done: boolean }>();
	const ctxFiles = () => projectContextFiles(opts.cwd, loadSettings());
	let git = gitInfo(opts.cwd);
	let files: string[] | null = null;

	// Existing printers write with console.log: route them into the transcript.
	const origLog = console.log;
	console.log = (...a: unknown[]) => screen.commit(a.map(String).join(" ").split("\n"));

	// ───────────── rendering ─────────────
	const W = () => screen.cols;
	const boxTop = (title = "") => {
		const t = title ? ` ${title} ` : "";
		return accentDeep("╭" + (t ? "─" : "") ) + (t ? chalk.bold(t) : "") + accentDeep("─".repeat(Math.max(0, W() - 2 - (t ? visibleWidth(t) + 1 : 0))) + "╮");
	};
	const boxRow = (s: string) => accentDeep("│") + " " + padAnsi(s, W() - 4) + " " + accentDeep("│");
	const boxBottom = (labelText = "") => {
		const l = labelText ? ` ${labelText} ` : "";
		return accentDeep("╰" + "─".repeat(Math.max(0, W() - 3 - visibleWidth(l)))) + dim(l) + accentDeep("─╯");
	};

	function modeLabel(m: PermissionMode): string {
		const meta = MODES.find((x) => x.id === m)!;
		const txt = (it() ? meta.labelIt : meta.label).toLowerCase();
		return m === "auto" ? warn(txt) : m === "plan" ? chalk.hex("#7dd3fc")(txt) : m === "acceptEdits" ? ok(txt) : txt;
	}

	function modelLabel(): string {
		const m = session.model;
		const prof = effortProfile(m);
		const eff = m.reasoning ? ` (${effortName(session.effort)})` : "";
		void prof;
		return `${m.name}${eff} · ${modeLabel(session.data.meta.mode)}`;
	}

	/** Editor text wrapped for the input box, plus the cursor position. */
	function editorLines(width: number): { lines: string[]; row: number; col: number } {
		const prefix = accent("❯ ");
		const pw = 2;
		const content = promptState?.secret ? "•".repeat(text.length) : text;
		const before = content.slice(0, promptState?.secret ? cur : cur);
		const rows: string[] = [];
		let row = 0;
		let col = pw;
		const avail = Math.max(10, width - pw);
		const logical = content.split("\n");
		let consumed = 0;
		logical.forEach((ln, li) => {
			const chunks: string[] = [];
			for (let i = 0; i < Math.max(1, Math.ceil(ln.length / avail)); i++) chunks.push(ln.slice(i * avail, (i + 1) * avail));
			chunks.forEach((c, ci) => {
				const start = consumed + ci * avail;
				const end = start + c.length;
				if (cur >= start && (cur < end || (cur === end && (ci === chunks.length - 1 || c.length < avail)))) {
					row = rows.length;
					col = pw + visibleWidth(content.slice(start, cur));
				}
				rows.push((rows.length === 0 ? prefix : "  ") + c);
			});
			consumed += ln.length + 1;
			void li;
		});
		if (!content && !rows.length) rows.push(prefix);
		if (!content) {
			const ph = promptState ? "" : picker ? T("Scrivi per cercare…", "Type to search…") : session?.status !== "idle" ? T("Scrivi per guidarlo mentre lavora…", "Type to steer it while it works…") : T("Scrivi un messaggio, / per i comandi, @ per i file", "Type a message, / for commands, @ for files");
			rows[0] = prefix + dim(ph);
			row = 0;
			col = pw;
		}
		void before;
		const max = 8;
		const startRow = Math.max(0, Math.min(rows.length - max, row - max + 1));
		return { lines: rows.slice(startRow, startRow + max), row: row - startRow, col };
	}

	function statusLine(): string {
		const s = loadSettings();
		const right: string[] = [];
		const activeSubs = [...subagents.values()].filter((x) => !x.done).length;
		if (activeSubs) right.push(accent(`⚙ ${activeSubs} ${T("sub-agenti", "sub-agents")}`));
		const bg = session?.background.running() ?? 0;
		if (bg) right.push(accent(`▣ ${bg} ${T("in background", "background")}`));
		let left: string;
		if (session?.status === "running" || session?.status === "compacting") {
			const secs = Math.floor((Date.now() - runStart) / 1000);
			const frame = s.cli.animations ? SPIN[spinFrame % SPIN.length] : "•";
			left = `${accent(frame)} ${s.cli.animations ? gradient(word + "…") : word + "…"} ${dim(`${secs}s · ↓${formatTokens(outTokens)} · esc ${T("per fermare", "to stop")}`)}`;
		} else if (lastTurn) left = dim(`✓ ${lastTurn.secs}s · ${fmt$(lastTurn.cost)} · ↓${formatTokens(lastTurn.tokens)}`);
		else left = "";
		const r = right.join(dim("  ·  "));
		return " " + padAnsi(left, Math.max(0, W() - 2 - visibleWidth(r))) + r;
	}

	function infoLine(): string {
		const s = loadSettings();
		const env = environmentForCwd(opts.cwd);
		const files = ctxFiles();
		const leftParts = [accent("◆ ") + chalk.bold(env?.name ?? opts.cwd.split(/[\\/]/).pop() ?? ""), dim(opts.cwd)];
		if (git.branch) leftParts.push(accent("⎇ ") + git.branch);
		if (files.length) leftParts.push(muted(files.join(", ")));
		const left = leftParts.join(dim(" · "));
		const right: string[] = [];
		if (session) {
			const c = session.contextUsage();
			right.push(dim(`ctx ${Math.round(c.percent)}%`));
			const u = sessionUsage(session.id);
			const l = limitStatus();
			const pct = Math.max(l.fiveHour.enabled ? l.fiveHour.percent : 0, l.weekly.enabled ? l.weekly.percent : 0);
			right.push(`${fmt$(u.cost)} ${ring(l.enabled ? pct : 0)}`);
			if (s.limits.enabled) right.push(dim(`5h ${Math.round(l.fiveHour.percent)}% · ${T("sett.", "wk")} ${Math.round(l.weekly.percent)}%`));
		}
		const r = right.join(dim(" · "));
		return " " + padAnsi(left, Math.max(0, W() - 3 - visibleWidth(r))) + " " + r;
	}

	function hintsLine(): string {
		const k = (key: string, what: string) => chalk.bold(key) + dim(":" + what);
		const sep = dim("  │  ");
		if (picker || suggest) return " " + [k("↑↓", T("scegli", "move")), k("enter", T("conferma", "select")), k("esc", T("chiudi", "close")), picker ? dim(T("scrivi per cercare", "type to search")) : k("tab", T("completa", "complete"))].join(sep);
		if (approval) return " " + [k("y", T("sì", "yes")), k("a", T("sempre", "always")), k("n", "no"), k("←→", T("scegli", "move"))].join(sep);
		return " " + [k("shift+tab", T("modalità", "mode")), k("esc", T("ferma", "stop")), k("/", T("comandi", "commands")), k("@", "file"), k("ctrl+c", T("esci", "exit"))].join(sep);
	}

	function listPanel(items: PickItem[], sel: number, max = 10): string[] {
		const startIdx = Math.max(0, Math.min(sel - Math.floor(max / 2), items.length - max));
		const rows: string[] = [];
		const slice = items.slice(startIdx, startIdx + max);
		const lw = Math.min(Math.max(...slice.map((i) => visibleWidth(i.label)), 10), Math.floor(W() * 0.4));
		slice.forEach((it_, k) => {
			const i = startIdx + k;
			const on = i === sel;
			const mark = on ? accent("❯ ") : "  ";
			const lab = padAnsi(it_.disabled ? dim(it_.label) : on ? chalk.bold(it_.label) : it_.label, lw);
			const right = it_.right ? " " + it_.right : "";
			const detail = it_.detail ? dim(it_.detail) : "";
			const line = ` ${mark}${lab}  ${padAnsi(detail, Math.max(0, W() - 8 - lw - visibleWidth(right)))}${right}`;
			rows.push(on ? chalk.bgHex("#2a2440")(padAnsi(line, W() - 1)) : line);
		});
		if (items.length > max) rows.push(dim(`   ${sel + 1}/${items.length}`));
		if (!items.length) rows.push(dim("   " + T("Nessun risultato", "No results")));
		return rows;
	}

	function filteredPicker(): PickItem[] {
		if (!picker) return [];
		const q = text.trim().toLowerCase();
		return q ? picker.items.filter((i) => (i.label + " " + (i.detail ?? "")).toLowerCase().includes(q)) : picker.items;
	}

	let renderQueued = false;
	function render() {
		if (renderQueued) return;
		renderQueued = true;
		queueMicrotask(() => {
			renderQueued = false;
			draw();
		});
	}

	function draw() {
		if (!session) return;
		const lines: string[] = [];
		let cursor: { row: number; col: number } | null = null;
		lines.push(statusLine());
		if (approval) {
			const e = approval.e;
			lines.push(warn(boxTop(`⚠ ${T("Permesso richiesto", "Permission needed")} · ${label(e.tool)}`)));
			const body = e.tool === "bash" ? `$ ${e.args.command}` : e.tool === "write" ? `${e.args.path} (${String(e.args.content ?? "").split("\n").length} ${T("righe", "lines")})` : e.tool === "edit" ? e.args.path : JSON.stringify(e.args);
			for (const l of wrapAnsi(chalk.white(String(body).slice(0, 400)), W() - 4).slice(0, 4)) lines.push(boxRow(l));
			if (e.outside?.length) lines.push(boxRow(warn(`${T("Scrive fuori dall'ambiente", "Writes outside the environment")} «${e.envName}»: `) + dim(e.outside.join(", "))));
			if (e.args?.description) lines.push(boxRow(dim(e.args.description)));
			const opts_ = [T("Sì", "Yes"), `${T("Sempre", "Always")} ${dim(e.outside ? T("(questa cartella)", "(this folder)") : e.suggestion)}`, "No"];
			lines.push(boxRow(opts_.map((o, i) => (i === approval!.sel ? chalk.bgHex("#3b2f55").bold(` ${o} `) : ` ${o} `)).join("   ")));
			lines.push(warn(boxBottom()));
		} else {
			const title = promptState ? promptState.title : picker ? `${picker.title}` : question ? T("Domanda", "Question") : "";
			if (question) {
				lines.push(boxTop(accent("? ") + chalk.bold(T("Domanda", "Question"))));
				for (const l of wrapAnsi(question.e.question, W() - 4)) lines.push(boxRow(l));
				question.e.options.forEach((o, i) => lines.push(boxRow((i === question!.sel ? accent("❯ ") + chalk.bold(o) : "  " + o))));
			} else lines.push(boxTop(title));
			const ed = editorLines(W() - 4);
			const boxStart = lines.length;
			ed.lines.forEach((l) => lines.push(boxRow(l)));
			cursor = { row: boxStart + ed.row, col: 2 + ed.col };
			const lab = promptState ? T("invio conferma · esc annulla", "enter confirm · esc cancel") : picker ? T("cerca", "search") : modelLabel();
			lines.push(boxBottom(lab));
		}
		if (picker) {
			const items = filteredPicker();
			picker.sel = Math.min(picker.sel, Math.max(0, items.length - 1));
			if (picker.hint) lines.push(dim("  " + picker.hint));
			lines.push(...listPanel(items, picker.sel));
		} else if (suggest) lines.push(...listPanel(suggest.items, suggest.sel, 8));
		if (loadSettings().cli.statusBar) lines.push(infoLine());
		lines.push(hintsLine());
		screen.setBottom(lines, approval ? null : cursor);
	}

	// ───────────── transcript helpers ─────────────
	const commit = (lines: string[] | string) => screen.commit(Array.isArray(lines) ? lines : lines.split("\n"));
	const time = () => (loadSettings().cli.timestamps ? dim(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : "");
	const notice = (level: "info" | "warn" | "error", msg: string) => commit(["", "  " + (level === "error" ? err("✖ " + msg) : level === "warn" ? warn("▲ " + msg) : dim("ℹ " + msg))]);

	function userBlock(t: string) {
		const bg = chalk.bgHex("#26232f");
		const tm = time();
		const lines = t.split("\n");
		const rows: string[] = [""];
		lines.forEach((l, i) => {
			const left = (i === 0 ? accent(" ❯ ") : "   ") + chalk.bold(l);
			const right = i === 0 && tm ? tm + " " : "";
			for (const seg of wrapAnsi(left, W() - 2 - visibleWidth(right))) rows.push(bg(padAnsi(seg + (seg === wrapAnsi(left, W() - 2 - visibleWidth(right))[0] ? "" : ""), W() - 1 - visibleWidth(right)) + right));
		});
		commit(rows);
	}

	function renderResult(name: string, result: any, isError: boolean) {
		const textOut: string = (result?.content ?? []).map((c: any) => (c.type === "text" ? c.text : "[image]")).join("\n");
		const d = result?.details ?? {};
		const pre = `    ${dim("⎿")}  `;
		if (isError) return commit(pre + err(textOut.split("\n").slice(0, 4).join(" ").slice(0, 400)));
		if (name === "edit" && d.diff) {
			const o = String(d.diff.old).split("\n");
			const n = String(d.diff.new).split("\n");
			commit([pre + `${ok("+" + d.added)} ${err("-" + d.removed)}`, ...o.slice(0, 5).map((l) => "       " + chalk.bgHex("#3b1219").hex("#fca5a5")("- " + l)), ...n.slice(0, 5).map((l) => "       " + chalk.bgHex("#0f2e1a").hex("#86efac")("+ " + l))]);
			return;
		}
		if (name === "read") return commit(pre + dim(`${d.lines ?? "?"} ${T("righe", "lines")}`));
		if (name === "task") return;
		const lines = textOut.split("\n");
		const max = name === "bash" ? 6 : 3;
		commit([pre + dim(lines[0] ?? ""), ...lines.slice(1, max).map((l) => "       " + dim(l)), ...(lines.length > max ? ["       " + dim(`… +${lines.length - max} ${T("righe", "lines")}`)] : [])]);
	}

	// ───────────── agent events ─────────────
	let liveTimer: NodeJS.Timeout | null = null;
	function scheduleLive() {
		if (liveTimer) return;
		liveTimer = setTimeout(() => {
			liveTimer = null;
			screen.setLive(md ? md.partial() : thinking ? thinking.partial() : []);
		}, 33);
	}

	function onEvent(e: ArgonEvent) {
		switch (e.type) {
			case "status":
				if (e.status !== "idle" && !runStart) {
					runStart = Date.now();
					outTokens = 0;
					word = (it() ? WORDS.it : WORDS.en)[Math.floor(Math.random() * WORDS.en.length)];
				}
				if (e.status === "compacting") word = T("Compattando", "Compacting");
				render();
				break;
			case "message_update": {
				const ev = e.assistantMessageEvent;
				if (ev.type === "text_start") {
					closeThinking();
					md = new MarkdownStream((s) => commit(s.replace(/\n$/, "").split("\n")), "  ");
					commit("");
				} else if (ev.type === "text_delta") {
					outTokens += Math.ceil(ev.delta.length / 4);
					md?.push(ev.delta);
					scheduleLive();
				} else if (ev.type === "text_end") {
					md?.flush();
					md = null;
					screen.clearLive();
				} else if (ev.type === "thinking_start") {
					thinkStart = Date.now();
					if (loadSettings().cli.showThinking) {
						thinking = new MarkdownStream((s) => commit(s.replace(/\n$/, "").split("\n").map((l) => dim.italic(l))), "  ");
						commit(["", "  " + dim.italic("✻ " + T("Ragionamento", "Thinking"))]);
					} else word = T("Ragionando", "Thinking");
				} else if (ev.type === "thinking_delta") {
					outTokens += Math.ceil(ev.delta.length / 4);
					if (thinking) {
						thinking.push(ev.delta);
						scheduleLive();
					}
				} else if (ev.type === "thinking_end") closeThinking();
				render();
				break;
			}
			case "tool_execution_start":
				if (e.toolName === "todo") break;
				commit(["", `  ${accent("⏺")} ${chalk.bold(label(e.toolName))} ${dim(truncateAnsi(argOf(e.args), W() - 20))}`]);
				word = label(e.toolName);
				break;
			case "tool_execution_end":
				if (e.toolName !== "todo") renderResult(e.toolName, e.result, e.isError);
				if (["write", "edit", "bash"].includes(e.toolName)) git = gitInfo(opts.cwd);
				render();
				break;
			case "todos":
				commit(["", ...e.todos.map((t) => `    ${t.status === "completed" ? ok("✔") : t.status === "in_progress" ? accent("◐") : dim("○")} ${t.status === "completed" ? dim.strikethrough(t.content) : t.status === "in_progress" ? chalk.bold(t.content) : t.content}`)]);
				break;
			case "subagent": {
				const s = subagents.get(e.toolCallId) ?? { agent: e.agent, steps: [], done: false };
				subagents.set(e.toolCallId, s);
				if (e.phase === "start") {
					s.model = e.model;
					commit(`    ${dim("↳")} ${accent(e.agent)} ${dim(e.model ?? "")}`);
				} else if (e.phase === "step") {
					s.steps.push({ tool: e.tool ?? "", text: e.text ?? "" });
					commit(`      ${dim("·")} ${dim(label(e.tool ?? ""))} ${dim(truncateAnsi(e.text ?? "", W() - 30))}`);
				} else if (e.phase === "step_end") {
					const st = [...s.steps].reverse().find((x) => x.tool === e.tool && x.ok === undefined);
					if (st) st.ok = !e.isError;
				} else if (e.phase === "end") {
					s.done = true;
					commit(`    ${dim(`↳ ${e.agent}: ${e.steps} ${T("passi", "steps")}`)}`);
				}
				render();
				break;
			}
			case "background":
				render();
				break;
			case "approval_request":
				approval = { e, sel: 0 };
				screen.bell();
				render();
				break;
			case "question":
				question = { e, sel: 0 };
				text = "";
				cur = 0;
				render();
				break;
			case "notice":
				notice(e.level, e.text);
				break;
			case "limits":
				checkLimits(e.limits);
				break;
			case "agent_end": {
				closeThinking();
				md?.flush();
				md = null;
				screen.clearLive();
				const secs = runStart ? Math.round((Date.now() - runStart) / 1000) : 0;
				const u = sessionUsage(session.id);
				lastTurn = { secs, cost: u.cost - (turnStartCost ?? 0), tokens: outTokens };
				runStart = 0;
				git = gitInfo(opts.cwd);
				screen.title(`Argon · ${session.data.meta.title}`);
				render();
				break;
			}
		}
	}
	let turnStartCost = 0;

	function closeThinking() {
		if (thinking) {
			thinking.flush();
			thinking = null;
			screen.clearLive();
		} else if (thinkStart) commit(["", "  " + dim(`◆ ${T("Ha ragionato per", "Thought for")} ${((Date.now() - thinkStart) / 1000).toFixed(1)}s`)]);
		thinkStart = 0;
	}

	function checkLimits(l: LimitStatus) {
		if (!l.enabled || !loadSettings().cli.notifyLimits) return;
		const pct = Math.max(l.fiveHour.enabled ? l.fiveHour.percent : 0, l.weekly.enabled ? l.weekly.percent : 0);
		const level = pct >= 100 ? 2 : pct >= l.warnAt ? 1 : 0;
		if (level > lastLimitLevel) {
			const which = l.fiveHour.enabled && l.fiveHour.percent >= (level === 2 ? 100 : l.warnAt) ? T("limite delle 5 ore", "5-hour limit") : T("limite settimanale", "weekly limit");
			screen.bell();
			commit(["", level === 2 ? err(`  ■ ${T("Hai raggiunto il", "You reached the")} ${which}.`) : warn(`  ▲ ${T("Sei al", "You are at")} ${Math.round(pct)}% ${T("del", "of the")} ${which}.`)]);
		}
		lastLimitLevel = level;
	}

	// ───────────── pickers & prompts ─────────────
	function pick<V>(title: string, items: PickItem<V>[], o: { sel?: number; hint?: string } = {}): Promise<V | undefined> {
		return new Promise((res) => {
			picker = { title, items, sel: Math.max(0, o.sel ?? 0), resolve: res, hint: o.hint };
			text = "";
			cur = 0;
			suggest = null;
			render();
		});
	}

	function ask(title: string, o: { initial?: string; secret?: boolean; signal?: AbortSignal } = {}): Promise<string | undefined> {
		return new Promise((res) => {
			const done = (v: string | undefined) => {
				promptState = null;
				text = "";
				cur = 0;
				render();
				res(v);
			};
			promptState = { title, secret: o.secret, resolve: done };
			text = o.initial ?? "";
			cur = text.length;
			o.signal?.addEventListener("abort", () => promptState?.resolve === done && done(undefined), { once: true });
			render();
		});
	}
	// commands.ts helpers expect ask(q, signal) → string
	const askStr = async (q: string, signal?: AbortSignal) => (await ask(stripQ(q), { signal, secret: /key|chiave|token/i.test(q) })) ?? "";
	const stripQ = (q: string) => q.replace(/\x1b\[[0-9;]*m/g, "").trim().replace(/[:›]\s*$/, "");

	// ───────────── session ─────────────
	async function startSession(o: { resumeId?: string; model?: string } = {}) {
		unsub?.();
		const env = environmentForCwd(opts.cwd);
		session = await ArgonSession.create({ cwd: opts.cwd, envId: env?.id ?? null, model: o.model ?? opts.model, effort: opts.effort, mode: opts.mode, resumeId: o.resumeId, origin: "cli" });
		unsub = session.subscribe(onEvent);
		subagents.clear();
		lastTurn = null;
		screen.title(`Argon · ${session.data.meta.title}`);
	}

	async function openingAnimation() {
		const s = loadSettings();
		if (!s.cli.animations || !s.cli.showBanner) return;
		const frames = 14;
		for (let f = 0; f <= frames; f++) {
			const t = f / frames;
			const orbit = ["·", "•", "∙", "◦"];
			const a = (f / frames) * Math.PI * 2;
			const ex = Math.round(Math.cos(a) * 5) + 6;
			const ey = Math.round(Math.sin(a) * 1.4) + 2;
			const grid = Array.from({ length: 5 }, () => Array(14).fill(" "));
			const tile = ["╭──────────╮", "│ 18       │", "│    Ar    │", "│  Argon   │", "╰──────────╯"];
			const shown = Math.ceil(t * tile.length);
			const lines = tile.slice(0, shown).map((l, i) => {
				let row = l;
				if (i === ey && ex < row.length) row = row.slice(0, ex) + orbit[f % 4] + row.slice(ex + 1);
				return "  " + (i === 2 ? accentDeep("│") + "    " + chalk.bold(gradient("Ar", t > 0.5 ? "#c4b5fd" : "#6d28d9", "#22d3ee")) + "    " + accentDeep("│") : accentDeep(row));
			});
			void grid;
			screen.setLive(lines);
			await new Promise((r) => setTimeout(r, 45));
		}
		screen.clearLive();
	}

	function banner() {
		const s = loadSettings();
		const env = environmentForCwd(opts.cwd);
		const fileList = ctxFiles();
		const info = [
			"",
			`${chalk.bold(gradient("Argon"))} ${dim("v" + VERSION)}  ${dim(T("· il tuo agente AI open source", "· your open-source AI agent"))}`,
			`${accent(session.model.name)} ${dim("·")} ${effortName(session.effort)} ${dim("·")} ${modeLabel(session.data.meta.mode)}`,
			`${env ? chalk.bold(env.name) + dim(" · ") : ""}${dim(opts.cwd)}${git.branch ? "  " + accent("⎇ ") + git.branch : ""}${fileList.length ? dim(" · ") + muted(fileList.join(", ")) : ""}`,
			dim(T("/ per i comandi · @ per allegare file · shift+tab cambia modalità", "/ for commands · @ to attach files · shift+tab changes mode")),
		];
		if (!s.cli.showBanner) return commit(info.slice(1).map((l) => "  " + l));
		const tile = ["╭──────────╮", "│ 18       │", "│    Ar    │", "│  Argon   │", "│  39.948  │", "╰──────────╯"];
		commit(
			tile.map((l, i) => {
				const c =
					i === 2
						? accentDeep("│") + "    " + chalk.bold(gradient("Ar")) + "    " + accentDeep("│")
						: i === 1
							? accentDeep("│ ") + muted("18") + "       " + accentDeep("│")
							: i === 3
								? accentDeep("│  ") + chalk.white("Argon") + "   " + accentDeep("│")
								: i === 4
									? accentDeep("│  ") + muted("39.948") + "  " + accentDeep("│")
									: accentDeep(l);
				return `  ${c}   ${info[i] ?? ""}`;
			}),
		);
		const l = limitStatus();
		if (s.limits.enabled) commit(["", "  " + dim(`5h ${Math.round(l.fiveHour.percent)}% · ${T("settimana", "week")} ${Math.round(l.weekly.percent)}% · ${T("oggi", "today")} ${fmt$(l.spend.today)}`)]);
	}

	function replay() {
		for (const m of session.agent.state.messages.slice(-14) as any[]) {
			if (m.role === "user") {
				const t = typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "[image]").join(" ");
				userBlock(t.slice(0, 600));
			} else if (m.role === "assistant") {
				for (const c of m.content) {
					if (c.type === "text") {
						const r = new MarkdownStream((s) => commit(s.replace(/\n$/, "").split("\n")), "  ");
						commit("");
						r.push(c.text);
						r.flush();
					} else if (c.type === "toolCall" && c.name !== "todo") commit(`  ${accent("⏺")} ${chalk.bold(label(c.name))} ${dim(truncateAnsi(argOf(c.arguments), W() - 20))}`);
				}
			}
		}
	}

	// ───────────── running prompts ─────────────
	function parseMentions(input: string): { text: string; images: ImageContent[] } {
		const images: ImageContent[] = [];
		const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
		const txt = input.replace(/@("[^"]+"|\S+)/g, (m, p) => {
			const path = resolve(opts.cwd, p.replace(/"/g, ""));
			if (!existsSync(path)) return m;
			const mt = mime[extname(path).toLowerCase()];
			if (mt) {
				images.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: mt });
				return `[image: ${p}]`;
			}
			return `${p} (file: ${path})`;
		});
		return { text: txt, images };
	}

	async function run(input: string, display = input) {
		const { text: t, images } = parseMentions(input);
		if (session.status !== "idle") {
			commit(`  ${dim("↳ " + T("in coda", "queued") + ": " + display)}`);
			void session.prompt(t, images);
			return;
		}
		userBlock(display);
		turnStartCost = sessionUsage(session.id).cost;
		runStart = Date.now();
		outTokens = 0;
		word = (it() ? WORDS.it : WORDS.en)[Math.floor(Math.random() * WORDS.en.length)];
		render();
		await session.prompt(t, images);
		render();
	}

	// ───────────── commands ─────────────
	type Cmd = { name: string; it: string; en: string; args?: string; run: (rest: string, args: string[]) => Promise<void> | void };
	const scopeSessions = () => {
		const s = loadSettings();
		const env = environmentForCwd(opts.cwd);
		const all = listSessions();
		if (s.cli.sessionScope === "all") return all;
		return all.filter((m) => (env ? m.envId === env.id : false) || m.cwd.toLowerCase() === opts.cwd.toLowerCase());
	};
	const sessionItems = (list = scopeSessions()) =>
		list.map((m) => ({ label: m.title === "New session" ? T("Nuova sessione", "New session") : m.title, value: m.id, detail: `${m.cwd}`, right: dim(new Date(m.updatedAt).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })) }));

	async function pickModel() {
		const provs = listProviders().filter((p) => p.connected);
		if (!provs.length) return notice("warn", T("Nessun provider collegato: usa /login.", "No provider connected: use /login."));
		const curProv = session.model.provider;
		const prov = await pick(
			T("Provider", "Provider"),
			provs.map((p) => ({ label: p.name, value: p.id, detail: p.id === curProv ? session.model.name : "", right: p.id === curProv ? ok("●") : "" })),
			{ sel: Math.max(0, provs.findIndex((p) => p.id === curProv)) },
		);
		if (!prov) return;
		const r = await refreshModels(prov);
		const items = r.models.map((m) => ({
			label: m.name,
			value: modelKey(m),
			detail: m.id,
			right: dim(`${formatTokens(m.contextWindow)} · ${m.cost.input || m.cost.output ? `$${+m.cost.input.toFixed(2)}/$${+m.cost.output.toFixed(2)}` : T("gratis", "free")}`) + (m.reasoning ? accent(" ✻") : ""),
		}));
		const key = await pick(`${provs.find((p) => p.id === prov)?.name} · ${items.length} ${T("modelli", "models")}${r.live ? "" : dim(" (" + T("catalogo", "catalog") + ")")}`, items, {
			sel: Math.max(0, items.findIndex((i) => i.value === modelKey(session.model))),
			hint: T("Scrivi per cercare per nome, id o prezzo", "Type to search by name, id or price"),
		});
		if (!key) return;
		const m = session.setModel(key);
		commit("  " + ok("✓ ") + chalk.bold(m.name) + dim(` (${key}) · ${T("predefinito anche per la GUI", "default for the GUI too")}`));
	}

	async function pickEffort() {
		const p = effortProfile(session.model);
		if (!session.model.reasoning) return notice("info", T("Questo modello non supporta il ragionamento.", "This model does not support reasoning."));
		const warnings: Record<string, string> = { xhigh: warn("~2×"), max: warn("3×+") };
		const e = await pick(
			`${T("Ragionamento", "Effort")} · ${session.model.name}`,
			p.levels.map((l) => ({ label: effortName(l), value: l, detail: l === p.default ? T("predefinito", "default") : "", right: warnings[l] ?? "" })),
			{ sel: Math.max(0, p.levels.indexOf(session.effort as any)), hint: p.source === "provider" ? T("Livelli dichiarati dal provider per questo modello", "Levels reported by the provider for this model") : T("Livelli dal catalogo", "Levels from the catalog") },
		);
		if (!e) return;
		session.setEffort(e as Effort);
		commit("  " + ok("✓ ") + T("Ragionamento: ", "Effort: ") + chalk.bold(effortName(e)));
	}

	async function pickMode() {
		const m = await pick(
			T("Modalità", "Mode"),
			MODES.map((x) => ({ label: it() ? x.labelIt : x.label, value: x.id, detail: it() ? x.descIt : x.desc })),
			{ sel: MODE_ORDER.indexOf(session.data.meta.mode) },
		);
		if (!m) return;
		session.setMode(m);
		commit("  " + ok("✓ ") + modeLabel(m));
	}

	async function resume(id?: string) {
		if (!id) {
			const items = sessionItems();
			if (!items.length) return notice("info", T("Nessuna sessione in questo ambiente (cambia in /settings → Sessioni mostrate).", "No sessions in this environment (change it in /settings → Sessions shown)."));
			id = await pick(T("Riprendi una sessione", "Resume a session"), items, { hint: T("Scrivi per cercare", "Type to search") });
		}
		if (!id) return;
		await startSession({ resumeId: id });
		commit(["", "  " + ok("✓ ") + T("Ripresa: ", "Resumed: ") + chalk.bold(session.data.meta.title)]);
		replay();
	}

	async function settingsMenu() {
		type Item = { path: string; it: string; en: string; kind: "bool" | "enum" | "text" | "number"; options?: [string, string][]; shared?: boolean };
		const items: Item[] = [
			{ path: "cli.language", it: "Lingua", en: "Language", kind: "enum", options: [["it", "Italiano"], ["en", "English"]] },
			{ path: "cli.accent", it: "Colore", en: "Accent colour", kind: "enum", options: [["violet", "Violet"], ["cyan", "Cyan"], ["green", "Green"], ["amber", "Amber"], ["rose", "Rose"]] },
			{ path: "cli.showBanner", it: "Logo all'avvio", en: "Startup logo", kind: "bool" },
			{ path: "cli.animations", it: "Animazioni", en: "Animations", kind: "bool" },
			{ path: "cli.timestamps", it: "Orari dei messaggi", en: "Message timestamps", kind: "bool" },
			{ path: "cli.showThinking", it: "Mostra il ragionamento", en: "Show thinking", kind: "bool" },
			{ path: "cli.statusBar", it: "Riga di stato", en: "Status row", kind: "bool" },
			{ path: "cli.sessionScope", it: "Sessioni mostrate", en: "Sessions shown", kind: "enum", options: [["environment", T("Ambiente corrente", "Current environment")], ["all", T("Tutte", "All")]] },
			{ path: "cli.notifyLimits", it: "Avvisi sui limiti", en: "Limit alerts", kind: "bool" },
			{ path: "context.initFile", it: "File creato da /init", en: "File created by /init", kind: "text", shared: true },
			{ path: "permissions.sandbox", it: "Sandbox degli ambienti", en: "Environment sandbox", kind: "bool", shared: true },
			{ path: "limits.enabled", it: "Limiti di utilizzo", en: "Usage limits", kind: "bool", shared: true },
			{ path: "limits.warnAt", it: "Soglia di avviso (%)", en: "Warning threshold (%)", kind: "number", shared: true },
			{ path: "general.autoTitle", it: "Titoli automatici", en: "Automatic titles", kind: "bool", shared: true },
		];
		let sel = 0;
		for (;;) {
			const s = loadSettings();
			const show = (i: Item) => {
				const v = getPath(s, i.path);
				return i.kind === "bool" ? (v ? ok("● on") : dim("○ off")) : i.kind === "enum" ? accent(i.options!.find((o) => o[0] === v)?.[1] ?? String(v)) : accent(String(v));
			};
			const choice = await pick(
				T("Impostazioni di Argon CLI", "Argon CLI settings"),
				items.map((i) => ({ label: T(i.it, i.en), value: i.path, detail: i.shared ? T("condivisa con la GUI", "shared with the GUI") : "", right: show(i) })),
				{ sel, hint: T("Indipendenti dalla GUI, tranne quelle indicate. Modificabili anche dalla GUI → Impostazioni → CLI.", "Independent from the GUI unless marked. Also editable in GUI → Settings → CLI.") },
			);
			if (!choice) return;
			sel = items.findIndex((i) => i.path === choice);
			const item = items[sel];
			const next = loadSettings();
			if (item.kind === "bool") setPath(next, item.path, !getPath(next, item.path));
			else if (item.kind === "enum") {
				const v = await pick(T(item.it, item.en), item.options!.map(([v, l]) => ({ label: l, value: v })), { sel: item.options!.findIndex((o) => o[0] === getPath(next, item.path)) });
				if (!v) continue;
				setPath(next, item.path, v);
			} else {
				const v = await ask(T(item.it, item.en), { initial: String(getPath(next, item.path) ?? "") });
				if (v === undefined) continue;
				setPath(next, item.path, v);
			}
			saveSettings(next);
			if (item.path === "cli.accent") setAccent(next.cli.accent);
		}
	}

	function usageChart(range: "today" | "7d" | "30d" | "all") {
		const d = usageDetail(range);
		const blocks = " ▁▂▃▄▅▆▇█";
		const days = d.daily.slice(-30);
		const max = Math.max(0.0001, ...days.map((x) => x.cost));
		const H = 6;
		const rows: string[] = ["", "  " + chalk.bold(T("Utilizzo dettagliato", "Detailed usage")) + dim(` · ${range}`), ""];
		for (let r = H - 1; r >= 0; r--) {
			let line = "  ";
			for (const x of days) {
				const v = (x.cost / max) * H - r;
				line += v >= 1 ? accent("█") : v > 0 ? accent(blocks[Math.max(1, Math.round(v * 8))]) : dim(r === 0 ? "▁" : " ");
				line += " ";
			}
			if (r === H - 1) line += dim(` ${fmt$(max)}`);
			rows.push(line);
		}
		rows.push("  " + dim(`${days[0]?.day ?? ""}${" ".repeat(Math.max(1, days.length * 2 - 20))}${days[days.length - 1]?.day ?? ""}`));
		rows.push("");
		const maxCost = Math.max(0.0001, ...d.rows.map((r) => r.cost));
		const tbl = [
			[dim(T("Modello", "Model")), dim("Provider"), dim(T("Chiamate", "Calls")), dim("Input"), dim("Output"), dim("Cache"), dim(T("Costo", "Cost")), ""],
			...d.rows.slice(0, 12).map((r) => [
				chalk.bold(r.model),
				dim(r.provider),
				String(r.calls),
				formatTokens(r.input),
				formatTokens(r.output),
				formatTokens(r.cacheRead + r.cacheWrite),
				chalk.bold(fmt$(r.cost)),
				accent("━".repeat(Math.max(1, Math.round((r.cost / maxCost) * 16)))) + (r.subagentCost ? dim(` ⚙ ${r.agents.join(",")} ${fmt$(r.subagentCost)}`) : ""),
			]),
			[chalk.bold(T("Totale", "Total")), "", String(d.totals.calls), formatTokens(d.totals.input), formatTokens(d.totals.output), formatTokens(d.totals.cacheRead + d.totals.cacheWrite), chalk.bold(fmt$(d.totals.cost)), d.totals.subagentCost ? dim(`${T("sub-agenti", "sub-agents")} ${fmt$(d.totals.subagentCost)}`) : ""],
		];
		rows.push(...table(tbl).split("\n"));
		if (d.byAgent.length > 1) {
			rows.push("", "  " + dim(T("Per agente", "By agent")));
			rows.push(...table(d.byAgent.map((a) => [a.agent === "main" ? T("principale", "main") : accent(a.agent), dim(`${a.calls} ${T("chiamate", "calls")}`), formatTokens(a.tokens), chalk.bold(fmt$(a.cost))])).split("\n"));
		}
		commit(rows);
	}

	const COMMANDS: Cmd[] = [
		{ name: "help", it: "Mostra i comandi", en: "Show commands", run: () => {
			commit(["", ...table(COMMANDS.map((c) => [accent("/" + c.name), dim(c.args ?? ""), T(c.it, c.en)])).split("\n")]);
			const s = loadSettings();
			const extra = [...listCommands(opts.cwd, s).map((c) => [accent("/" + c.name), "", dim(c.description)]), ...listSkills(opts.cwd, s).map((k) => [accent("/" + k.name), "", dim("skill · " + k.description.slice(0, 60))])];
			if (extra.length) commit(["", ...table(extra).split("\n")]);
		} },
		{ name: "new", it: "Nuova sessione", en: "New session", run: async () => {
			await startSession();
			commit(["", "  " + ok("✓ ") + T("Nuova sessione", "New session")]);
		} },
		{ name: "resume", it: "Riprendi una sessione (con ricerca)", en: "Resume a session (searchable)", args: "[id]", run: (rest) => resume(rest || undefined) },
		{ name: "sessions", it: "Sessioni dell'ambiente (con ricerca)", en: "Sessions of this environment (searchable)", run: () => resume() },
		{ name: "search", it: "Cerca nel testo di tutte le sessioni", en: "Search the text of all sessions", args: T("<testo>", "<text>"), run: async (rest) => {
			const q = rest || (await ask(T("Cerca nelle sessioni", "Search sessions")));
			if (!q) return;
			const res = searchSessions(q);
			const id = await pick(`${T("Risultati per", "Results for")} "${q}"`, res.map((r) => ({ label: r.meta.title, value: r.meta.id, detail: r.snippet })));
			if (id) await resume(id);
		} },
		{ name: "rename", it: "Rinomina la sessione", en: "Rename the session", args: T("[titolo]", "[title]"), run: async (rest) => {
			const t = rest || (await ask(T("Nuovo titolo", "New title"), { initial: session.data.meta.title }));
			if (t) session.rename(t);
		} },
		{ name: "pin", it: "Fissa / sblocca la sessione", en: "Pin / unpin the session", run: () => {
			session.data.meta.pinned = !session.data.meta.pinned;
			session.persist();
			commit("  " + ok("✓ ") + (session.data.meta.pinned ? T("Fissata", "Pinned") : T("Non più fissata", "Unpinned")));
		} },
		{ name: "archive", it: "Archivia la sessione", en: "Archive the session", run: async () => {
			session.data.meta.archived = true;
			session.persist();
			await startSession();
			commit("  " + ok("✓ ") + T("Archiviata. Nuova sessione aperta.", "Archived. New session opened."));
		} },
		{ name: "delete", it: "Elimina la sessione", en: "Delete the session", run: async () => {
			const y = await pick(T("Eliminare questa sessione?", "Delete this session?"), [{ label: T("No", "No"), value: "no" }, { label: err(T("Sì, elimina", "Yes, delete")), value: "yes" }]);
			if (y !== "yes") return;
			deleteSession(session.id);
			await startSession();
			commit("  " + ok("✓ ") + T("Sessione eliminata.", "Session deleted."));
		} },
		{ name: "export", it: "Esporta in Markdown", en: "Export to Markdown", args: "[file]", run: async (rest) => {
			const file = resolve(opts.cwd, rest || `argon-${session.id}.md`);
			writeFileSync(file, sessionToMarkdown(session.data));
			commit("  " + ok("✓ ") + file);
		} },
		{ name: "clear", it: "Svuota la conversazione", en: "Clear the conversation", run: () => {
			session.clear();
			commit(["", "  " + dim("— " + T("conversazione svuotata", "conversation cleared") + " —")]);
		} },
		{ name: "compact", it: "Riassumi la conversazione", en: "Summarize the conversation", args: T("[istruzioni]", "[instructions]"), run: (rest) => session.compact(rest) },
		{ name: "undo", it: "Annulla l'ultimo turno (file inclusi)", en: "Undo the last turn (files too)", run: () => {
			const r = session.undo();
			commit("  " + ok("✓ ") + T("Annullato", "Undone") + (r.files.length ? dim(" · " + r.files.map((f) => relative(opts.cwd, f)).join(", ")) : ""));
		} },
		{ name: "todos", it: "Lista attività", en: "Task list", run: () => onEvent({ type: "todos", todos: session.data.todos }) },
		{ name: "context", it: "Contesto e costo della sessione", en: "Context and session cost", run: () => {
			const c = session.contextUsage();
			const u = sessionUsage(session.id);
			commit(["", `  ${T("Contesto", "Context")}: ${chalk.bold(Math.round(c.percent) + "%")} ${dim(`(${c.used.toLocaleString()} / ${c.window.toLocaleString()})`)}`, `  ${T("Costo", "Cost")}: ${chalk.bold(fmt$(u.cost))} ${dim(`· ${formatTokens(u.tokens)} token`)}${u.subagentCost ? dim(` · ${T("sub-agenti", "sub-agents")} ${fmt$(u.subagentCost)}`) : ""}`, `  ${T("File di contesto", "Context files")}: ${ctxFiles().join(", ") || dim(T("nessuno", "none"))}`]);
		} },
		{ name: "model", it: "Cambia modello (provider → modelli, con ricerca)", en: "Switch model (provider → models, searchable)", args: T("[provider/modello]", "[provider/model]"), run: async (rest) => {
			if (rest) {
				try {
					const m = session.setModel(rest);
					return commit("  " + ok("✓ ") + chalk.bold(m.name) + dim(` (${modelKey(m)})`));
				} catch (e) {
					notice("error", (e as Error).message);
				}
			}
			await pickModel();
		} },
		{ name: "effort", it: "Livello di ragionamento (dal provider)", en: "Reasoning level (from the provider)", run: pickEffort },
		{ name: "mode", it: "Modalità dei permessi", en: "Permission mode", run: pickMode },
		{ name: "login", it: "Collega un provider (OAuth o API key)", en: "Connect a provider (OAuth or API key)", args: "[provider]", run: async (rest) => {
			let p = rest;
			if (!p) {
				const list = listProviders();
				p = (await pick(T("Collega un provider", "Connect a provider"), list.map((x) => ({ label: x.name, value: x.id, detail: x.hint ?? "", right: x.connected ? ok("✓ " + x.connected) : "" })), { hint: T("Scrivi per cercare", "Type to search") })) ?? "";
			}
			if (p) await doLogin(p, askStr);
		} },
		{ name: "logout", it: "Scollega un provider", en: "Disconnect a provider", run: async () => {
			const p = await pick(T("Scollega", "Disconnect"), listProviders().filter((x) => x.connected === "api" || x.connected === "oauth").map((x) => ({ label: x.name, value: x.id, right: x.connected ?? "" })));
			if (p) doLogout(p);
		} },
		{ name: "providers", it: "Provider e stato", en: "Providers and status", run: () => printProviders() },
		{ name: "github", it: "Collegamento con GitHub", en: "GitHub connection", run: async () => {
			const st = await githubStatus(true);
			commit(["", "  " + (st.connected ? ok("● ") + chalk.bold(st.name || st.login || "") + dim(` @${st.login} · ${st.method}`) : dim("○ " + T("GitHub non collegato", "GitHub not connected")) + (st.error ? err(" " + st.error) : ""))]);
			const a = await pick("GitHub", [
				{ label: T("Collega con un token personale", "Connect with a personal token"), value: "token", detail: "github.com/settings/tokens (repo, workflow)" },
				...(st.method === "token" ? [{ label: err(T("Scollega", "Disconnect")), value: "off" }] : []),
				{ label: T("Chiudi", "Close"), value: "close" },
			]);
			if (a === "token") {
				const tk = await ask(T("Incolla il token GitHub", "Paste the GitHub token"), { secret: true });
				if (!tk) return;
				try {
					const s2 = await connectGithubToken(tk);
					commit("  " + ok("✓ ") + T("Collegato come ", "Connected as ") + chalk.bold(s2.login ?? ""));
				} catch (e) {
					notice("error", (e as Error).message);
				}
			}
			if (a === "off") {
				await disconnectGithub();
				commit("  " + ok("✓ ") + T("Scollegato", "Disconnected"));
			}
		} },
		{ name: "pr", it: "Crea una pull request con le modifiche", en: "Create a pull request with the changes", args: T("[titolo]", "[title]"), run: async (rest) => {
			const gh = await githubStatus();
			if (!gh.connected) return notice("warn", T("GitHub non è collegato: usa /github.", "GitHub is not connected: use /github."));
			const st = await gitState(opts.cwd);
			if (!st.isRepo) return notice("warn", T("Questa cartella non è un repository git.", "This folder is not a git repository."));
			if (!st.files.length && !st.ahead) return notice("info", T("Non ci sono modifiche.", "There are no changes."));
			const title = rest || (await ask(T("Titolo della PR", "PR title"), { initial: session.data.meta.title === "New session" ? "" : session.data.meta.title }));
			if (!title) return;
			commit(["", `  ${dim(T("File", "Files"))}: ${st.files.length} · ${ok("+" + st.added)} ${err("-" + st.removed)} · ${dim(st.branch + " → " + st.defaultBranch)}`]);
			const go = await pick(T("Creare la pull request?", "Create the pull request?"), [{ label: T("Crea PR", "Create PR"), value: "pr" }, { label: T("Crea come bozza", "Create as draft"), value: "draft" }, { label: T("Annulla", "Cancel"), value: "no" }]);
			if (!go || go === "no") return;
			word = T("Creo la PR", "Creating the PR");
			try {
				const last: any = [...session.agent.state.messages].reverse().find((m: any) => m.role === "assistant");
				const summary = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").slice(0, 1200) ?? "";
				const r = await createPullRequest(opts.cwd, { title, body: `## Summary\n\n${summary}\n\n## Changes\n\n${st.files.map((f) => "- `" + f.path + "`").join("\n")}\n\n---\n⚛ Created with Argon`, draft: go === "draft", commitMessage: title });
				session.data.meta.prs = [...(session.data.meta.prs ?? []), { number: r.number, url: r.url, title, branch: r.branch, createdAt: Date.now() }];
				session.persist();
				git = gitInfo(opts.cwd);
				commit("  " + ok("✓ ") + `PR #${r.number} ` + chalk.underline(r.url));
			} catch (e) {
				notice("error", (e as Error).message);
			}
		} },
		{ name: "limits", it: "Limiti 5h/settimanali e spesa", en: "5h/weekly limits and spend", args: "[on|off|5h|week|unit|action]", run: (_r, a) => (a.length ? doLimits(a) : printLimits()) },
		{ name: "usage", it: "Utilizzo per modello, provider e sub-agente", en: "Usage per model, provider and sub-agent", args: "[today|7d|30d|all]", run: (rest) => usageChart((["today", "7d", "30d", "all"].includes(rest) ? rest : "30d") as any) },
		{ name: "stats", it: "Statistiche e attività", en: "Statistics and activity", args: "[7d|30d|all]", run: (rest) => printStats((rest as any) || "all") },
		{ name: "mcp", it: "Server MCP", en: "MCP servers", args: "[add|remove|enable|disable]", run: async (_r, a) => {
			if (a.length) {
				await doMcp(a);
				return session.refresh();
			}
			await syncMcp();
			const st = mcpStatus();
			const n = await pick("MCP", [...st.map((m) => ({ label: m.name, value: m.name, detail: m.transport, right: m.status === "connected" ? ok(`${m.tools.length} tools`) : m.status === "error" ? err(m.error ?? "error") : dim(m.status) })), { label: accent("+ " + T("Aggiungi server", "Add server")), value: "__add" }]);
			if (!n) return;
			if (n === "__add") {
				const name = await ask(T("Nome del server", "Server name"));
				const cmd = name && (await ask(T("Comando o URL (es. npx -y @modelcontextprotocol/server-filesystem .)", "Command or URL (e.g. npx -y @modelcontextprotocol/server-filesystem .)")));
				if (name && cmd) await doMcp(["add", name, ...cmd.split(/\s+/)]);
				return session.refresh();
			}
			const act = await pick(n, [{ label: T("Riconnetti", "Reconnect"), value: "re" }, { label: T("Disattiva", "Disable"), value: "disable" }, { label: T("Attiva", "Enable"), value: "enable" }, { label: err(T("Rimuovi", "Remove")), value: "remove" }]);
			if (act === "re") await reconnectMcp(n);
			else if (act) await doMcp([act, n]);
			session.refresh();
		} },
		{ name: "agents", it: "Sub-agenti disponibili", en: "Available sub-agents", run: async () => {
			const s = loadSettings();
			const list = listAgents(opts.cwd, s, true);
			const n = await pick(T("Sub-agenti (invio attiva/disattiva)", "Sub-agents (enter toggles)"), list.map((a) => ({ label: a.name, value: a.name, detail: a.description, right: a.enabled ? ok("● on") : dim("○ off") })));
			if (!n) return;
			const set = new Set(s.agents.disabled);
			set.has(n) ? set.delete(n) : set.add(n);
			s.agents.disabled = [...set];
			saveSettings(s);
			session.refresh();
			commit("  " + ok("✓ ") + n + " " + (set.has(n) ? dim("off") : ok("on")));
		} },
		{ name: "subagents", it: "Sub-agenti di questa sessione", en: "Sub-agents of this session", run: async () => {
			if (!subagents.size) return notice("info", T("Nessun sub-agente avviato in questa sessione.", "No sub-agents started in this session."));
			const id = await pick(T("Sub-agenti", "Sub-agents"), [...subagents.entries()].map(([k, v]) => ({ label: v.agent, value: k, detail: v.model ?? "", right: v.done ? dim(`${v.steps.length} ${T("passi", "steps")}`) : accent(T("al lavoro", "working")) })));
			const s = id && subagents.get(id);
			if (s) commit(["", `  ${accent(s.agent)} ${dim(s.model ?? "")}`, ...s.steps.map((st) => `    ${st.ok === false ? err("✗") : st.ok ? ok("✓") : dim("·")} ${chalk.bold(label(st.tool))} ${dim(st.text)}`)]);
		} },
		{ name: "bgterminals", it: "Terminali in background", en: "Background terminals", run: async () => {
			const list = session.background.list();
			if (!list.length) return notice("info", T("Nessun processo in background.", "No background processes."));
			const id = await pick(T("Terminali in background", "Background terminals"), list.map((p) => ({ label: p.command, value: p.id, detail: p.id, right: p.status === "running" ? ok("● " + T("attivo", "running")) : dim(`${p.status} ${p.exitCode ?? ""}`) })));
			if (!id) return;
			const act = await pick(id, [{ label: T("Mostra output", "Show output"), value: "out" }, { label: err(T("Ferma", "Stop")), value: "kill" }]);
			if (act === "out") commit(["", ...session.background.read(id, true).output.split(/\r?\n/).slice(-40).map((l) => "  " + dim("│ ") + l)]);
			if (act === "kill") commit("  " + (session.background.kill(id) ? ok("✓ " + T("Fermato", "Stopped")) : dim(T("Non era attivo", "Not running"))));
		} },
		{ name: "skills", it: "Skill e comandi personalizzati", en: "Skills and custom commands", run: () => printSkills(opts.cwd) },
		{ name: "memory", it: "Memoria (add <testo> | rm <id>)", en: "Memory (add <text> | rm <id>)", args: "[add|rm]", run: async (_r, a) => {
			if (a[0] === "add") addMemory(a[1] === "--global" ? "global" : "project", opts.cwd, a.slice(a[1] === "--global" ? 2 : 1).join(" "));
			else if (a[0] === "rm") removeMemory(a[1]);
			else {
				const id = await pick(T("Memoria (invio = elimina)", "Memory (enter = delete)"), listMemory(opts.cwd).map((m) => ({ label: m.content, value: m.id, right: dim(m.scope) })));
				if (id) removeMemory(id);
			}
			const m = listMemory(opts.cwd);
			commit(m.length ? m.map((x) => `  ${dim(x.id)} ${x.content}`) : ["  " + dim(T("Nessun ricordo.", "No memories."))]);
		} },
		{ name: "hooks", it: "Hook configurati", en: "Configured hooks", run: () => {
			const h = loadSettings().hooks;
			commit(h.length ? table(h.map((x) => [accent(x.event), dim(x.matcher ?? "*"), x.command])).split("\n") : ["  " + dim(T("Nessun hook. Aggiungili dalla GUI → Personalizza → Hook.", "No hooks. Add them in GUI → Customize → Hooks."))]);
		} },
		{ name: "env", it: "Ambienti (aggiungi, rinomina, rimuovi)", en: "Environments (add, rename, remove)", run: async () => {
			const env = environmentForCwd(opts.cwd);
			const items = [
				...(env ? [{ label: T("Rinomina ", "Rename ") + env.name, value: "rename" }] : [{ label: T("Registra questa cartella come ambiente", "Register this folder as an environment"), value: "add" }]),
				...listEnvironments().map((e) => ({ label: e.name, value: "rm:" + e.id, detail: e.cwd, right: dim(T("invio = rimuovi", "enter = remove")) })),
			];
			const a = await pick(T("Ambienti", "Environments"), items);
			if (a === "add") {
				const n = await ask(T("Nome dell'ambiente", "Environment name"), { initial: opts.cwd.split(/[\\/]/).pop() });
				if (n) {
					const e = addEnvironment(n, opts.cwd);
					session.data.meta.envId = e.id;
					session.persist();
					commit("  " + ok("✓ ") + e.name);
				}
			} else if (a === "rename" && env) {
				const n = await ask(T("Nuovo nome", "New name"), { initial: env.name });
				if (n) updateEnvironment(env.id, { name: n });
			} else if (a?.startsWith("rm:")) await doEnvRemove(a.slice(3), askStr);
		} },
		{ name: "settings", it: "Impostazioni di Argon CLI", en: "Argon CLI settings", run: settingsMenu },
		{ name: "init", it: "", en: "", run: () => run(initPrompt(loadSettings()), "/init") },
		{ name: "gui", it: "Apri Argon GUI", en: "Open Argon GUI", run: async () => {
			const { launchDesktop } = await import("../core/desktop.js");
			if (launchDesktop()) return commit("  " + ok("✓ ") + T("App desktop avviata", "Desktop app started"));
			const { startServer } = await import("../server/server.js");
			const { url } = await startServer({ open: true });
			commit("  " + ok("✓ ") + url);
		} },
		{ name: "exit", it: "Esci", en: "Quit", run: () => shutdown() },
	];
	// /init description follows the configured file name
	Object.defineProperty(COMMANDS.find((c) => c.name === "init")!, "it", { get: () => `Crea ${loadSettings().context.initFile} analizzando il progetto` });
	Object.defineProperty(COMMANDS.find((c) => c.name === "init")!, "en", { get: () => `Create ${loadSettings().context.initFile} by analyzing the project` });

	function slashItems(prefix: string): PickItem[] {
		const s = loadSettings();
		const all: PickItem[] = [
			...COMMANDS.map((c) => ({ label: "/" + c.name, value: "/" + c.name, detail: T(c.it, c.en), right: dim(c.args ?? "") })),
			...listCommands(opts.cwd, s).map((c) => ({ label: "/" + c.name, value: "/" + c.name, detail: c.description, right: dim(c.source) })),
			...listSkills(opts.cwd, s).map((k) => ({ label: "/" + k.name, value: "/" + k.name, detail: k.description.slice(0, 80), right: dim("skill") })),
		];
		const q = prefix.toLowerCase();
		return all.filter((i) => i.value.toLowerCase().startsWith(q)).concat(all.filter((i) => !i.value.toLowerCase().startsWith(q) && i.value.toLowerCase().includes(q.slice(1)) && q.length > 1));
	}

	async function fileItems(q: string): Promise<PickItem[]> {
		if (!files) {
			files = [];
			for await (const f of walk(opts.cwd, 4000)) files.push(relative(opts.cwd, f).replace(/\\/g, "/"));
		}
		const ql = q.toLowerCase();
		return files
			.filter((f) => f.toLowerCase().includes(ql))
			.sort((a, b) => a.length - b.length)
			.slice(0, 50)
			.map((f) => ({ label: f, value: f }));
	}

	async function updateSuggestions() {
		if (picker || promptState || approval) return (suggest = null);
		if (text.startsWith("/") && !text.includes(" ") && !text.includes("\n")) {
			const items = slashItems(text);
			suggest = items.length ? { items, sel: 0, kind: "slash", start: 0 } : null;
			return;
		}
		const before = text.slice(0, cur);
		const m = before.match(/(^|\s)@([^\s@]*)$/);
		if (m) {
			const items = await fileItems(m[2]);
			suggest = items.length ? { items, sel: 0, kind: "file", start: cur - m[2].length - 1 } : null;
			render();
			return;
		}
		suggest = null;
	}

	function acceptSuggestion(): boolean {
		if (!suggest) return false;
		const item = suggest.items[suggest.sel];
		if (!item) return false;
		if (suggest.kind === "slash") {
			text = item.value + " ";
			cur = text.length;
		} else {
			const v = /\s/.test(item.value) ? `@"${item.value}" ` : `@${item.value} `;
			text = text.slice(0, suggest.start) + v + text.slice(cur);
			cur = suggest.start + v.length;
		}
		suggest = null;
		return true;
	}

	async function submit(raw: string) {
		const input = raw.trim();
		if (!input) return;
		appendFileSync(paths.history, input.replace(/\n/g, " ") + "\n");
		history.push(input);
		hIndex = history.length;
		if (input.startsWith("/") && !input.startsWith("//")) {
			const [cmdName, ...args] = input.slice(1).split(/\s+/);
			const rest = input.slice(1 + cmdName.length).trim();
			const cmd = COMMANDS.find((c) => c.name === cmdName) ?? (cmdName === "quit" ? COMMANDS.find((c) => c.name === "exit") : cmdName === "?" ? COMMANDS[0] : undefined);
			try {
				if (cmd) {
					commit(["", "  " + accent("/" + cmdName) + (rest ? " " + dim(rest) : "")]);
					await cmd.run(rest, args);
				} else {
					const expanded = session.expandSlash(input);
					if (expanded) await run(expanded, input);
					else notice("error", `${T("Comando sconosciuto", "Unknown command")}: /${cmdName}`);
				}
			} catch (e) {
				notice("error", (e as Error).message);
			}
			render();
			return;
		}
		await run(input);
	}

	// ───────────── keyboard ─────────────
	function insert(s: string) {
		text = text.slice(0, cur) + s + text.slice(cur);
		cur += s.length;
	}

	async function onKey(str: string | undefined, key: any) {
		if (!key) key = {};
		if (key.name === "paste-start") return void (pasting = true);
		// Esc quickly followed by a key arrives as Alt+key: treat it as Esc, then the key.
		if (key.meta && str && str.length === 1 && str >= " " && !pasting) {
			await onKey(undefined, { name: "escape" });
			key = { ...key, meta: false };
		}
		if (key.name === "paste-end") {
			pasting = false;
			await updateSuggestions();
			return render();
		}
		if (pasting) {
			if (key.name === "return" || key.name === "enter") insert("\n");
			else if (str && !key.ctrl) insert(str.replace(/\r/g, ""));
			return render();
		}
		// approvals: single keys or arrows
		if (approval) {
			const choose = (c: "allow" | "always" | "deny") => {
				const a = approval!;
				approval = null;
				commit(`    ${c === "deny" ? err("✖ " + T("negato", "denied")) : ok("✔ " + (c === "always" ? T("sempre consentito", "always allowed") : T("consentito", "allowed")))}`);
				session.respondApproval(a.e.id, c);
				render();
			};
			if (key.name === "left") approval.sel = (approval.sel + 2) % 3;
			else if (key.name === "right" || key.name === "tab") approval.sel = (approval.sel + 1) % 3;
			else if (str === "y" || str === "s") return choose("allow");
			else if (str === "a") return choose("always");
			else if (str === "n" || key.name === "escape") return choose("deny");
			else if (key.name === "return") return choose((["allow", "always", "deny"] as const)[approval.sel]);
			else if (key.ctrl && key.name === "c") return choose("deny");
			return render();
		}
		if (key.ctrl && key.name === "c") {
			if (session.status !== "idle") {
				session.abort();
				return commit("  " + warn("■ " + T("Interrotto", "Stopped")));
			}
			if (picker || promptState) return cancelOverlay();
			if (text) {
				text = "";
				cur = 0;
				suggest = null;
				return render();
			}
			if (Date.now() - exitArmed < 2000) return shutdown();
			exitArmed = Date.now();
			return commit("  " + dim(T("Premi di nuovo Ctrl+C per uscire", "Press Ctrl+C again to exit")));
		}
		if (key.ctrl && key.name === "d" && !text) return shutdown();
		if (key.name === "escape") {
			if (suggest) {
				suggest = null;
				return render();
			}
			if (picker || promptState || question) return cancelOverlay();
			if (session.status !== "idle") {
				session.abort();
				return commit("  " + warn("■ " + T("Interrotto", "Stopped")));
			}
			return;
		}
		if (key.name === "tab" && key.shift) {
			if (picker || promptState) return;
			const i = MODE_ORDER.indexOf(session.data.meta.mode);
			session.setMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
			return render();
		}
		const listNav = picker ? filteredPicker() : suggest?.items;
		if ((key.name === "up" || key.name === "down") && (picker || suggest || question)) {
			const d = key.name === "up" ? -1 : 1;
			if (picker) picker.sel = Math.max(0, Math.min((listNav?.length ?? 1) - 1, picker.sel + d));
			else if (suggest) suggest.sel = (suggest.sel + d + suggest.items.length) % suggest.items.length;
			else if (question) question.sel = (question.sel + d + question.e.options.length) % question.e.options.length;
			return render();
		}
		if (key.name === "tab") {
			if (acceptSuggestion()) await updateSuggestions();
			return render();
		}
		if (key.name === "return" || key.name === "enter") {
			if (key.meta || (key.name === "enter" && !key.ctrl)) {
				// alt+enter / ctrl+j: newline
				if (key.meta || key.name === "enter") {
					insert("\n");
					return render();
				}
			}
			if (text.endsWith("\\") && !picker && !promptState) {
				text = text.slice(0, -1) + "\n";
				cur = text.length;
				return render();
			}
			if (picker) {
				const item = filteredPicker()[picker.sel];
				if (!item || item.disabled) return;
				const p = picker;
				picker = null;
				text = "";
				cur = 0;
				render();
				return p.resolve(item.value);
			}
			if (promptState) return promptState.resolve(text);
			if (question) {
				const q = question;
				question = null;
				const answer = text.trim() || q.e.options[q.sel] || "";
				text = "";
				cur = 0;
				commit(`    ${accent("↳")} ${answer}`);
				session.answerQuestion(q.e.id, answer);
				return render();
			}
			if (suggest) {
				const exact = suggest.kind === "slash" && suggest.items[suggest.sel]?.value === text.trim();
				if (!exact) {
					acceptSuggestion();
					await updateSuggestions();
					return render();
				}
				suggest = null;
			}
			const value = text;
			text = "";
			cur = 0;
			render();
			return submit(value);
		}
		if (key.name === "backspace") {
			if (cur > 0) {
				text = text.slice(0, cur - 1) + text.slice(cur);
				cur--;
			}
		} else if (key.name === "delete") text = text.slice(0, cur) + text.slice(cur + 1);
		else if (key.name === "left") cur = Math.max(0, cur - 1);
		else if (key.name === "right") cur = Math.min(text.length, cur + 1);
		else if (key.name === "home" || (key.ctrl && key.name === "a")) cur = text.lastIndexOf("\n", cur - 1) + 1;
		else if (key.name === "end" || (key.ctrl && key.name === "e")) {
			const nl = text.indexOf("\n", cur);
			cur = nl < 0 ? text.length : nl;
		} else if (key.ctrl && key.name === "u") {
			text = text.slice(cur);
			cur = 0;
		} else if (key.ctrl && key.name === "k") text = text.slice(0, cur);
		else if (key.ctrl && key.name === "w") {
			const m = text.slice(0, cur).match(/\S+\s*$/);
			const n = m ? m[0].length : cur;
			text = text.slice(0, cur - n) + text.slice(cur);
			cur -= n;
		} else if (key.name === "up" || key.name === "down") {
			if (text.includes("\n")) {
				// move between lines
				const lines = text.split("\n");
				let acc = 0;
				let li = 0;
				for (; li < lines.length; li++) {
					if (cur <= acc + lines[li].length) break;
					acc += lines[li].length + 1;
				}
				const col = cur - acc;
				const target = key.name === "up" ? li - 1 : li + 1;
				if (target >= 0 && target < lines.length) {
					const start = lines.slice(0, target).reduce((a, l) => a + l.length + 1, 0);
					cur = start + Math.min(col, lines[target].length);
				}
			} else if (!promptState) {
				hIndex = Math.max(0, Math.min(history.length, hIndex + (key.name === "up" ? -1 : 1)));
				text = history[hIndex] ?? "";
				cur = text.length;
			}
		} else if (str && !key.ctrl && !key.meta && str >= " ") insert(str);
		else if (str && str.length > 1 && !key.ctrl) insert(str.replace(/\r/g, ""));
		await updateSuggestions();
		render();
	}

	function cancelOverlay() {
		if (picker) {
			const p = picker;
			picker = null;
			text = "";
			cur = 0;
			p.resolve(undefined);
		} else if (promptState) promptState.resolve(undefined);
		else if (question) {
			const q = question;
			question = null;
			session.answerQuestion(q.e.id, "(no answer)");
		}
		render();
	}

	function shutdown(): never {
		clearInterval(spinTimer);
		screen.stop();
		console.log = origLog;
		try {
			stdin.setRawMode?.(false);
		} catch {
			/* not a tty */
		}
		out.write(dim(`  ${T("Alla prossima.", "See you.")} `) + accent("Ar") + "\n");
		process.exit(0);
	}

	// ───────────── start ─────────────
	// Short escape timeout: a lone Esc is recognised quickly (default is 500 ms).
	emitKeypressEvents(stdin, { escapeCodeTimeout: 50 } as any);
	stdin.setRawMode?.(true);
	stdin.resume();
	screen.start();
	screen.onResize = () => draw();
	const spinTimer = setInterval(() => {
		if (session?.status !== "idle") {
			spinFrame++;
			draw();
		}
	}, 90);
	stdin.on("keypress", (s, k) => void onKey(s, k).catch((e) => notice("error", (e as Error).message)));
	process.on("SIGTERM", () => shutdown());
	void syncMcp().then(() => session?.refresh());

	try {
		await startSession({ resumeId: opts.resumeId });
	} catch (e) {
		commit(["", "  " + err((e as Error).message)]);
		// first run: connect a provider
		session = undefined as any;
		screen.setBottom([" " + dim(T("Configurazione iniziale", "First-time setup"))], null);
		const list = listProviders();
		const p = await new Promise<string | undefined>((res) => {
			// minimal bootstrap picker before a session exists
			picker = { title: T("Collega un provider per iniziare", "Connect a provider to start"), items: list.map((x) => ({ label: x.name, value: x.id, detail: x.hint ?? "" })), sel: 0, resolve: res };
			session = { status: "idle", model: { name: "—", reasoning: false }, data: { meta: { mode: "ask" } }, effort: "off", id: "", background: { running: () => 0 }, contextUsage: () => ({ percent: 0 }) } as any;
			text = "";
			render();
		});
		if (!p) shutdown();
		await doLogin(p, askStr);
		const s = loadSettings();
		const first = listProviders().find((x) => x.id === p);
		if (first) {
			const r = await refreshModels(p);
			const key = await pick(T("Modello predefinito", "Default model"), r.models.map((m) => ({ label: m.name, value: modelKey(m), detail: m.id })));
			if (key) {
				s.model.default = key;
				saveSettings(s);
			}
		}
		await startSession({ resumeId: opts.resumeId });
	}
	await openingAnimation();
	banner();
	if (opts.resumeId) replay();
	render();
	if (opts.initialPrompt) await run(opts.initialPrompt);
	await new Promise(() => {});
}
