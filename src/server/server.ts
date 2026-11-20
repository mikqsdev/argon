import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, watch } from "node:fs";
import { join, dirname, extname, resolve, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import {
	ArgonSession,
	loadSettings,
	saveSettings,
	onSettingsChange,
	listProviders,
	availableModels,
	modelsFor,
	refreshModels,
	usageDetail,
	usageChangedExternally,
	githubStatus,
	connectGithubToken,
	disconnectGithub,
	gitState,
	createPullRequest,
	pendingCliSessions,
	importCliSessions,
	listAgents,
	saveAgent,
	deleteAgent,
	effortProfile,
	refreshConnectedModels,
	modelKey,
	setApiKey,
	removeCredential,
	loginOAuth,
	oauthProviders,
	discoverLocalModels,
	listSessions,
	loadSession,
	searchSessions,
	updateSessionMeta,
	deleteSession,
	sessionToMarkdown,
	listEnvironments,
	addEnvironment,
	updateEnvironment,
	removeEnvironment,
	sessionCountsByEnv,
	limitStatus,
	computeStats,
	onUsage,
	sessionUsage,
	syncMcp,
	mcpStatus,
	reconnectMcp,
	listSkills,
	listCommands,
	listMemory,
	allMemory,
	addMemory,
	removeMemory,
	gitInfo,
	instructionFiles,
	MODES,
	VERSION,
	paths,
	DEFAULT_SETTINGS,
	type ArgonEvent,
} from "../core/index.js";
import { openAppWindow, openUrl } from "../core/open.js";
import type { Api, Model } from "@mariozechner/pi-ai";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const GUI_DIR = join(ROOT, "gui");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json",
};

/** Third-party assets served from node_modules (bundled, so the app works offline). */
function modelJson(m: Model<Api>) {
	const x = m as Model<Api> & { created?: number; estimated?: boolean };
	const profile = effortProfile(m);
	return {
		key: modelKey(m),
		id: m.id,
		name: m.name,
		provider: m.provider,
		reasoning: m.reasoning,
		levels: profile.levels,
		defaultEffort: profile.default,
		effortSource: profile.source,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		cost: m.cost,
		input: m.input,
		created: x.created,
		estimated: x.estimated,
	};
}

const VENDOR: Record<string, string> = {
	"/vendor/marked.js": "marked/lib/marked.esm.js",
	"/vendor/roboto-flex.woff2": "@fontsource-variable/roboto-flex/files/roboto-flex-latin-full-normal.woff2",
	"/vendor/roboto-flex-ext.woff2": "@fontsource-variable/roboto-flex/files/roboto-flex-latin-ext-full-normal.woff2",
	"/vendor/material-symbols-rounded.woff2": "material-symbols/material-symbols-rounded.woff2",
};

function token(): string {
	const file = join(paths.home, "gui-token");
	if (existsSync(file)) return readFileSync(file, "utf8").trim();
	const t = randomBytes(18).toString("base64url");
	writeFileSync(file, t);
	return t;
}

export async function startServer(opts: { port?: number; open?: boolean } = {}): Promise<{ url: string; close: () => void }> {
	const settings = loadSettings();
	/** 0 = pick a free port (used by the desktop app). */
	let port = opts.port ?? settings.general.guiPort;
	const TOKEN = token();
	let url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
	const open = () => {
		if (opts.open === false) return;
		const how = loadSettings().general.openGuiAs;
		if (how === "app" || how === "desktop") openAppWindow(url);
		else if (how === "browser") openUrl(url);
	};

	// Already running? Just open a window.
	if (port !== 0) try {
		const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
		if (r.ok && (await r.text()).includes("argon")) {
			open();
			return { url, close: () => {} };
		}
	} catch {
		/* not running */
	}

	const live = new Map<string, ArgonSession>();
	const clients = new Set<WebSocket>();
	const oauthPrompts = new Map<string, (v: string) => void>();

	const broadcast = (msg: any) => {
		const data = JSON.stringify(msg);
		for (const c of clients) if (c.readyState === 1) c.send(data);
	};

	function slim(e: ArgonEvent): any {
		if (e.type === "message_update") {
			const ev: any = e.assistantMessageEvent;
			return { type: "message_update", ev: { type: ev.type, contentIndex: ev.contentIndex, delta: ev.delta, toolCall: ev.type === "toolcall_end" ? ev.toolCall : undefined } };
		}
		if (e.type === "tool_execution_update") return { type: e.type, toolCallId: e.toolCallId, text: (e.partialResult?.content ?? []).map((c: any) => c.text ?? "").join("").slice(-4000) };
		if (e.type === "agent_end") return { type: "agent_end" };
		return e;
	}

	async function getLive(id: string): Promise<ArgonSession> {
		let s = live.get(id);
		if (s) return s;
		const data = loadSession(id);
		if (!data) throw Object.assign(new Error("Session not found"), { status: 404 });
		s = await ArgonSession.create({ cwd: data.meta.cwd, resumeId: data.meta.id });
		attach(s);
		return s;
	}

	function attach(s: ArgonSession) {
		live.set(s.id, s);
		s.subscribe((e) => {
			broadcast({ sessionId: s.id, ...slim(e) });
			if (e.type === "meta") broadcast({ type: "sessions_changed" });
		});
	}

	function sessionPayload(s: ArgonSession | undefined, id: string) {
		const data = s?.data ?? loadSession(id);
		if (!data) return null;
		const messages = (s?.agent.state.messages ?? data.messages) as any[];
		return {
			meta: data.meta,
			summary: data.summary,
			todos: data.todos,
			messages,
			streaming: s?.status === "running" ? s.agent.state.streamingMessage : undefined,
			status: s?.status ?? "idle",
			pendingApprovals: s?.pendingApprovals ?? [],
			pendingQuestions: s?.pendingQuestions ?? [],
			context: s ? s.contextUsage() : null,
			usage: sessionUsage(id),
			git: gitInfo(data.meta.cwd),
			instructions: instructionFiles(data.meta.cwd, loadSettings()).map((f) => f.path),
			background: s?.background.list() ?? [],
		};
	}

	/** Sessions visible in the GUI: GUI ones, plus CLI ones after they were imported. */
	function guiSessions(o: Parameters<typeof listSessions>[0] = {}) {
		return listSessions(o).filter((m) => m.origin !== "cli" || m.imported);
	}

	function bootstrap() {
		const s = loadSettings();
		return {
			version: VERSION,
			settings: s,
			defaults: DEFAULT_SETTINGS,
			providers: listProviders(),
			oauthProviders: oauthProviders(),
			models: availableModels().map(modelJson),
			environments: listEnvironments(),
			sessions: guiSessions(),
			cliPending: pendingCliSessions().map(({ id, title, cwd, updatedAt, model }) => ({ id, title, cwd, updatedAt, model })),
			running: [...live.values()].filter((x) => x.status !== "idle").map((x) => x.id),
			limits: limitStatus(),
			modes: MODES,
			mcp: mcpStatus(),
			home: homedir(),
			cwd: process.cwd(),
		};
	}

	async function body(req: IncomingMessage): Promise<any> {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");
		return raw ? JSON.parse(raw) : {};
	}

	function send(res: ServerResponse, status: number, data: any) {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(data));
	}

	function validHost(req: IncomingMessage): boolean {
		const host = (req.headers.host ?? "").toLowerCase();
		return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
	}

	async function api(req: IncomingMessage, res: ServerResponse, u: URL): Promise<void> {
		const p = u.pathname.replace(/^\/api/, "");
		const m = req.method ?? "GET";
		const seg = p.split("/").filter(Boolean);
		const q = (k: string) => u.searchParams.get(k) ?? undefined;

		if (p === "/bootstrap") return send(res, 200, bootstrap());
		if (p === "/settings" && m === "GET") return send(res, 200, loadSettings());
		if (p === "/settings" && (m === "PUT" || m === "POST")) {
			const next = saveSettings(await body(req));
			void syncMcp().then(() => {
				for (const s of live.values()) s.refresh();
				broadcast({ type: "mcp_changed", mcp: mcpStatus() });
			});
			for (const s of live.values()) s.refresh();
			return send(res, 200, next);
		}
		if (p === "/limits") return send(res, 200, limitStatus());
		if (p === "/stats") return send(res, 200, computeStats((q("range") as any) ?? "all", loadSettings().general.language));
		if (p === "/models") {
			const list = q("all") ? listProviders().flatMap((x) => modelsFor(x.id)) : availableModels();
			return send(res, 200, list.map(modelJson));
		}

		// providers & auth
		if (seg[0] === "providers") {
			if (seg.length === 1) return send(res, 200, listProviders());
			if (seg[2] === "models") {
				const r = await refreshModels(decodeURIComponent(seg[1]), q("refresh") === "1");
				return send(res, 200, { ...r, models: r.models.map(modelJson) });
			}
			if (seg[1] === "discover") {
				const b = await body(req);
				try {
					return send(res, 200, { models: await discoverLocalModels(b.baseUrl) });
				} catch (e) {
					return send(res, 400, { error: (e as Error).message });
				}
			}
			const id = decodeURIComponent(seg[1]);
			if (seg[2] === "key" && m === "POST") {
				const b = await body(req);
				setApiKey(id, b.key);
				return send(res, 200, { ok: true, providers: listProviders() });
			}
			if (m === "DELETE") {
				removeCredential(id);
				return send(res, 200, { ok: true, providers: listProviders() });
			}
			if (seg[2] === "oauth" && m === "POST") {
				const loginId = randomUUID().slice(0, 8);
				send(res, 200, { loginId });
				const ask = (kind: string, payload: any) =>
					new Promise<string>((resolveP) => {
						const pid = randomUUID().slice(0, 8);
						oauthPrompts.set(pid, resolveP);
						broadcast({ type: "oauth_prompt", loginId, promptId: pid, kind, ...payload });
					});
				loginOAuth(id, {
					onAuth: (info) => {
						broadcast({ type: "oauth_auth", loginId, provider: id, url: info.url, instructions: info.instructions });
						openUrl(info.url);
					},
					onPrompt: (pr) => ask("prompt", { message: pr.message, placeholder: pr.placeholder }),
					onManualCodeInput: () => ask("manual", { message: "Paste the code or redirect URL if the browser did not return automatically" }),
					onProgress: (msg) => broadcast({ type: "oauth_progress", loginId, message: msg }),
					onSelect: async (sel) => (await ask("select", { message: sel.message, options: sel.options })) || undefined,
				})
					.then(() => broadcast({ type: "oauth_done", loginId, provider: id, providers: listProviders() }))
					.catch((e) => broadcast({ type: "oauth_error", loginId, provider: id, error: (e as Error).message }));
				return;
			}
		}
		if (p === "/oauth/prompt" && m === "POST") {
			const b = await body(req);
			oauthPrompts.get(b.promptId)?.(b.value ?? "");
			oauthPrompts.delete(b.promptId);
			return send(res, 200, { ok: true });
		}

		// environments & filesystem
		if (seg[0] === "environments") {
			if (m === "GET") {
				const counts = sessionCountsByEnv();
				return send(res, 200, listEnvironments().map((e) => ({ ...e, sessions: counts[e.id] ?? 0, exists: existsSync(e.cwd) })));
			}
			if (m === "POST") {
				const b = await body(req);
				const dir = resolve(b.cwd);
				if (!existsSync(dir) || !statSync(dir).isDirectory()) return send(res, 400, { error: "Folder not found" });
				return send(res, 200, addEnvironment(b.name || parsePath(dir).base || dir, dir));
			}
			if (m === "PATCH") {
				updateEnvironment(seg[1], await body(req));
				return send(res, 200, listEnvironments());
			}
			if (m === "DELETE") {
				const id = decodeURIComponent(seg[1]);
				const deleteSessions = q("sessions") === "delete";
				// Live sessions first, so a later save doesn't write the old environment back.
				for (const [sid, s] of live) {
					if (s.data.meta.envId !== id) continue;
					if (deleteSessions) {
						s.abort();
						live.delete(sid);
					} else {
						s.data.meta.envId = null;
						s.persist();
					}
				}
				const r = removeEnvironment(id, { deleteSessions });
				broadcast({ type: "sessions_changed" });
				broadcast({ type: "environments_changed" });
				return send(res, 200, { ...r, environments: listEnvironments() });
			}
		}
		if (p === "/fs") {
			const dir = resolve(q("path") || homedir());
			try {
				const dirs = readdirSync(dir, { withFileTypes: true })
					.filter((d) => d.isDirectory() && !d.name.startsWith("$"))
					.map((d) => d.name)
					.sort((a, b) => a.localeCompare(b));
				return send(res, 200, { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, dirs });
			} catch (e) {
				return send(res, 400, { error: (e as Error).message });
			}
		}
		if (p === "/git") return send(res, 200, gitInfo(q("cwd") ?? process.cwd()));

		// sessions
		if (p === "/search") return send(res, 200, searchSessions(q("q") ?? ""));
		if (seg[0] === "sessions") {
			if (seg.length === 1 && m === "GET") return send(res, 200, guiSessions({ envId: q("envId"), query: q("q"), includeArchived: !!q("archived") }));
			if (seg.length === 1 && m === "POST") {
				const b = await body(req);
				const env = listEnvironments().find((e) => e.id === b.envId);
				const cwd = resolve(env?.cwd ?? b.cwd ?? process.cwd());
				const s = await ArgonSession.create({ cwd, envId: env?.id ?? null, model: b.model, effort: b.effort, mode: b.mode });
				attach(s);
				s.persist();
				send(res, 200, sessionPayload(s, s.id));
				broadcast({ type: "sessions_changed" });
				if (b.text) void s.prompt(b.text, b.images ?? []);
				return;
			}
			const id = seg[1];
			const action = seg[2];
			if (!action && m === "GET") {
				const pl = sessionPayload(live.get(id), id);
				return pl ? send(res, 200, pl) : send(res, 404, { error: "not found" });
			}
			if (!action && m === "PATCH") {
				const b = await body(req);
				const s = live.get(id);
				if (s) {
					Object.assign(s.data.meta, b);
					s.persist();
				} else updateSessionMeta(id, b);
				broadcast({ type: "sessions_changed" });
				return send(res, 200, { ok: true });
			}
			if (!action && m === "DELETE") {
				live.get(id)?.abort();
				live.delete(id);
				deleteSession(id);
				broadcast({ type: "sessions_changed" });
				return send(res, 200, { ok: true });
			}
			if (action === "export") {
				const data = loadSession(id);
				res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="argon-${id}.md"` });
				return void res.end(data ? sessionToMarkdown(data) : "");
			}
			const s = await getLive(id);
			const b = m === "POST" ? await body(req) : {};
			switch (action) {
				case "prompt": {
					let text: string = b.text ?? "";
					const expanded = text.startsWith("/") ? s.expandSlash(text) : null;
					if (expanded) text = expanded;
					void s.prompt(text, b.images ?? []);
					return send(res, 200, { ok: true });
				}
				case "abort":
					s.abort();
					return send(res, 200, { ok: true });
				case "approval":
					s.respondApproval(b.id, b.choice);
					return send(res, 200, { ok: true });
				case "answer":
					s.answerQuestion(b.id, b.answer);
					return send(res, 200, { ok: true });
				case "model":
					s.setModel(b.model);
					return send(res, 200, sessionPayload(s, id));
				case "effort":
					s.setEffort(b.effort);
					return send(res, 200, sessionPayload(s, id));
				case "mode":
					s.setMode(b.mode);
					return send(res, 200, sessionPayload(s, id));
				case "compact":
					await s.compact(b.instructions ?? "");
					return send(res, 200, sessionPayload(s, id));
				case "undo":
					return send(res, 200, { ...s.undo(), session: sessionPayload(s, id) });
				case "clear":
					s.clear();
					return send(res, 200, sessionPayload(s, id));
				case "gitstate":
					return send(res, 200, await gitState(s.cwd));
				case "pr": {
					const r = await createPullRequest(s.cwd, { title: b.title, body: b.body, base: b.base, draft: !!b.draft, commitMessage: b.commitMessage });
					s.data.meta.prs = [...(s.data.meta.prs ?? []), { number: r.number, url: r.url, title: b.title, branch: r.branch, createdAt: Date.now() }];
					s.persist();
					return send(res, 200, { ...r, session: sessionPayload(s, id) });
				}
				case "background": {
					if (seg[3] && seg[4] === "kill") s.background.kill(seg[3]);
					if (seg[3] && seg[4] === "output") return send(res, 200, s.background.read(seg[3], true));
					return send(res, 200, s.background.list());
				}
			}
		}

		if (p === "/usage") return send(res, 200, usageDetail((q("range") as any) ?? "all", q("session")));
		if (seg[0] === "github") {
			if (m === "GET") return send(res, 200, await githubStatus(q("refresh") === "1"));
			if (m === "POST") {
				try {
					return send(res, 200, await connectGithubToken(String((await body(req)).token ?? "")));
				} catch (e) {
					return send(res, 400, { error: (e as Error).message });
				}
			}
			if (m === "DELETE") return send(res, 200, await disconnectGithub());
		}
		if (p === "/import-cli") {
			if (m === "GET") return send(res, 200, pendingCliSessions());
			const r = await importCliSessions((await body(req)).ids);
			broadcast({ type: "sessions_changed" });
			broadcast({ type: "environments_changed" });
			return send(res, 200, r);
		}
		if (seg[0] === "favicon" && seg[1]) {
			const icon = await favicon(decodeURIComponent(seg[1]));
			if (!icon) return send(res, 404, { error: "no icon" });
			res.writeHead(200, { "Content-Type": icon.type, "Cache-Control": "max-age=604800" });
			return void res.end(icon.data);
		}

		// customization
		if (p === "/mcp") return send(res, 200, mcpStatus());
		if (seg[0] === "mcp" && seg[1] === "reconnect") {
			await reconnectMcp(decodeURIComponent(seg[2]));
			for (const s of live.values()) s.refresh();
			return send(res, 200, mcpStatus());
		}
		if (seg[0] === "agents") {
			if (m === "GET") return send(res, 200, listAgents(q("cwd") ?? process.cwd(), loadSettings(), true));
			if (m === "POST") return send(res, 200, { ok: true, file: saveAgent(await body(req)) });
			if (m === "DELETE") return send(res, 200, { ok: deleteAgent(decodeURIComponent(seg[1])) });
		}
		if (p === "/skills" && m === "POST") {
			const b = await body(req);
			const name = String(b.name ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
			if (!name) return send(res, 400, { error: "name required" });
			const dir = join(paths.skills, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${String(b.description ?? "").replace(/\n/g, " ")}\n---\n\n${b.body ?? ""}\n`);
			return send(res, 200, { ok: true, path: dir });
		}
		if (p === "/commands" && m === "POST") {
			const b = await body(req);
			const name = String(b.name ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
			if (!name) return send(res, 400, { error: "name required" });
			writeFileSync(join(paths.commands, `${name}.md`), `---\ndescription: ${String(b.description ?? "").replace(/\n/g, " ")}\n---\n\n${b.body ?? ""}\n`);
			return send(res, 200, { ok: true });
		}
		if (p === "/skills") return send(res, 200, listSkills(q("cwd") ?? process.cwd(), loadSettings(), true).map(({ body: _b, ...k }) => k));
		if (p === "/commands") return send(res, 200, listCommands(q("cwd") ?? process.cwd(), loadSettings()).map(({ body: _b, ...c }) => c));
		if (seg[0] === "memory") {
			if (m === "GET") return send(res, 200, q("cwd") ? listMemory(q("cwd")) : allMemory());
			if (m === "POST") {
				const b = await body(req);
				return send(res, 200, addMemory(b.scope ?? "global", b.cwd ?? process.cwd(), b.content));
			}
			if (m === "DELETE") return send(res, 200, { ok: removeMemory(seg[1]) });
		}
		if (p === "/instructions") {
			const file = q("path") ?? paths.globalInstructions;
			if (m === "GET") return send(res, 200, { path: file, content: existsSync(file) ? readFileSync(file, "utf8") : "" });
			if (m === "POST") {
				const b = await body(req);
				writeFileSync(b.path ?? paths.globalInstructions, b.content ?? "");
				return send(res, 200, { ok: true });
			}
		}
		send(res, 404, { error: "unknown endpoint" });
	}

	const server = createServer(async (req, res) => {
		const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		if (!validHost(req)) {
			res.writeHead(403).end("Forbidden host");
			return;
		}
		if (u.pathname === "/api/ping") {
			res.writeHead(200).end("argon " + VERSION);
			return;
		}
		if (u.pathname.startsWith("/api/")) {
			const iconWithToken = u.pathname.startsWith("/api/favicon/") && u.searchParams.get("t") === TOKEN;
			if (req.headers["x-argon-token"] !== TOKEN && !iconWithToken) {
				send(res, 401, { error: "Missing or invalid token. Open the GUI with `argon gui`." });
				return;
			}
			try {
				await api(req, res, u);
			} catch (e: any) {
				if (!res.headersSent) send(res, e.status ?? 500, { error: e.message ?? String(e) });
			}
			return;
		}
		// static
		let file = u.pathname === "/" ? "/index.html" : u.pathname;
		const vendor = VENDOR[file];
		file = vendor ? join(ROOT, "node_modules", vendor) : join(GUI_DIR, file);
		const full = resolve(file);
		if ((!vendor && !full.startsWith(GUI_DIR)) || !existsSync(full) || statSync(full).isDirectory()) {
			res.writeHead(404).end("Not found");
			return;
		}
		const headers: Record<string, string> = {
			"Content-Type": MIME[extname(full)] ?? "application/octet-stream",
			"Cache-Control": vendor && extname(full) === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache",
			"X-Content-Type-Options": "nosniff",
		};
		if (extname(full) === ".html") {
			headers["Content-Security-Policy"] =
				`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'; base-uri 'none'`;
			headers["X-Frame-Options"] = "DENY";
		}
		res.writeHead(200, headers);
		res.end(readFileSync(full));
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		if (!validHost(req) || u.searchParams.get("t") !== TOKEN) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			clients.add(ws);
			ws.on("close", () => clients.delete(ws));
			ws.send(JSON.stringify({ type: "hello", version: VERSION }));
		});
	});

	onUsage(() => broadcast({ type: "limits", limits: limitStatus() }));
	watchSharedFiles(() => broadcast({ type: "sessions_changed" }), () => {
		loadSettings();
		broadcast({ type: "settings_changed" });
	});
	onSettingsChange(() => broadcast({ type: "settings_changed" }));
	void syncMcp().then(() => broadcast({ type: "mcp_changed", mcp: mcpStatus() }));
	void refreshConnectedModels().then(() => broadcast({ type: "models_changed" }));

	await new Promise<void>((resolveP, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolveP());
	});
	port = (server.address() as { port: number }).port;
	url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
	open();
	return {
		url,
		close: () => {
			for (const s of live.values()) s.abort();
			for (const c of clients) c.terminate();
			server.close();
		},
	};
}

// ───────────────────────── provider favicons (fetched once, cached in ~/.argon/favicons) ─────────────────────────
const FAVICON_DOMAINS: Record<string, string> = {
	anthropic: "claude.ai",
	openai: "openai.com",
	"openai-codex": "chatgpt.com",
	openrouter: "openrouter.ai",
	google: "gemini.google.com",
	"google-vertex": "cloud.google.com",
	"github-copilot": "github.com",
	xai: "x.ai",
	groq: "groq.com",
	cerebras: "cerebras.ai",
	mistral: "mistral.ai",
	deepseek: "deepseek.com",
	"amazon-bedrock": "aws.amazon.com",
	"azure-openai-responses": "azure.microsoft.com",
	"vercel-ai-gateway": "vercel.com",
	"cloudflare-ai-gateway": "cloudflare.com",
	"cloudflare-workers-ai": "cloudflare.com",
	fireworks: "fireworks.ai",
	huggingface: "huggingface.co",
	moonshotai: "moonshot.ai",
	"moonshotai-cn": "moonshot.cn",
	"kimi-coding": "kimi.com",
	zai: "z.ai",
	minimax: "minimax.io",
	"minimax-cn": "minimaxi.com",
	opencode: "opencode.ai",
	"opencode-go": "opencode.ai",
	xiaomi: "xiaomi.com",
	ollama: "ollama.com",
	lmstudio: "lmstudio.ai",
	github: "github.com",
};
const iconMem = new Map<string, { type: string; data: Buffer } | null>();

async function favicon(provider: string): Promise<{ type: string; data: Buffer } | null> {
	if (iconMem.has(provider)) return iconMem.get(provider)!;
	const domain = FAVICON_DOMAINS[provider] ?? (provider.match(/^[a-z0-9-]+$/) ? undefined : undefined);
	const dir = join(paths.home, "favicons");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, provider.replace(/[^a-z0-9-]/gi, "_"));
	if (existsSync(file + ".bin")) {
		const meta = existsSync(file + ".type") ? readFileSync(file + ".type", "utf8") : "image/x-icon";
		const hit = meta === "none" ? null : { type: meta, data: readFileSync(file + ".bin") };
		iconMem.set(provider, hit);
		return hit;
	}
	if (!domain) return null;
	let result: { type: string; data: Buffer } | null = null;
	for (const u of [`https://${domain}/favicon.ico`, `https://${domain}/favicon.png`, `https://www.${domain}/favicon.ico`]) {
		try {
			const r = await fetch(u, { signal: AbortSignal.timeout(6000), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 Argon" } });
			const type = (r.headers.get("content-type") ?? "").split(";")[0];
			if (!r.ok || !/image|octet-stream/.test(type)) continue;
			const data = Buffer.from(await r.arrayBuffer());
			if (data.length < 64 || data.length > 512_000) continue;
			result = { type: type.includes("image") ? type : "image/x-icon", data };
			break;
		} catch {
			/* try next */
		}
	}
	writeFileSync(file + ".bin", result?.data ?? Buffer.alloc(0));
	writeFileSync(file + ".type", result?.type ?? "none");
	iconMem.set(provider, result);
	return result;
}

/** Watch ~/.argon for changes made by other Argon processes (e.g. the CLI). */
function watchSharedFiles(onSessions: () => void, onSettings: () => void): void {
	const timers: Record<string, NodeJS.Timeout> = {};
	const later = (k: string, fn: () => void) => {
		clearTimeout(timers[k]);
		timers[k] = setTimeout(fn, 150);
	};
	try {
		watch(paths.home, (_ev, name) => {
			if (name === "settings.json") later("settings", onSettings);
			if (name === "usage.jsonl") later("usage", () => usageChangedExternally());
		});
		watch(paths.sessions, (_ev, name) => {
			if (name === "index.json") later("sessions", onSessions);
		});
	} catch {
		/* watching not supported: changes still show up on the next request */
	}
}
