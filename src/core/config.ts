import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { paths, ensureDirs } from "./paths.js";

export type PermissionMode = "ask" | "acceptEdits" | "auto" | "plan";
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type LimitUnit = "tokens" | "cost";

export interface LimitWindow {
	enabled: boolean;
	/** Token count or USD amount, depending on `limits.unit`. */
	value: number;
}

export interface McpServerConfig {
	/** stdio: command + args. http/sse: url. */
	type?: "stdio" | "http" | "sse";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
}

export interface HookConfig {
	event: "sessionStart" | "userPrompt" | "preToolUse" | "postToolUse" | "stop";
	/** Regex on the tool name (tool events only). */
	matcher?: string;
	command: string;
	timeoutMs?: number;
}

export interface CustomModel {
	provider: string;
	id: string;
	name?: string;
	/** Model of the same provider to copy defaults (api, baseUrl, pricing) from. */
	template?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	/** USD per 1M tokens. */
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface CustomProvider {
	id: string;
	name: string;
	/** OpenAI-compatible endpoint, e.g. http://localhost:11434/v1 */
	baseUrl: string;
	api?: "openai-completions" | "openai-responses" | "anthropic-messages";
	/** Comma-free list of model ids. */
	models: string[];
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	/** Set true for local servers that need no key. */
	noAuth?: boolean;
}

export interface Environment {
	id: string;
	name: string;
	cwd: string;
	/** Optional per-environment overrides. */
	model?: string;
	permissionMode?: PermissionMode;
}

export interface Settings {
	general: {
		userName: string;
		language: "it" | "en";
		theme: "dark" | "light" | "system";
		greeting: string;
		showStatsOnHome: boolean;
		autoTitle: boolean;
		guiPort: number;
		openGuiAs: "desktop" | "app" | "browser" | "none";
	};
	model: {
		/** "provider/modelId" */
		default: string;
		effort: Effort;
		/** Optional cheaper model used for titles, summaries and sub-agents. */
		small: string;
		temperature: number | null;
		maxOutputTokens: number | null;
	};
	providers: {
		/** Providers shown in pickers; empty = all with credentials. */
		enabled: string[];
		custom: CustomProvider[];
		customModels: CustomModel[];
		openRouterRouting: { sort?: string; dataCollection?: "allow" | "deny"; zdr?: boolean };
	};
	limits: {
		enabled: boolean;
		unit: LimitUnit;
		fiveHour: LimitWindow & {
			/** "block": window opens with the first message and lasts 5h (Claude style). "rolling": always the last 5h. */
			mode: "block" | "rolling";
		};
		weekly: LimitWindow & {
			/** 0 = Sunday … 6 = Saturday */
			resetDay: number;
			resetHour: number;
		};
		/** What happens at 100%: block new turns or only warn. */
		action: "block" | "warn";
		/** Warning threshold in percent. */
		warnAt: number;
		/** Providers counted; empty = all. */
		providers: string[];
		/** Count cache-read tokens toward token limits. */
		countCacheReads: boolean;
		/** Show the meters in the CLI/GUI even when limits are disabled. */
		showWhenDisabled: boolean;
	};
	permissions: {
		mode: PermissionMode;
		/** Patterns like "bash(git status*)", "read", "mcp__github__*". */
		allow: string[];
		deny: string[];
		/** Inside an environment, writing outside its folder always asks (even in Auto). */
		sandbox: boolean;
	};
	tools: {
		disabled: string[];
		bashTimeoutMs: number;
		maxOutputChars: number;
		webSearch: { provider: "duckduckgo" | "brave" | "tavily"; apiKey: string };
		checkpoints: boolean;
	};
	context: {
		/** Auto-compact when context usage exceeds this percent (0 = off). */
		autoCompactAt: number;
		instructionFiles: string[];
		readClaudeCompat: boolean;
		systemPromptAppend: string;
		/** File created by /init (and always read as project instructions). */
		initFile: string;
	};
	mcp: { servers: Record<string, McpServerConfig> };
	skills: { enabled: boolean; disabled: string[]; extraDirs: string[] };
	agents: { enabled: boolean; disabled: string[]; maxSteps: number };
	appearance: {
		/** Seed colour the whole Material 3 palette is generated from. */
		seed: string;
		preset: string;
		scheme: "tonalSpot" | "vibrant" | "expressive" | "fidelity" | "neutral" | "monochrome";
		contrast: "standard" | "medium" | "high";
		radius: "square" | "standard" | "round";
		motion: "full" | "reduced" | "off";
		/** UI size in percent. */
		scale: number;
	};
	hooks: HookConfig[];
	environments: Environment[];
	/** Letting AI agents control Argon through its MCP server (`argon mcp serve`, or HTTP on a fixed port). */
	agentControl: {
		/** Off by default: nothing can control Argon until the user turns it on. */
		enabled: boolean;
		/** Bearer token for MCP over HTTP (generated when control is turned on). */
		token: string;
		/** Fixed local port for MCP over HTTP (0 = only through `argon mcp serve`). */
		port: number;
		/** Argon's own agent gets the same tools (the built-in "Argon" connector). */
		builtin: boolean;
		/** What the tools may touch. */
		allow: { settings: boolean; agents: boolean; connectors: boolean; sessions: boolean; security: boolean };
	};
	/** Argon CLI preferences, independent from the GUI (only usage limits are shared). */
	cli: {
		showBanner: boolean;
		showThinking: boolean;
		vimMode: boolean;
		statusBar: boolean;
		accent: "violet" | "cyan" | "green" | "amber" | "rose";
		language: "it" | "en";
		/** Which sessions /resume and /sessions show: the current environment or all. */
		sessionScope: "environment" | "all";
		/** Opening animation and spinners. */
		animations: boolean;
		/** Ring the terminal bell and show a notice near/at the usage limits. */
		notifyLimits: boolean;
		/** Show timestamps next to messages. */
		timestamps: boolean;
	};
}

export const DEFAULT_SETTINGS: Settings = {
	general: {
		userName: "",
		language: "it",
		theme: "dark",
		greeting: "Here we go!",
		showStatsOnHome: true,
		autoTitle: true,
		guiPort: 4180,
		openGuiAs: "desktop",
	},
	model: {
		default: "anthropic/claude-sonnet-4-6",
		effort: "medium",
		small: "",
		temperature: null,
		maxOutputTokens: null,
	},
	providers: {
		enabled: [],
		custom: [
			{ id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [], noAuth: true },
			{ id: "lmstudio", name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", api: "openai-completions", models: [], noAuth: true },
		],
		customModels: [],
		openRouterRouting: {},
	},
	limits: {
		enabled: false,
		unit: "tokens",
		fiveHour: { enabled: true, value: 2_000_000, mode: "block" },
		weekly: { enabled: true, value: 20_000_000, resetDay: 3, resetHour: 9 },
		action: "block",
		warnAt: 80,
		providers: [],
		countCacheReads: false,
		showWhenDisabled: true,
	},
	permissions: {
		mode: "ask",
		allow: ["read", "ls", "glob", "grep", "todo", "skill", "memory", "web_search", "web_fetch", "task", "bash_output", "kill_bash"],
		deny: [],
		sandbox: true,
	},
	tools: {
		disabled: [],
		bashTimeoutMs: 120_000,
		maxOutputChars: 30_000,
		webSearch: { provider: "duckduckgo", apiKey: "" },
		checkpoints: true,
	},
	context: {
		autoCompactAt: 85,
		instructionFiles: ["ARGON.md", "AGENTS.md"],
		readClaudeCompat: true,
		initFile: "ARGON.md",
		systemPromptAppend: "",
	},
	mcp: { servers: {} },
	skills: { enabled: true, disabled: [], extraDirs: [] },
	agents: { enabled: true, disabled: [], maxSteps: 60 },
	appearance: { seed: "#7c4dff", preset: "argon", scheme: "tonalSpot", contrast: "standard", radius: "standard", motion: "full", scale: 100 },
	hooks: [],
	environments: [],
	agentControl: { enabled: false, token: "", port: 0, builtin: true, allow: { settings: true, agents: true, connectors: true, sessions: true, security: false } },
	cli: { showBanner: true, showThinking: false, vimMode: false, statusBar: true, accent: "violet", language: "it", sessionScope: "environment", animations: true, notifyLimits: true, timestamps: true },
};

function isObj(v: unknown): v is Record<string, any> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: any): T {
	if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
	const out: any = { ...base };
	for (const [k, v] of Object.entries(over)) {
		out[k] = isObj(v) && isObj((base as any)[k]) ? deepMerge((base as any)[k], v) : v;
	}
	return out;
}

let cached: Settings | undefined;
const listeners = new Set<(s: Settings) => void>();

let cachedMtime = 0;
let lastCheck = 0;

/** mtime of settings.json (0 when missing). */
function settingsMtime(): number {
	try {
		return statSync(paths.settings).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Settings are shared by the GUI and the CLI, which may run at the same time:
 * the cache is refreshed when settings.json changes on disk (checked at most every 400 ms).
 */
export function loadSettings(force = false): Settings {
	if (cached && !force) {
		const now = Date.now();
		if (now - lastCheck < 400) return cached;
		lastCheck = now;
		const m = settingsMtime();
		if (m === cachedMtime) return cached;
		const external = !!cached;
		cached = undefined;
		const s = loadSettings(true);
		if (external) for (const l of listeners) l(s);
		return s;
	}
	ensureDirs();
	cachedMtime = settingsMtime();
	lastCheck = Date.now();
	let raw: any = {};
	if (existsSync(paths.settings)) {
		try {
			raw = JSON.parse(readFileSync(paths.settings, "utf8"));
		} catch (e) {
			console.error(`[argon] settings.json is invalid, using defaults: ${(e as Error).message}`);
		}
	}
	cached = deepMerge(structuredClone(DEFAULT_SETTINGS), raw);
	return cached;
}

export function saveSettings(next: Settings): Settings {
	ensureDirs();
	cached = deepMerge(structuredClone(DEFAULT_SETTINGS), next);
	writeFileSync(paths.settings, JSON.stringify(cached, null, 2));
	cachedMtime = settingsMtime();
	for (const l of listeners) l(cached!);
	return cached!;
}

export function updateSettings(patch: any): Settings {
	return saveSettings(deepMerge(loadSettings(), patch));
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Read a dotted path, e.g. "limits.fiveHour.value". */
export function getPath(obj: any, path: string): any {
	return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Set a dotted path, coercing the string value to the type of the existing value. */
export function setPath(obj: any, path: string, value: string | unknown): void {
	const keys = path.split(".");
	let o = obj;
	for (const k of keys.slice(0, -1)) {
		if (!isObj(o[k])) o[k] = {};
		o = o[k];
	}
	const last = keys[keys.length - 1];
	const prev = o[last];
	let v: any = value;
	if (typeof value === "string") {
		if (typeof prev === "number" || prev === null) v = value === "null" ? null : Number(value);
		else if (typeof prev === "boolean") v = ["true", "1", "on", "yes", "si", "sì"].includes(value.toLowerCase());
		else if (Array.isArray(prev)) {
			try {
				v = JSON.parse(value);
			} catch {
				v = value.split(",").map((s) => s.trim()).filter(Boolean);
			}
		} else if (isObj(prev)) v = JSON.parse(value);
	}
	if (typeof v === "number" && Number.isNaN(v)) throw new Error(`"${value}" is not a number`);
	o[last] = v;
}
