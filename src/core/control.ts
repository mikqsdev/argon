// Argon control: tools that let an AI agent operate Argon itself — appearance and settings, models,
// environments, sub-agents, skills, commands, memory, MCP connectors, sessions and permissions.
// They are served over MCP (`/mcp` on the core, `argon mcp serve` over stdio) and, as the built-in
// "Argon" connector, to Argon's own agent. Everything is off until settings.agentControl.enabled.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { loadSettings, saveSettings, deepMerge, type McpServerConfig, type Settings } from "./config.js";
import { listAgents, saveAgent, deleteAgent } from "./agents.js";
import { listSkills, listCommands, saveSkill, saveCommand } from "./skills.js";
import { allMemory, addMemory, removeMemory } from "./memory.js";
import { availableModels, listProviders, modelKey, resolveModel } from "./providers.js";
import { addEnvironment, listEnvironments, listSessions, loadSession, removeEnvironment } from "./sessions.js";
import { limitStatus, usageDetail } from "./usage.js";
import { mcpStatus, type McpServerStatus } from "./mcp.js";
import { paths } from "./paths.js";

export type ControlGroup = "settings" | "agents" | "connectors" | "sessions" | "security";
export const CONTROL_GROUPS: ControlGroup[] = ["settings", "agents", "connectors", "sessions", "security"];

/** Live sessions, as the server sees them (absent outside the server). */
export interface ControlSessions {
	create(o: { prompt: string; cwd?: string; envId?: string | null; model?: string; mode?: string }): Promise<{ id: string }>;
	send(id: string, text: string, queue: boolean): Promise<void>;
	stop(id: string): Promise<boolean>;
	status(id: string): { status: string; queued: number } | undefined;
	btw(id: string, question: string): Promise<{ status: string; text: string; error?: string }>;
}

export interface ControlContext {
	/** Settings were saved by a tool: re-sync MCP servers, refresh sessions, tell the clients. */
	settingsChanged?(): void;
	/** Sessions or environments changed. */
	changed?(what: "sessions" | "environments"): void;
	/** Show a page in the open apps (a GUI hash like "/settings/appearance"). Returns how many apps got it. */
	navigate?(hash: string): number;
	sessions?: ControlSessions;
}

interface ControlTool {
	name: string;
	group: ControlGroup;
	title: string;
	description: string;
	readOnly?: boolean;
	destructive?: boolean;
	inputSchema: Record<string, unknown>;
	run(args: any, ctx: ControlContext): unknown | Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

// Same palettes as the GUI (gui/js/theme.js PRESETS).
const PRESETS: Record<string, { seed: string; scheme?: string }> = {
	argon: { seed: "#7c4dff" },
	neon: { seed: "#ff4b2b" },
	xenon: { seed: "#3d7bff" },
	helium: { seed: "#f2b300" },
	copper: { seed: "#c06a3b" },
	chromium: { seed: "#2e9d5b" },
	rhodium: { seed: "#d81b60" },
	carbon: { seed: "#5f6368", scheme: "monochrome" },
};

/** Which settings sections each permission group may change (null = never through these tools). */
const SECTION_GROUP: Record<string, ControlGroup | null> = {
	general: "settings",
	appearance: "settings",
	model: "settings",
	limits: "settings",
	context: "settings",
	cli: "settings",
	providers: "settings",
	environments: "settings",
	skills: "agents",
	agents: "agents",
	mcp: "connectors",
	permissions: "security",
	hooks: "security",
	tools: "security",
	agentControl: null,
};

const SECRET = "•••";
/** Settings without secrets (search API key, MCP env/headers values, the control token). */
function redacted(s: Settings): any {
	const c: any = structuredClone(s);
	if (c.tools?.webSearch?.apiKey) c.tools.webSearch.apiKey = SECRET;
	for (const srv of Object.values<any>(c.mcp?.servers ?? {})) {
		for (const k of Object.keys(srv.env ?? {})) srv.env[k] = SECRET;
		for (const k of Object.keys(srv.headers ?? {})) srv.headers[k] = SECRET;
	}
	if (c.agentControl?.token) c.agentControl.token = SECRET;
	return c;
}

function save(ctx: ControlContext, s: Settings): Settings {
	const out = saveSettings(s);
	ctx.settingsChanged?.();
	return out;
}

const userCwd = () => homedir();
const textOf = (content: any): string => (typeof content === "string" ? content : (content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).join(""));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function needSessions(ctx: ControlContext): ControlSessions {
	if (!ctx.sessions) throw new Error("Sessions are only available while the Argon app (or `argon mcp serve`) is running.");
	return ctx.sessions;
}

const TOOLS: ControlTool[] = [
	// ───────────── settings, appearance, models, environments, usage ─────────────
	{
		name: "get_settings",
		group: "settings",
		title: "Read settings",
		description: "Read Argon's settings (secrets are hidden). Optionally only one section, e.g. appearance, general, model, limits, permissions, mcp.",
		readOnly: true,
		inputSchema: obj({ section: str("Settings section to return (omit for all)") }),
		run: (a) => {
			const s = redacted(loadSettings());
			if (!a.section) return s;
			if (!(a.section in s)) throw new Error(`Unknown section "${a.section}". Sections: ${Object.keys(s).join(", ")}`);
			return s[a.section];
		},
	},
	{
		name: "update_settings",
		group: "settings",
		title: "Change settings",
		description:
			"Change any Argon setting by deep-merging `changes` into the settings (arrays are replaced). Example: {\"general\": {\"userName\": \"Ada\"}, \"limits\": {\"enabled\": true}}. " +
			"Sections: general, appearance, model, limits, context, cli, providers, environments (settings group); skills, agents (agents group); mcp (connectors group); permissions, hooks, tools (security group). agentControl can't be changed here.",
		inputSchema: obj({ changes: { type: "object", description: "Partial settings object to merge" } }, ["changes"]),
		run: (a, ctx) => {
			const changes = a.changes ?? {};
			if (typeof changes !== "object" || Array.isArray(changes)) throw new Error("`changes` must be an object");
			const s = loadSettings();
			for (const k of Object.keys(changes)) {
				if (!(k in SECTION_GROUP)) throw new Error(`Unknown settings section "${k}"`);
				const g = SECTION_GROUP[k];
				if (!g) throw new Error(`"${k}" can only be changed by the user in Argon's settings.`);
				if (!s.agentControl.allow[g]) throw new Error(`Changing "${k}" needs the "${g}" permission (Argon → Settings → AI agent control).`);
			}
			const next = save(ctx, deepMerge(s, changes));
			return { ok: true, changed: Object.fromEntries(Object.keys(changes).map((k) => [k, redacted(next)[k]])) };
		},
	},
	{
		name: "set_appearance",
		group: "settings",
		title: "Change the look",
		description:
			"Change Argon's look. palette: argon (violet), neon (red), xenon (blue), helium (yellow), copper, chromium (green), rhodium (pink), carbon (grey); or color: any hex seed colour. " +
			"Also theme (dark/light/system), scheme, contrast, shapes (corner radius), motion and size (UI scale 80–130%). Applies live.",
		inputSchema: obj({
			palette: str("Preset palette", { enum: Object.keys(PRESETS) }),
			color: str("Seed colour as #rrggbb (overrides palette)"),
			theme: str("Theme", { enum: ["dark", "light", "system"] }),
			scheme: str("How colourful the palette is", { enum: ["tonalSpot", "vibrant", "expressive", "fidelity", "neutral", "monochrome"] }),
			contrast: str("Contrast", { enum: ["standard", "medium", "high"] }),
			shapes: str("Corner radius", { enum: ["square", "standard", "round"] }),
			motion: str("Animations", { enum: ["full", "reduced", "off"] }),
			size: { type: "number", description: "UI size in percent (80–130)" },
		}),
		run: (a, ctx) => {
			const s = loadSettings();
			const ap = s.appearance;
			if (a.palette) {
				const p = PRESETS[a.palette];
				if (!p) throw new Error(`Unknown palette "${a.palette}"`);
				Object.assign(ap, { preset: a.palette, seed: p.seed, scheme: p.scheme ?? (ap.scheme === "monochrome" ? "tonalSpot" : ap.scheme) });
			}
			if (a.color) {
				if (!/^#[0-9a-f]{6}$/i.test(a.color)) throw new Error("color must be #rrggbb");
				Object.assign(ap, { seed: a.color.toLowerCase(), preset: "custom" });
			}
			if (a.scheme) ap.scheme = a.scheme;
			if (a.contrast) ap.contrast = a.contrast;
			if (a.shapes) ap.radius = a.shapes;
			if (a.motion) ap.motion = a.motion;
			if (a.size != null) ap.scale = Math.min(130, Math.max(80, Math.round(Number(a.size) / 5) * 5));
			if (a.theme) s.general.theme = a.theme;
			const next = save(ctx, s);
			return { ok: true, appearance: next.appearance, theme: next.general.theme };
		},
	},
	{
		name: "list_models",
		group: "settings",
		title: "List models",
		description: "Models Argon can use (from connected providers), with their key for set_model. Filter by provider or text.",
		readOnly: true,
		inputSchema: obj({ provider: str("Provider id, e.g. anthropic, openrouter"), query: str("Text to search in id or name"), limit: { type: "number", description: "Max results (default 50)" } }),
		run: (a) => {
			const q = String(a.query ?? "").toLowerCase();
			const list = availableModels()
				.filter((m) => (!a.provider || m.provider === a.provider) && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q)))
				.slice(0, Math.min(200, Number(a.limit) || 50))
				.map((m) => ({ key: modelKey(m), name: m.name, reasoning: m.reasoning, context: m.contextWindow, price: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined }));
			return { current: loadSettings().model.default, models: list, providers: listProviders().filter((p) => p.connected).map((p) => p.id) };
		},
	},
	{
		name: "set_model",
		group: "settings",
		title: "Choose the default model",
		description: "Set the default model for new sessions (key like provider/model-id, see list_models), and optionally the reasoning effort and the small model used for titles and sub-agents.",
		inputSchema: obj(
			{ model: str("Model key, e.g. anthropic/claude-sonnet-4-6"), effort: str("Reasoning effort", { enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }), small: str("Small model key ('' = same as default)") },
			["model"],
		),
		run: (a, ctx) => {
			const m = resolveModel(a.model);
			if (!m) throw new Error(`Model "${a.model}" not found. Use list_models.`);
			const s = loadSettings();
			s.model.default = modelKey(m);
			if (a.effort) s.model.effort = a.effort;
			if (a.small != null) {
				if (a.small && !resolveModel(a.small)) throw new Error(`Model "${a.small}" not found`);
				s.model.small = a.small;
			}
			return { ok: true, model: save(ctx, s).model };
		},
	},
	{
		name: "list_environments",
		group: "settings",
		title: "List environments",
		description: "Argon environments (named project folders that group sessions).",
		readOnly: true,
		inputSchema: obj({}),
		run: () => listEnvironments(),
	},
	{
		name: "add_environment",
		group: "settings",
		title: "Add an environment",
		description: "Add an environment: a name and an existing folder. Sessions started in it work in that folder (writes outside it always ask).",
		inputSchema: obj({ name: str("Environment name"), path: str("Absolute folder path") }, ["name", "path"]),
		run: (a, ctx) => {
			const dir = resolve(String(a.path));
			if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
			const env = addEnvironment(String(a.name).trim() || dir, dir);
			ctx.changed?.("environments");
			return env;
		},
	},
	{
		name: "remove_environment",
		group: "settings",
		title: "Remove an environment",
		description: "Remove an environment (never its folder). Its sessions move to 'no environment' unless delete_sessions is true.",
		destructive: true,
		inputSchema: obj({ id: str("Environment id (see list_environments)"), delete_sessions: { type: "boolean" } }, ["id"]),
		run: (a, ctx) => {
			const r = removeEnvironment(a.id, { deleteSessions: !!a.delete_sessions });
			ctx.changed?.("environments");
			if (a.delete_sessions) ctx.changed?.("sessions");
			return r;
		},
	},
	{
		name: "get_usage",
		group: "settings",
		title: "Usage and limits",
		description: "Usage limits (5-hour and weekly), money spent, and usage per model, provider and sub-agent.",
		readOnly: true,
		inputSchema: obj({ range: str("Period", { enum: ["all", "30d", "7d"] }) }),
		run: (a) => {
			const d: any = usageDetail(a.range ?? "30d");
			for (const k of Object.keys(d)) if (Array.isArray(d[k])) d[k] = d[k].slice(0, 15);
			return { limits: limitStatus(), usage: d };
		},
	},
	{
		name: "open_in_app",
		group: "settings",
		title: "Show a page in the app",
		description:
			"Show a page in the open Argon app: home, search, stats, usage, customize[/connectors|agents|skills|commands|memory|hooks], settings[/general|appearance|providers|github|models|limits|permissions|tools|context|environments|cli|control|advanced], or session:<id>.",
		inputSchema: obj({ page: str("Page to show") }, ["page"]),
		run: (a, ctx) => {
			const p = String(a.page).trim().replace(/^\/+/, "");
			const hash = p === "home" || !p ? "/" : p.startsWith("session:") ? `/s/${p.slice(8)}` : `/${p}`;
			if (!ctx.navigate) throw new Error("No Argon app is open.");
			const n = ctx.navigate(hash);
			return n ? { ok: true, shown: hash } : { ok: false, note: "No Argon window is open right now." };
		},
	},

	// ───────────── sub-agents, skills, commands, memory ─────────────
	{
		name: "list_agents",
		group: "agents",
		title: "List sub-agents",
		description: "Sub-agents (built-in and custom) with their tools, model and whether they are enabled.",
		readOnly: true,
		inputSchema: obj({}),
		run: () => listAgents(userCwd(), loadSettings(), true).map((a: any) => ({ name: a.name, description: a.description, tools: a.tools, model: a.model, effort: a.effort, source: a.source, enabled: !loadSettings().agents.disabled.includes(a.name) })),
	},
	{
		name: "create_agent",
		group: "agents",
		title: "Create a sub-agent",
		description: "Create (or replace) a custom sub-agent that Argon's agent can delegate to. tools: 'all', 'read-only', or a list of tool names (e.g. ['read','grep','web_search']). model: 'inherit', 'small', or a model key.",
		inputSchema: obj(
			{
				name: str("Short name (letters, digits, dashes)"),
				description: str("When to use it (the main agent reads this)"),
				prompt: str("Its instructions"),
				tools: { description: "'all', 'read-only' or a list of tool names", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
				model: str("'inherit', 'small' or a model key"),
				effort: str("Reasoning effort", { enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }),
				color: str("Colour as #rrggbb"),
			},
			["name", "description", "prompt"],
		),
		run: (a) => {
			const file = saveAgent({ name: a.name, description: a.description, prompt: a.prompt, tools: Array.isArray(a.tools) ? a.tools.join(", ") : (a.tools ?? "all"), model: a.model ?? "inherit", effort: a.effort, color: a.color });
			return { ok: true, file };
		},
	},
	{
		name: "delete_agent",
		group: "agents",
		title: "Delete a sub-agent",
		description: "Delete a custom sub-agent (built-in ones can only be disabled, via update_settings agents.disabled).",
		destructive: true,
		inputSchema: obj({ name: str("Sub-agent name") }, ["name"]),
		run: (a) => {
			if (!deleteAgent(String(a.name))) throw new Error(`No custom sub-agent named "${a.name}"`);
			return { ok: true };
		},
	},
	{
		name: "list_skills",
		group: "agents",
		title: "List skills and commands",
		description: "Skills (instructions the agent can load) and custom slash commands.",
		readOnly: true,
		inputSchema: obj({}),
		run: () => {
			const s = loadSettings();
			return {
				skills: listSkills(userCwd(), s, true).map((k: any) => ({ name: k.name, description: k.description, enabled: !s.skills.disabled.includes(k.name), path: k.path })),
				commands: listCommands(userCwd(), s).map((c: any) => ({ name: "/" + c.name, description: c.description })),
			};
		},
	},
	{
		name: "create_skill",
		group: "agents",
		title: "Create a skill",
		description: "Create (or replace) a global skill: a name, a description of when to use it, and its instructions (Markdown).",
		inputSchema: obj({ name: str("Skill name"), description: str("When to use it"), instructions: str("The skill's instructions (Markdown)") }, ["name", "description", "instructions"]),
		run: (a) => ({ ok: true, path: saveSkill({ name: a.name, description: a.description, body: a.instructions }) }),
	},
	{
		name: "delete_skill",
		group: "agents",
		title: "Delete a skill",
		description: "Delete a global skill created in Argon (project skills are left alone).",
		destructive: true,
		inputSchema: obj({ name: str("Skill name") }, ["name"]),
		run: (a) => {
			const dir = join(paths.skills, String(a.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
			if (!dir.startsWith(paths.skills) || !existsSync(dir)) throw new Error(`No global skill named "${a.name}"`);
			rmSync(dir, { recursive: true, force: true });
			return { ok: true };
		},
	},
	{
		name: "create_command",
		group: "agents",
		title: "Create a slash command",
		description: "Create (or replace) a global slash command: typing /name in Argon sends this prompt ($ARGUMENTS is replaced by what follows the command).",
		inputSchema: obj({ name: str("Command name without /"), description: str("What it does"), prompt: str("The prompt it sends") }, ["name", "prompt"]),
		run: (a) => ({ ok: true, file: saveCommand({ name: a.name, description: a.description ?? "", body: a.prompt }) }),
	},
	{
		name: "list_memory",
		group: "agents",
		title: "List memories",
		description: "Facts Argon remembers (global and per project).",
		readOnly: true,
		inputSchema: obj({}),
		run: () => allMemory(),
	},
	{
		name: "add_memory",
		group: "agents",
		title: "Remember something",
		description: "Add a memory Argon's agent will see in every session (global) or in one project folder.",
		inputSchema: obj({ content: str("What to remember"), scope: str("global or project", { enum: ["global", "project"] }), project_path: str("Project folder (for scope=project)") }, ["content"]),
		run: (a) => addMemory(a.scope === "project" ? "project" : "global", a.project_path ? resolve(a.project_path) : userCwd(), String(a.content)),
	},
	{
		name: "remove_memory",
		group: "agents",
		title: "Forget a memory",
		description: "Remove a memory by id (see list_memory).",
		destructive: true,
		inputSchema: obj({ id: str("Memory id") }, ["id"]),
		run: (a) => {
			if (!removeMemory(String(a.id))) throw new Error(`No memory with id "${a.id}"`);
			return { ok: true };
		},
	},

	// ───────────── MCP connectors ─────────────
	{
		name: "list_connectors",
		group: "connectors",
		title: "List MCP connectors",
		description: "MCP servers connected to Argon, with their status and tools.",
		readOnly: true,
		inputSchema: obj({}),
		run: () => mcpStatus().map((m) => ({ name: m.name, status: m.status, transport: m.transport, error: m.error, tools: m.tools.map((t) => t.name) })),
	},
	{
		name: "add_connector",
		group: "connectors",
		title: "Connect an MCP server",
		description: "Connect an MCP server to Argon. Local server: command (+ args, env). Remote server: url (+ headers); type is guessed (url ending in /sse = SSE, else Streamable HTTP). Replaces a connector with the same name.",
		inputSchema: obj(
			{
				name: str("Connector name (letters, digits, - _)"),
				command: str("Command to start a local server, e.g. npx"),
				args: { type: "array", items: { type: "string" }, description: "Arguments, e.g. ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/me']" },
				env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables" },
				url: str("URL of a remote server"),
				headers: { type: "object", additionalProperties: { type: "string" }, description: "HTTP headers, e.g. Authorization" },
				type: str("Transport", { enum: ["stdio", "http", "sse"] }),
			},
			["name"],
		),
		run: (a, ctx) => {
			const name = String(a.name).trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
			if (!name) throw new Error("name required");
			if (name.toLowerCase() === "argon") throw new Error('"argon" is the built-in connector');
			if (!a.command && !a.url) throw new Error("Give a command (local server) or a url (remote server)");
			const cfg: McpServerConfig = a.url ? { url: a.url, headers: a.headers, type: a.type === "stdio" ? undefined : a.type, enabled: true } : { command: a.command, args: a.args ?? [], env: a.env, enabled: true };
			const s = loadSettings();
			s.mcp.servers[name] = JSON.parse(JSON.stringify(cfg));
			save(ctx, s);
			return { ok: true, name, note: "Connecting… use list_connectors to see its status and tools." };
		},
	},
	{
		name: "remove_connector",
		group: "connectors",
		title: "Remove an MCP connector",
		description: "Disconnect and remove an MCP server from Argon.",
		destructive: true,
		inputSchema: obj({ name: str("Connector name") }, ["name"]),
		run: (a, ctx) => {
			const s = loadSettings();
			if (!s.mcp.servers[a.name]) throw new Error(`No connector named "${a.name}"`);
			delete s.mcp.servers[a.name];
			save(ctx, s);
			return { ok: true };
		},
	},
	{
		name: "set_connector_enabled",
		group: "connectors",
		title: "Turn a connector on or off",
		description: "Enable or disable an MCP connector without removing it.",
		inputSchema: obj({ name: str("Connector name"), enabled: { type: "boolean" } }, ["name", "enabled"]),
		run: (a, ctx) => {
			const s = loadSettings();
			const c = s.mcp.servers[a.name];
			if (!c) throw new Error(`No connector named "${a.name}"`);
			c.enabled = !!a.enabled;
			save(ctx, s);
			return { ok: true, name: a.name, enabled: c.enabled };
		},
	},

	// ───────────── sessions ─────────────
	{
		name: "list_sessions",
		group: "sessions",
		title: "List sessions",
		description: "Argon sessions (conversations), newest first, with their status. Optional text search.",
		readOnly: true,
		inputSchema: obj({ query: str("Search text"), limit: { type: "number", description: "Max results (default 20)" } }),
		run: (a, ctx) =>
			listSessions({ query: a.query })
				.slice(0, Math.min(100, Number(a.limit) || 20))
				.map((m) => ({ id: m.id, title: m.title, folder: m.cwd, model: m.model, updated: new Date(m.updatedAt).toISOString(), messages: m.messageCount, status: ctx.sessions?.status(m.id)?.status ?? "idle", origin: m.origin ?? "gui" })),
	},
	{
		name: "read_session",
		group: "sessions",
		title: "Read a session",
		description: "A session's status and its last messages (user and assistant text, tool calls summarised).",
		readOnly: true,
		inputSchema: obj({ id: str("Session id"), last: { type: "number", description: "How many messages (default 12)" } }, ["id"]),
		run: (a, ctx) => {
			const d = loadSession(a.id);
			if (!d) throw new Error(`No session "${a.id}"`);
			const msgs = (d.messages as any[]).slice(-(Math.min(60, Number(a.last) || 12)));
			return {
				id: d.meta.id,
				title: d.meta.title,
				folder: d.meta.cwd,
				model: d.meta.model,
				mode: d.meta.mode,
				status: ctx.sessions?.status(a.id) ?? { status: "idle", queued: 0 },
				todos: d.todos,
				messages: msgs.map((m) =>
					m.role === "user"
						? { role: "user", text: clip(textOf(m.content), 2000) }
						: m.role === "assistant"
							? { role: "assistant", text: clip(textOf((m.content ?? []).filter((c: any) => c.type === "text")), 3000), tools: (m.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => c.name) }
							: { role: "tool", tool: m.toolName, error: !!m.isError, text: clip(textOf(m.content), 400) },
				),
			};
		},
	},
	{
		name: "start_session",
		group: "sessions",
		title: "Start a session",
		description: "Start a new Argon session with a first message; Argon's agent starts working on it (it shows up live in the app). Folder: an environment id, a path, or the user's home.",
		inputSchema: obj(
			{
				prompt: str("First message"),
				environment: str("Environment id (see list_environments)"),
				path: str("Working folder (if no environment)"),
				model: str("Model key (default: Argon's default)"),
				mode: str("Permission mode", { enum: ["ask", "acceptEdits", "auto", "plan"] }),
			},
			["prompt"],
		),
		run: async (a, ctx) => {
			if (a.mode === "auto" && !loadSettings().agentControl.allow.security) throw new Error('Starting a session in "auto" mode needs the "security" permission.');
			return needSessions(ctx).create({ prompt: a.prompt, envId: a.environment ?? null, cwd: a.path ? resolve(a.path) : undefined, model: a.model, mode: a.mode });
		},
	},
	{
		name: "send_message",
		group: "sessions",
		title: "Send a message",
		description: "Send a message to a session. when='now' (default): if the agent is working it reads it after its current step. when='queue': it waits until the agent has finished.",
		inputSchema: obj({ id: str("Session id"), text: str("Message"), when: str("now or queue", { enum: ["now", "queue"] }) }, ["id", "text"]),
		run: async (a, ctx) => {
			await needSessions(ctx).send(a.id, String(a.text), a.when === "queue");
			return { ok: true };
		},
	},
	{
		name: "stop_session",
		group: "sessions",
		title: "Stop a session",
		description: "Stop the agent working in a session.",
		inputSchema: obj({ id: str("Session id") }, ["id"]),
		run: async (a, ctx) => ({ ok: await needSessions(ctx).stop(a.id) }),
	},
	{
		name: "ask_side_question",
		group: "sessions",
		title: "Side question (/btw)",
		description: "Ask a quick question about a session without interrupting it: a read-only sub-agent answers from its conversation (like /btw). Waits for the answer.",
		readOnly: true,
		inputSchema: obj({ id: str("Session id"), question: str("The question") }, ["id", "question"]),
		run: async (a, ctx) => needSessions(ctx).btw(a.id, String(a.question)),
	},

	// ───────────── permissions and hooks (off by default) ─────────────
	{
		name: "set_permission_mode",
		group: "security",
		title: "Default permission mode",
		description: "Default permission mode for new sessions: ask (approve edits/commands), acceptEdits, auto (no approvals), plan (read-only).",
		inputSchema: obj({ mode: str("Mode", { enum: ["ask", "acceptEdits", "auto", "plan"] }) }, ["mode"]),
		run: (a, ctx) => {
			const s = loadSettings();
			s.permissions.mode = a.mode;
			return { ok: true, mode: save(ctx, s).permissions.mode };
		},
	},
	{
		name: "set_permission_rule",
		group: "security",
		title: "Allow or deny a tool pattern",
		description: "Add or remove a permission rule. Patterns like 'bash(git status*)', 'write', 'mcp__github__*'. list: allow or deny.",
		inputSchema: obj({ list: str("allow or deny", { enum: ["allow", "deny"] }), pattern: str("Tool pattern"), remove: { type: "boolean", description: "Remove instead of add" } }, ["list", "pattern"]),
		run: (a, ctx) => {
			const s = loadSettings();
			const arr: string[] = s.permissions[a.list as "allow" | "deny"];
			const i = arr.indexOf(a.pattern);
			if (a.remove) {
				if (i >= 0) arr.splice(i, 1);
			} else if (i < 0) arr.push(a.pattern);
			const next = save(ctx, s);
			return { ok: true, allow: next.permissions.allow, deny: next.permissions.deny };
		},
	},
];

/** Italian titles for the settings page (the MCP side stays in English). */
const TITLES_IT: Record<string, string> = {
	get_settings: "Leggere le impostazioni",
	update_settings: "Cambiare le impostazioni",
	set_appearance: "Cambiare l'aspetto",
	list_models: "Elencare i modelli",
	set_model: "Scegliere il modello predefinito",
	list_environments: "Elencare gli ambienti",
	add_environment: "Aggiungere un ambiente",
	remove_environment: "Rimuovere un ambiente",
	get_usage: "Utilizzo e limiti",
	open_in_app: "Mostrare una pagina nell'app",
	list_agents: "Elencare i sub-agenti",
	create_agent: "Creare un sub-agente",
	delete_agent: "Eliminare un sub-agente",
	list_skills: "Elencare skill e comandi",
	create_skill: "Creare una skill",
	delete_skill: "Eliminare una skill",
	create_command: "Creare un comando /",
	list_memory: "Elencare le memorie",
	add_memory: "Ricordare qualcosa",
	remove_memory: "Dimenticare una memoria",
	list_connectors: "Elencare i connettori MCP",
	add_connector: "Collegare un server MCP",
	remove_connector: "Rimuovere un connettore",
	set_connector_enabled: "Accendere o spegnere un connettore",
	list_sessions: "Elencare le sessioni",
	read_session: "Leggere una sessione",
	start_session: "Avviare una sessione",
	send_message: "Mandare un messaggio",
	stop_session: "Fermare una sessione",
	ask_side_question: "Domanda a parte (/btw)",
	set_permission_mode: "Modalità permessi predefinita",
	set_permission_rule: "Regole allow/deny",
};

/** Tools the current settings let through (none while control is off). */
export function allowedControlTools(s: Settings = loadSettings()): ControlTool[] {
	if (!s.agentControl?.enabled) return [];
	return TOOLS.filter((t) => s.agentControl.allow?.[t.group]);
}

/** Every tool with its group, for the settings page. */
export function controlToolList(): { name: string; title: string; titleIt: string; group: ControlGroup; description: string; readOnly: boolean }[] {
	return TOOLS.map((t) => ({ name: t.name, title: t.title, titleIt: TITLES_IT[t.name] ?? t.title, group: t.group, description: t.description, readOnly: !!t.readOnly }));
}

/** Run one tool; errors come back as text with isError. */
export async function callControlTool(name: string, args: unknown, ctx: ControlContext): Promise<{ text: string; isError?: boolean }> {
	const s = loadSettings();
	if (!s.agentControl?.enabled) return { text: "AI agent control is turned off in Argon (Settings → AI agent control).", isError: true };
	const tool = TOOLS.find((t) => t.name === name);
	if (!tool) return { text: `Unknown tool "${name}"`, isError: true };
	if (!s.agentControl.allow?.[tool.group]) return { text: `"${name}" needs the "${tool.group}" permission, which is off in Argon (Settings → AI agent control).`, isError: true };
	try {
		const out = await tool.run(args ?? {}, ctx);
		return { text: typeof out === "string" ? out : JSON.stringify(out ?? { ok: true }, null, 2) };
	} catch (e) {
		return { text: (e as Error).message, isError: true };
	}
}

const INSTRUCTIONS =
	"Argon is an open-source AI agent with a desktop app and a CLI. These tools operate Argon itself: look (palette, theme, size), settings, models, environments, " +
	"sub-agents, skills, slash commands, memory, MCP connectors, sessions (start, message, stop, side questions) and, if allowed, permissions. Changes apply live in the open app. " +
	"The user chooses which groups are allowed in Argon → Settings → AI agent control.";

/** An MCP server (SDK, low level) exposing the allowed tools. One per connection or request. */
export function controlMcpServer(ctx: ControlContext, version: string): Server {
	const server = new Server({ name: "argon", title: "Argon", version }, { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: allowedControlTools().map((t) => ({
			name: t.name,
			title: t.title,
			description: t.description,
			inputSchema: t.inputSchema as any,
			annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const r = await callControlTool(req.params.name, req.params.arguments ?? {}, ctx);
		return { content: [{ type: "text", text: r.text }], isError: !!r.isError };
	});
	return server;
}

// ───────────── the built-in "Argon" connector (Argon's own agent) ─────────────

let serverCtx: ControlContext | undefined;
/** The server registers its context so Argon's own agent can use the tools too. */
export function setControlContext(ctx: ControlContext | undefined): void {
	serverCtx = ctx;
}

const builtinOn = (s: Settings) => !!(s.agentControl?.enabled && s.agentControl.builtin !== false && serverCtx);

/** The control tools as agent tools (named like MCP tools: mcp__argon__<tool>). */
export function controlAgentTools(): AgentTool<any>[] {
	const s = loadSettings();
	if (!builtinOn(s)) return [];
	return allowedControlTools(s).map((t) => ({
		name: `mcp__argon__${t.name}`,
		label: `Argon · ${t.title}`,
		description: `[Argon] ${t.description}`.slice(0, 1024),
		parameters: t.inputSchema as any,
		async execute(_id: string, args: unknown) {
			const r = await callControlTool(t.name, args, serverCtx!);
			if (r.isError) throw new Error(r.text);
			return { content: [{ type: "text" as const, text: r.text }], details: { server: "argon", tool: t.name } };
		},
	}));
}

/** How the built-in connector shows up in the connectors list. */
export function builtinConnectorStatus(): McpServerStatus & { builtin: true } {
	const s = loadSettings();
	const on = builtinOn(s);
	return {
		name: "argon",
		transport: "built-in",
		builtin: true,
		status: on ? "connected" : "disabled",
		error: s.agentControl?.enabled ? undefined : "AI agent control is off (Settings → AI agent control)",
		tools: on ? allowedControlTools(s).map((t) => ({ name: t.name, description: t.title })) : [],
	};
}

/** Make sure there is a token for MCP over HTTP once control is on. Returns the settings. */
export function ensureControlToken(): Settings {
	const s = loadSettings();
	if (s.agentControl?.enabled && !s.agentControl.token) {
		s.agentControl.token = randomBytes(24).toString("base64url");
		return saveSettings(s);
	}
	return s;
}
