import { isAbsolute, relative, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { PermissionMode, Settings } from "./config.js";

/** Tools that never change anything. */
export const READ_ONLY_TOOLS = new Set(["read", "ls", "glob", "grep", "web_fetch", "web_search", "todo", "skill", "task", "ask_user", "bash_output"]);
export const EDIT_TOOLS = new Set(["write", "edit"]);

export const MODES: { id: PermissionMode; label: string; labelIt: string; desc: string; descIt: string }[] = [
	{ id: "ask", label: "Ask", labelIt: "Chiedi", desc: "Ask before edits, commands and MCP tools", descIt: "Chiede prima di modifiche, comandi e tool MCP" },
	{ id: "acceptEdits", label: "Accept edits", labelIt: "Accetta modifiche", desc: "File edits run freely, commands still ask", descIt: "Le modifiche ai file passano, i comandi chiedono" },
	{ id: "auto", label: "Auto", labelIt: "Auto", desc: "Everything runs without asking (deny rules still apply)", descIt: "Tutto senza chiedere (le regole deny restano)" },
	{ id: "plan", label: "Plan", labelIt: "Piano", desc: "Read-only: explore and propose a plan", descIt: "Sola lettura: esplora e propone un piano" },
];

/** Turn a tool call into a matchable string, e.g. "bash(git status)". */
export function describeCall(tool: string, args: any): string {
	const arg = args?.command ?? args?.path ?? args?.url ?? args?.query ?? args?.pattern ?? "";
	return `${tool}(${String(arg).replace(/\s+/g, " ")})`;
}

function ruleMatches(rule: string, tool: string, call: string): boolean {
	const toRe = (p: string) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
	if (!rule.includes("(")) return toRe(rule).test(tool);
	return toRe(rule).test(call);
}

export type Decision = "allow" | "deny" | "ask";

export interface SandboxContext {
	/** Environment root: writes outside it always need approval (when the sandbox is on). */
	root?: string;
	cwd: string;
}

export function decide(
	mode: PermissionMode,
	s: Settings,
	tool: string,
	args: any,
	sessionAllow: string[],
	sandbox?: SandboxContext,
): { decision: Decision; reason?: string; outside?: string[] } {
	const call = describeCall(tool, args);
	const deny = s.permissions.deny.find((r) => ruleMatches(r, tool, call));
	if (deny) return { decision: "deny", reason: `Blocked by deny rule "${deny}"` };
	if (mode === "plan" && !READ_ONLY_TOOLS.has(tool) && tool !== "memory") {
		return { decision: "deny", reason: "Plan mode is read-only. Present the plan to the user instead of making changes." };
	}
	// Environment sandbox: even in Auto mode, writing outside the environment asks the user.
	if (sandbox?.root && s.permissions.sandbox !== false) {
		const outside = outsideWrites(tool, args, sandbox.root, sandbox.cwd);
		if (outside.length && !outsideAllowed(outside, sessionAllow)) return { decision: "ask", reason: "outside", outside };
	}
	if (mode === "auto") return { decision: "allow" };
	if ([...s.permissions.allow, ...sessionAllow].some((r) => ruleMatches(r, tool, call))) return { decision: "allow" };
	if (READ_ONLY_TOOLS.has(tool)) return { decision: "allow" };
	if (mode === "acceptEdits" && EDIT_TOOLS.has(tool)) return { decision: "allow" };
	return { decision: "ask" };
}

/** Suggest an "always allow" rule for a call. */
export function suggestRule(tool: string, args: any): string {
	if (tool === "bash" && typeof args?.command === "string") {
		const first = args.command.trim().split(/\s+/).slice(0, 2).join(" ");
		return `bash(${first}*)`;
	}
	return tool;
}

// ───────────────────────── environment sandbox ─────────────────────────

const WRITE_INTENT =
	/(^|[\s;&|(])(rm|rmdir|del|erase|rd|mv|move|cp|copy|xcopy|robocopy|mkdir|md|touch|tee|ln|chmod|chown|truncate|dd|install|unzip|tar|7z|git\s+(clone|init|worktree)|npm\s+(i|install|init)\b|pnpm\s+(i|install|add)|yarn\s+add|pip\s+install|curl\s+[^|]*-o|wget|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Expand-Archive|sed\s+-i)\b|>>?|\bcd\b/i;
const PATH_TOKEN = /(?:"([^"]+)"|'([^']+)'|((?:[A-Za-z]:[\\/]|~[\\/]|\/(?!dev\/null)|\.\.[\\/]|\.\.$)[^\s"'|;&<>()]*))/g;

/** True when `p` is `root` itself or inside it (subfolders included). */
export function isInside(p: string, root: string): boolean {
	const r = relative(resolve(root), resolve(p));
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function expand(p: string, cwd: string): string {
	if (p.startsWith("~")) p = homedir() + p.slice(1);
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Paths a tool call would write outside the environment root (best effort for shell commands). */
export function outsideWrites(tool: string, args: any, root: string, cwd: string): string[] {
	if (tool === "write" || tool === "edit") {
		const p = expand(String(args?.path ?? ""), cwd);
		return isInside(p, root) ? [] : [p];
	}
	if (tool === "bash" && typeof args?.command === "string") {
		const cmd = args.command;
		if (!WRITE_INTENT.test(cmd)) return [];
		const out: string[] = [];
		for (const m of cmd.matchAll(PATH_TOKEN)) {
			const raw = m[1] ?? m[2] ?? m[3];
			if (!raw || /^(https?|ssh|git):/i.test(raw)) continue;
			if (!(m[3] || /^([A-Za-z]:[\\/]|~|\/|\.\.)/.test(raw))) continue;
			const p = expand(raw, cwd);
			if (!isInside(p, root) && !out.includes(p)) out.push(p);
		}
		return out;
	}
	return [];
}

/** Session rule that allows writing inside an external folder ("outside:<dir>"). */
export function outsideRule(path: string): string {
	return `outside:${dirname(path)}`;
}

export function outsideAllowed(paths: string[], sessionAllow: string[]): boolean {
	const dirs = sessionAllow.filter((r) => r.startsWith("outside:")).map((r) => r.slice(8));
	return paths.every((p) => dirs.some((d) => isInside(p, d)));
}
