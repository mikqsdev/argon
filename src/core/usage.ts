import { appendFileSync, existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { Usage } from "@mariozechner/pi-ai";
import { paths, ensureDirs } from "./paths.js";
import { loadSettings, type Settings } from "./config.js";

export interface UsageEvent {
	ts: number;
	kind: "llm" | "prompt";
	provider: string;
	model: string;
	sessionId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Set when the call was made by a sub-agent (or "title"/"compaction" for housekeeping). */
	agent?: string;
}

let events: UsageEvent[] = [];
let loadedBytes = 0;

/**
 * Events from usage.jsonl. The file is shared by the GUI and the CLI (possibly running at the
 * same time), so new lines appended by another process are picked up incrementally.
 */
function all(): UsageEvent[] {
	ensureDirs();
	if (!existsSync(paths.usage)) {
		events = [];
		loadedBytes = 0;
		return events;
	}
	const size = statSync(paths.usage).size;
	if (size === loadedBytes) return events;
	let text: string;
	if (size < loadedBytes || loadedBytes === 0) {
		events = [];
		text = readFileSync(paths.usage, "utf8");
	} else {
		const fd = openSync(paths.usage, "r");
		const buf = Buffer.alloc(size - loadedBytes);
		readSync(fd, buf, 0, buf.length, loadedBytes);
		closeSync(fd);
		text = buf.toString("utf8");
	}
	const lastNl = text.lastIndexOf("\n");
	if (lastNl < 0) return events; // partial line still being written
	for (const line of text.slice(0, lastNl).split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			/* skip corrupt line */
		}
	}
	loadedBytes += Buffer.byteLength(text.slice(0, lastNl + 1));
	events.sort((a, b) => a.ts - b.ts);
	return events;
}

const listeners = new Set<() => void>();
export function onUsage(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function push(e: UsageEvent): void {
	all();
	appendFileSync(paths.usage, JSON.stringify(e) + "\n");
	all(); // reads back our own line (and any line another process appended meanwhile)
	for (const l of listeners) l();
}

/** Notify listeners when another process appended usage (called by the server's file watcher). */
export function usageChangedExternally(): void {
	const before = events.length;
	all();
	if (events.length !== before) for (const l of listeners) l();
}

export function recordLlmUsage(sessionId: string, provider: string, model: string, u: Usage, agent?: string): void {
	push({
		ts: Date.now(),
		kind: "llm",
		provider,
		model,
		sessionId,
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		cost: u.cost?.total ?? 0,
		...(agent ? { agent } : {}),
	});
}

export function recordPrompt(sessionId: string, provider: string, model: string): void {
	push({ ts: Date.now(), kind: "prompt", provider, model, sessionId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
}

export function eventTokens(e: UsageEvent, countCacheReads: boolean): number {
	return e.input + e.output + e.cacheWrite + (countCacheReads ? e.cacheRead : 0);
}

// ───────────────────────────── limits ─────────────────────────────

const H = 3_600_000;
const FIVE_H = 5 * H;
const WEEK = 7 * 24 * H;

export interface WindowStatus {
	enabled: boolean;
	used: number;
	limit: number;
	/** 0..100+ */
	percent: number;
	/** When the window resets; null = window not started yet. */
	resetsAt: number | null;
	startedAt: number | null;
}

export interface LimitStatus {
	enabled: boolean;
	unit: "tokens" | "cost";
	action: "block" | "warn";
	warnAt: number;
	fiveHour: WindowStatus;
	weekly: WindowStatus;
	/** True when a window is enabled and at or past 100%. */
	exceeded: boolean;
	warning: boolean;
	blockedReason?: string;
	/** Money spent (USD, API-equivalent), always reported regardless of the limit unit. */
	spend: { fiveHour: number; weekly: number; today: number; month: number; total: number; byProvider: { provider: string; cost: number }[] };
}

function amount(e: UsageEvent, s: Settings): number {
	return s.limits.unit === "cost" ? e.cost : eventTokens(e, s.limits.countCacheReads);
}

function counted(s: Settings): UsageEvent[] {
	const providers = new Set(s.limits.providers);
	return all().filter((e) => e.kind === "llm" && (providers.size === 0 || providers.has(e.provider)));
}

export function lastWeeklyReset(now: number, day: number, hour: number): number {
	const d = new Date(now);
	d.setHours(hour, 0, 0, 0);
	const diff = (d.getDay() - day + 7) % 7;
	d.setDate(d.getDate() - diff);
	if (d.getTime() > now) d.setDate(d.getDate() - 7);
	return d.getTime();
}

export function limitStatus(now = Date.now(), s: Settings = loadSettings()): LimitStatus {
	const L = s.limits;
	const evs = counted(s);

	// 5-hour window
	let fStart: number | null = null;
	let fReset: number | null = null;
	let fUsed = 0;
	if (L.fiveHour.mode === "rolling") {
		const inWin = evs.filter((e) => e.ts > now - FIVE_H);
		fUsed = inWin.reduce((a, e) => a + amount(e, s), 0);
		if (inWin.length) {
			fStart = inWin[0].ts;
			fReset = inWin[0].ts + FIVE_H;
		}
	} else {
		// Claude-style block: opens with the first message after the previous block expired.
		let block: number | null = null;
		for (const e of evs) if (block === null || e.ts >= block + FIVE_H) block = e.ts;
		if (block !== null && now < block + FIVE_H) {
			fStart = block;
			fReset = block + FIVE_H;
			fUsed = evs.filter((e) => e.ts >= block!).reduce((a, e) => a + amount(e, s), 0);
		}
	}

	// weekly window
	const wStart = lastWeeklyReset(now, L.weekly.resetDay, L.weekly.resetHour);
	const wUsed = evs.filter((e) => e.ts >= wStart).reduce((a, e) => a + amount(e, s), 0);

	const mk = (enabled: boolean, used: number, limit: number, startedAt: number | null, resetsAt: number | null): WindowStatus => ({
		enabled,
		used,
		limit,
		percent: limit > 0 ? (used / limit) * 100 : 0,
		startedAt,
		resetsAt,
	});
	const fiveHour = mk(L.enabled && L.fiveHour.enabled, fUsed, L.fiveHour.value, fStart, fReset);
	const weekly = mk(L.enabled && L.weekly.enabled, wUsed, L.weekly.value, wStart, wStart + WEEK);
	const over = [fiveHour, weekly].filter((w) => w.enabled && w.percent >= 100);
	const warn = [fiveHour, weekly].some((w) => w.enabled && w.percent >= L.warnAt);
	let blockedReason: string | undefined;
	if (over.length && L.action === "block") {
		const w = over.includes(weekly) ? weekly : fiveHour;
		const which = w === weekly ? "weekly" : "5-hour";
		const it = s.general.language === "it";
		const when = w.resetsAt
			? new Date(w.resetsAt).toLocaleString(it ? "it-IT" : "en-US", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
			: it ? "a breve" : "soon";
		blockedReason = it
			? `Hai raggiunto il limite ${which === "weekly" ? "settimanale" : "delle 5 ore"}. Si azzera ${when}.`
			: `The ${which} limit has been reached. It resets ${when}.`;
	}
	const all_ = all().filter((e) => e.kind === "llm");
	const sum = (from: number) => all_.reduce((a, e) => (e.ts >= from ? a + e.cost : a), 0);
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	const month = new Date(day);
	month.setDate(1);
	const byProv = new Map<string, number>();
	for (const e of all_) if (e.ts >= month.getTime()) byProv.set(e.provider, (byProv.get(e.provider) ?? 0) + e.cost);
	const spend = {
		fiveHour: fStart !== null ? sum(fStart) : 0,
		weekly: sum(wStart),
		today: sum(day.getTime()),
		month: sum(month.getTime()),
		total: sum(0),
		byProvider: [...byProv.entries()].map(([provider, cost]) => ({ provider, cost })).sort((a, b) => b.cost - a.cost),
	};
	return {
		spend,
		enabled: L.enabled,
		unit: L.unit,
		action: L.action,
		warnAt: L.warnAt,
		fiveHour,
		weekly,
		exceeded: over.length > 0,
		warning: warn,
		blockedReason,
	};
}

export function formatAmount(v: number, unit: "tokens" | "cost"): string {
	if (unit === "cost") return `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;
	return formatTokens(v);
}

export function formatTokens(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

// ───────────────────────────── stats ─────────────────────────────

export interface Stats {
	range: "all" | "30d" | "7d";
	sessions: number;
	messages: number;
	totalTokens: number;
	totalCost: number;
	activeDays: number;
	currentStreak: number;
	longestStreak: number;
	peakHour: number | null;
	favoriteModel: string | null;
	/** yyyy-mm-dd → tokens, for the heatmap. */
	days: Record<string, number>;
	models: { model: string; provider: string; tokens: number; cost: number; calls: number }[];
	funFact: string;
}

function dayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Rough token counts of famous books, for a fun comparison. */
const BOOKS = [
	{ it: "la Divina Commedia", en: "the Divine Comedy", tokens: 140_000 },
	{ it: "I Promessi Sposi", en: "The Betrothed", tokens: 300_000 },
	{ it: "Il Signore degli Anelli", en: "The Lord of the Rings", tokens: 640_000 },
	{ it: "Guerra e Pace", en: "War and Peace", tokens: 780_000 },
];

export function computeStats(range: "all" | "30d" | "7d" = "all", lang: "it" | "en" = "it"): Stats {
	const now = Date.now();
	const since = range === "7d" ? now - 7 * 24 * H : range === "30d" ? now - 30 * 24 * H : 0;
	const evs = all().filter((e) => e.ts >= since);
	const llm = evs.filter((e) => e.kind === "llm");
	const days: Record<string, number> = {};
	const hours = new Array(24).fill(0);
	const models = new Map<string, { model: string; provider: string; tokens: number; cost: number; calls: number }>();
	let totalTokens = 0;
	let totalCost = 0;
	for (const e of evs) {
		const k = dayKey(e.ts);
		const t = eventTokens(e, true);
		days[k] = (days[k] ?? 0) + t + (e.kind === "prompt" ? 1 : 0);
		hours[new Date(e.ts).getHours()]++;
	}
	for (const e of llm) {
		const t = eventTokens(e, true);
		totalTokens += t;
		totalCost += e.cost;
		const key = `${e.provider}/${e.model}`;
		const m = models.get(key) ?? { model: e.model, provider: e.provider, tokens: 0, cost: 0, calls: 0 };
		m.tokens += t;
		m.cost += e.cost;
		m.calls++;
		models.set(key, m);
	}
	const sorted = Object.keys(days).sort();
	let longest = 0;
	let run = 0;
	let prev: number | null = null;
	for (const k of sorted) {
		const t = new Date(k + "T00:00:00").getTime();
		run = prev !== null && Math.round((t - prev) / (24 * H)) === 1 ? run + 1 : 1;
		longest = Math.max(longest, run);
		prev = t;
	}
	let current = 0;
	const cursor = new Date();
	if (!days[dayKey(cursor.getTime())]) cursor.setDate(cursor.getDate() - 1);
	while (days[dayKey(cursor.getTime())]) {
		current++;
		cursor.setDate(cursor.getDate() - 1);
	}
	const modelList = [...models.values()].sort((a, b) => b.tokens - a.tokens);
	const peak = hours.some((h) => h > 0) ? hours.indexOf(Math.max(...hours)) : null;
	const book = [...BOOKS].reverse().find((b) => totalTokens >= b.tokens * 2) ?? BOOKS[0];
	const times = totalTokens / book.tokens;
	const funFact =
		totalTokens === 0
			? lang === "it"
				? "Nessun token ancora. Il gas nobile attende."
				: "No tokens yet. The noble gas awaits."
			: lang === "it"
				? `Hai usato ~${times < 10 ? times.toFixed(1) : Math.round(times)}× i token di «${book.it}».`
				: `You've used ~${times < 10 ? times.toFixed(1) : Math.round(times)}× more tokens than ${book.en}.`;
	return {
		range,
		sessions: new Set(evs.map((e) => e.sessionId)).size,
		messages: evs.filter((e) => e.kind === "prompt").length,
		totalTokens,
		totalCost,
		activeDays: sorted.length,
		currentStreak: current,
		longestStreak: longest,
		peakHour: peak,
		favoriteModel: modelList[0]?.model ?? null,
		days,
		models: modelList,
		funFact,
	};
}

/** Total usage for one session (for the cost display). */
export function sessionUsage(sessionId: string): { tokens: number; cost: number; subagentCost: number } {
	let tokens = 0;
	let cost = 0;
	let subagentCost = 0;
	for (const e of all()) {
		if (e.sessionId !== sessionId || e.kind !== "llm") continue;
		tokens += eventTokens(e, true);
		cost += e.cost;
		if (e.agent && e.agent !== "title" && e.agent !== "compaction") subagentCost += e.cost;
	}
	return { tokens, cost, subagentCost };
}

export interface UsageRow {
	provider: string;
	model: string;
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	cost: number;
	/** Part of the above made by sub-agents. */
	subagentTokens: number;
	subagentCost: number;
	/** Sub-agent names that used this model. */
	agents: string[];
}

export interface UsageDetail {
	range: "all" | "30d" | "7d" | "today";
	sessionId?: string;
	rows: UsageRow[];
	totals: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; tokens: number; cost: number; subagentCost: number; subagentTokens: number };
	byProvider: { provider: string; tokens: number; cost: number }[];
	byAgent: { agent: string; tokens: number; cost: number; calls: number }[];
	/** Last 30 days, oldest first. */
	daily: { day: string; tokens: number; cost: number }[];
}

/** Detailed usage per model and provider, sub-agents included (and itemised). */
export function usageDetail(range: UsageDetail["range"] = "all", sessionId?: string): UsageDetail {
	const now = Date.now();
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const since = range === "today" ? start.getTime() : range === "7d" ? now - 7 * 24 * H : range === "30d" ? now - 30 * 24 * H : 0;
	const evs = all().filter((e) => e.kind === "llm" && e.ts >= since && (!sessionId || e.sessionId === sessionId));
	const rows = new Map<string, UsageRow>();
	const prov = new Map<string, { provider: string; tokens: number; cost: number }>();
	const agents = new Map<string, { agent: string; tokens: number; cost: number; calls: number }>();
	const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, subagentCost: 0, subagentTokens: 0 };
	for (const e of evs) {
		const t = eventTokens(e, true);
		const k = `${e.provider}/${e.model}`;
		const r = rows.get(k) ?? { provider: e.provider, model: e.model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, subagentTokens: 0, subagentCost: 0, agents: [] };
		r.calls++;
		r.input += e.input;
		r.output += e.output;
		r.cacheRead += e.cacheRead;
		r.cacheWrite += e.cacheWrite;
		r.tokens += t;
		r.cost += e.cost;
		const isSub = !!e.agent && e.agent !== "title" && e.agent !== "compaction";
		if (isSub) {
			r.subagentTokens += t;
			r.subagentCost += e.cost;
			if (!r.agents.includes(e.agent!)) r.agents.push(e.agent!);
			totals.subagentCost += e.cost;
			totals.subagentTokens += t;
		}
		rows.set(k, r);
		const p = prov.get(e.provider) ?? { provider: e.provider, tokens: 0, cost: 0 };
		p.tokens += t;
		p.cost += e.cost;
		prov.set(e.provider, p);
		const an = e.agent ?? "main";
		const a = agents.get(an) ?? { agent: an, tokens: 0, cost: 0, calls: 0 };
		a.tokens += t;
		a.cost += e.cost;
		a.calls++;
		agents.set(an, a);
		totals.calls++;
		totals.input += e.input;
		totals.output += e.output;
		totals.cacheRead += e.cacheRead;
		totals.cacheWrite += e.cacheWrite;
		totals.tokens += t;
		totals.cost += e.cost;
	}
	const daily: UsageDetail["daily"] = [];
	for (let i = 29; i >= 0; i--) {
		const d = new Date(start);
		d.setDate(d.getDate() - i);
		const from = d.getTime();
		const to = from + 24 * H;
		let tokens = 0;
		let cost = 0;
		for (const e of all()) if (e.kind === "llm" && e.ts >= from && e.ts < to && (!sessionId || e.sessionId === sessionId)) {
			tokens += eventTokens(e, true);
			cost += e.cost;
		}
		daily.push({ day: dayKey(from), tokens, cost });
	}
	return {
		range,
		sessionId,
		rows: [...rows.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
		totals,
		byProvider: [...prov.values()].sort((a, b) => b.cost - a.cost),
		byAgent: [...agents.values()].sort((a, b) => b.cost - a.cost),
		daily,
	};
}
