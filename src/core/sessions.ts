import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { paths, ensureDirs } from "./paths.js";
import { loadSettings, saveSettings, type Environment, type Effort, type PermissionMode } from "./config.js";

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export interface SessionMeta {
	id: string;
	title: string;
	envId: string | null;
	cwd: string;
	model: string;
	effort: Effort;
	mode: PermissionMode;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	pinned?: boolean;
	archived?: boolean;
	/** First user message, used for search previews. */
	preview?: string;
	/** Where the session was started. CLI sessions show up in the GUI once imported. */
	origin?: "cli" | "gui";
	imported?: boolean;
	/** Git context captured on import / PR creation. */
	git?: SessionGit;
	/** Pull requests opened from this session (from the PR dialog, or by the agent with `gh pr create`). */
	prs?: (PrStatus & { branch: string; createdAt: number })[];
}

/** All pull requests of a session (opened from it, or found on import), newest first, without duplicates. */
export function sessionPrs(meta: SessionMeta): PrStatus[] {
	const seen = new Set<string>();
	const out: PrStatus[] = [];
	for (const p of [...(meta.prs ?? []), ...(meta.git?.prs ?? [])]) {
		const key = p.url || String(p.number);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ number: p.number, url: p.url, title: p.title, state: p.state, draft: p.draft, additions: p.additions, deletions: p.deletions, checks: p.checks, checkedAt: p.checkedAt });
	}
	return out.sort((a, b) => b.number - a.number);
}

/** Store fresh PR details into the session's PR lists (matched by URL, else by number). */
export function mergePrStatus(meta: SessionMeta, fresh: PrStatus[]): boolean {
	let changed = false;
	for (const p of [...(meta.prs ?? []), ...(meta.git?.prs ?? [])]) {
		const f = fresh.find((x) => (p.url && x.url === p.url) || x.number === p.number);
		if (!f) continue;
		Object.assign(p, { title: f.title || p.title, url: f.url || p.url, state: f.state, draft: f.draft, additions: f.additions, deletions: f.deletions, checks: f.checks, checkedAt: f.checkedAt });
		changed = true;
	}
	return changed;
}

/** What GitHub last said about a pull request (filled in by `prDetails`; all optional until then). */
export interface PrStatus {
	number: number;
	url: string;
	title: string;
	state?: string;
	draft?: boolean;
	additions?: number;
	deletions?: number;
	/** Checks rollup: null when the PR has none. */
	checks?: "pass" | "fail" | "pending" | null;
	checkedAt?: number;
}

export interface SessionGit {
	repo?: string;
	branch?: string;
	commits?: { hash: string; subject: string; date: string }[];
	prs?: PrStatus[];
	changes?: { files: number; added: number; removed: number };
	capturedAt: number;
}

export interface SessionData {
	meta: SessionMeta;
	summary?: string;
	messages: AgentMessage[];
	todos: TodoItem[];
}

const indexPath = () => join(paths.sessions, "index.json");
let index: Record<string, SessionMeta> | undefined;

let indexMtime = 0;
const mtimeOf = (p: string) => {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
};

/** The index is shared with other Argon processes (GUI + CLI): reload it when it changed on disk. */
function loadIndex(): Record<string, SessionMeta> {
	if (index && mtimeOf(indexPath()) === indexMtime) return index;
	ensureDirs();
	indexMtime = mtimeOf(indexPath());
	index = {};
	if (existsSync(indexPath())) {
		try {
			index = JSON.parse(readFileSync(indexPath(), "utf8"));
		} catch {
			index = {};
		}
	}
	// Recover sessions missing from the index.
	for (const f of readdirSync(paths.sessions)) {
		if (!f.endsWith(".json") || f === "index.json") continue;
		const id = basename(f, ".json");
		if (index![id]) continue;
		try {
			index![id] = JSON.parse(readFileSync(join(paths.sessions, f), "utf8")).meta;
		} catch {
			/* ignore */
		}
	}
	return index!;
}

function saveIndex(): void {
	writeFileSync(indexPath(), JSON.stringify(loadIndex()));
	indexMtime = mtimeOf(indexPath());
}

export function newSessionData(init: Omit<SessionMeta, "id" | "createdAt" | "updatedAt" | "messageCount" | "title"> & { title?: string }): SessionData {
	const now = Date.now();
	return {
		meta: { ...init, id: randomUUID().slice(0, 8), title: init.title ?? "New session", createdAt: now, updatedAt: now, messageCount: 0 },
		messages: [],
		todos: [],
	};
}

export function saveSession(data: SessionData): void {
	ensureDirs();
	data.meta.updatedAt = Date.now();
	data.meta.messageCount = data.messages.filter((m: any) => m.role === "user").length;
	const firstUser: any = data.messages.find((m: any) => m.role === "user");
	if (firstUser) {
		const text = typeof firstUser.content === "string" ? firstUser.content : firstUser.content.find((c: any) => c.type === "text")?.text;
		data.meta.preview = (text ?? "").slice(0, 200);
	}
	writeFileSync(join(paths.sessions, `${data.meta.id}.json`), JSON.stringify(data));
	loadIndex()[data.meta.id] = data.meta;
	saveIndex();
}

export function loadSession(id: string): SessionData | undefined {
	const file = join(paths.sessions, `${id}.json`);
	if (!existsSync(file)) {
		const match = Object.keys(loadIndex()).find((k) => k.startsWith(id));
		if (!match) return undefined;
		return loadSession(match);
	}
	return JSON.parse(readFileSync(file, "utf8"));
}

export function listSessions(opts: { envId?: string | null; query?: string; includeArchived?: boolean } = {}): SessionMeta[] {
	const q = opts.query?.toLowerCase();
	return Object.values(loadIndex())
		.filter((m) => opts.includeArchived || !m.archived)
		.filter((m) => opts.envId === undefined || m.envId === opts.envId)
		.filter((m) => !q || m.title.toLowerCase().includes(q) || (m.preview ?? "").toLowerCase().includes(q))
		.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
}

/** Full-text search inside transcripts. */
export function searchSessions(query: string, limit = 30): { meta: SessionMeta; snippet: string }[] {
	const q = query.toLowerCase();
	const out: { meta: SessionMeta; snippet: string }[] = [];
	for (const meta of listSessions({ includeArchived: true })) {
		if (out.length >= limit) break;
		const data = loadSession(meta.id);
		if (!data) continue;
		for (const m of data.messages as any[]) {
			const text =
				typeof m.content === "string"
					? m.content
					: (m.content ?? []).map((c: any) => c.text ?? "").join(" ");
			const i = text.toLowerCase().indexOf(q);
			if (i >= 0) {
				out.push({ meta, snippet: text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, " ") });
				break;
			}
		}
		if (!out.some((o) => o.meta.id === meta.id) && meta.title.toLowerCase().includes(q)) out.push({ meta, snippet: meta.preview ?? "" });
	}
	return out;
}

export function updateSessionMeta(id: string, patch: Partial<SessionMeta>): SessionMeta | undefined {
	const data = loadSession(id);
	if (!data) return undefined;
	Object.assign(data.meta, patch);
	saveSession(data);
	return data.meta;
}

export function deleteSession(id: string): void {
	const file = join(paths.sessions, `${id}.json`);
	if (existsSync(file)) unlinkSync(file);
	delete loadIndex()[id];
	saveIndex();
}

/** Export a session as Markdown. */
export function sessionToMarkdown(data: SessionData): string {
	const lines = [`# ${data.meta.title}`, "", `_${new Date(data.meta.createdAt).toLocaleString()} · ${data.meta.model}_`, ""];
	for (const m of data.messages as any[]) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "[image]").join("\n");
			lines.push("## 🧑 User", "", text, "");
		} else if (m.role === "assistant") {
			lines.push("## ⚛️ Argon", "");
			for (const c of m.content) {
				if (c.type === "text") lines.push(c.text, "");
				if (c.type === "toolCall") lines.push("```tool", `${c.name} ${JSON.stringify(c.arguments)}`, "```", "");
			}
		}
	}
	return lines.join("\n");
}

// ───────────────────────────── environments ─────────────────────────────

export function listEnvironments(): Environment[] {
	return loadSettings().environments;
}

export function addEnvironment(name: string, cwd: string): Environment {
	const s = loadSettings();
	const existing = s.environments.find((e) => e.cwd.toLowerCase() === cwd.toLowerCase());
	if (existing) return existing;
	const env: Environment = { id: randomUUID().slice(0, 8), name, cwd };
	s.environments.push(env);
	saveSettings(s);
	return env;
}

export function updateEnvironment(id: string, patch: Partial<Environment>): void {
	const s = loadSettings();
	const env = s.environments.find((e) => e.id === id);
	if (!env) return;
	Object.assign(env, patch);
	saveSettings(s);
}

/**
 * Delete an environment. Its sessions are either kept (moved to "no environment")
 * or deleted with it. The folder on disk is never touched.
 */
export function removeEnvironment(id: string, opts: { deleteSessions?: boolean } = {}): { sessions: number; deleted: boolean } {
	const s = loadSettings();
	const before = s.environments.length;
	s.environments = s.environments.filter((e) => e.id !== id);
	if (s.environments.length === before) return { sessions: 0, deleted: false };
	saveSettings(s);
	const owned = listSessions({ envId: id, includeArchived: true });
	for (const m of owned) {
		if (opts.deleteSessions) deleteSession(m.id);
		else updateSessionMeta(m.id, { envId: null });
	}
	return { sessions: owned.length, deleted: true };
}

/** Number of sessions per environment id ("" = no environment). */
export function sessionCountsByEnv(): Record<string, number> {
	const ids = new Set(listEnvironments().map((e) => e.id));
	const out: Record<string, number> = {};
	for (const m of listSessions({ includeArchived: false })) {
		const k = m.envId && ids.has(m.envId) ? m.envId : "";
		out[k] = (out[k] ?? 0) + 1;
	}
	return out;
}

export function environmentForCwd(cwd: string): Environment | undefined {
	return listEnvironments().find((e) => e.cwd.toLowerCase() === cwd.toLowerCase());
}
