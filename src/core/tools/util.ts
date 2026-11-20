import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, sep } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Settings } from "../config.js";
import type { TodoItem } from "../sessions.js";

export interface ToolContext {
	cwd: string;
	settings: () => Settings;
	sessionId: string;
	/** Save the original content of a file before it is modified (for /undo). */
	checkpoint: (absPath: string) => void;
	setTodos: (todos: TodoItem[]) => void;
	/** Ask the user a question (GUI card / CLI prompt). */
	askUser?: (question: string, options: string[]) => Promise<string>;
	/** Run a sub-agent and return its final answer. */
	runSubagent?: (prompt: string, opts: { agent?: string; readOnly?: boolean; signal?: AbortSignal; toolCallId: string }) => Promise<string>;
	/** Sub-agents the main agent can delegate to (name + description). */
	agents?: () => { name: string; description: string }[];
	/** Background processes of the session. */
	background?: import("../background.js").BackgroundManager;
}

export const IGNORED_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "__pycache__", ".venv", "venv", ".next", ".cache", ".gradle", ".idea", "build", "dist", "target", "out", ".turbo"]);

export function resolvePath(cwd: string, p: string): string {
	if (!p) return cwd;
	if (p.startsWith("~")) p = join(process.env.USERPROFILE || process.env.HOME || "", p.slice(1));
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export function rel(cwd: string, p: string): string {
	const r = relative(cwd, p);
	return r && !r.startsWith("..") ? r.split(sep).join("/") : p;
}

export function text(t: string, details: any = {}): AgentToolResult<any> {
	return { content: [{ type: "text", text: t }], details };
}

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	return `${s.slice(0, head)}\n\n… [${s.length - max} characters truncated] …\n\n${s.slice(-tail)}`;
}

/** Recursively walk files, skipping heavy folders. */
export async function* walk(dir: string, maxFiles = 50_000): AsyncGenerator<string> {
	let count = 0;
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop()!;
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) {
				if (!IGNORED_DIRS.has(e.name)) stack.push(full);
			} else if (e.isFile()) {
				if (++count > maxFiles) return;
				yield full;
			}
		}
	}
}

export async function isDir(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

let rgPath: string | null | undefined;
export function ripgrep(): string | null {
	if (rgPath !== undefined) return rgPath;
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		rgPath = execFileSync(cmd, ["rg"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).split(/\r?\n/)[0].trim() || null;
	} catch {
		rgPath = null;
	}
	return rgPath;
}

let shellCache: { file: string; args: (c: string) => string[]; name: string } | undefined;
/** Pick a shell: Git Bash on Windows when available, otherwise PowerShell; bash elsewhere. */
export function shell(): { file: string; args: (c: string) => string[]; name: string } {
	if (shellCache) return shellCache;
	if (process.platform !== "win32") {
		shellCache = { file: process.env.SHELL || "/bin/bash", args: (c) => ["-lc", c], name: "bash" };
		return shellCache;
	}
	const candidates = [
		process.env.ARGON_BASH,
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		join(process.env.LOCALAPPDATA || "", "Programs\\Git\\bin\\bash.exe"),
	].filter(Boolean) as string[];
	const bash = candidates.find((c) => existsSync(c));
	shellCache = bash
		? { file: bash, args: (c) => ["-c", c], name: "bash (Git Bash)" }
		: { file: "powershell.exe", args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c], name: "PowerShell" };
	return shellCache;
}

/** Simple glob → RegExp ("**", "*", "?", "{a,b}"). */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
				i += glob[i + 2] === "/" ? 2 : 1;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (c === "{") {
			const end = glob.indexOf("}", i);
			re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
			i = end;
		} else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}
