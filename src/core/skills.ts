import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { paths, projectDir } from "./paths.js";
import type { Settings } from "./config.js";

export function parseFrontmatter(src: string): { attrs: Record<string, string>; body: string } {
	const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { attrs: {}, body: src };
	const attrs: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (kv) attrs[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
	}
	return { attrs, body: src.slice(m[0].length) };
}

export interface Skill {
	name: string;
	description: string;
	dir: string;
	file: string;
	source: "user" | "project" | "claude" | "extra";
	body: string;
	enabled: boolean;
}

function skillDirs(cwd: string, s: Settings): { dir: string; source: Skill["source"] }[] {
	const dirs: { dir: string; source: Skill["source"] }[] = [
		{ dir: join(projectDir(cwd), "skills"), source: "project" },
		{ dir: paths.skills, source: "user" },
		...s.skills.extraDirs.map((d) => ({ dir: d, source: "extra" as const })),
	];
	if (s.context.readClaudeCompat) {
		dirs.push({ dir: join(cwd, ".claude", "skills"), source: "claude" }, { dir: join(homedir(), ".claude", "skills"), source: "claude" });
	}
	return dirs;
}

export function listSkills(cwd: string, s: Settings, includeDisabled = false): Skill[] {
	if (!s.skills.enabled && !includeDisabled) return [];
	const seen = new Set<string>();
	const out: Skill[] = [];
	for (const { dir, source } of skillDirs(cwd, s)) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir)) {
			const sdir = join(dir, entry);
			const file = join(sdir, "SKILL.md");
			try {
				if (!statSync(sdir).isDirectory() || !existsSync(file)) continue;
			} catch {
				continue;
			}
			const { attrs, body } = parseFrontmatter(readFileSync(file, "utf8"));
			const name = attrs.name || entry;
			if (seen.has(name)) continue;
			seen.add(name);
			const enabled = !s.skills.disabled.includes(name);
			if (!enabled && !includeDisabled) continue;
			out.push({ name, description: attrs.description || body.split("\n").find((l) => l.trim())?.slice(0, 200) || "", dir: sdir, file, source, body, enabled });
		}
	}
	return out;
}

export function findSkill(name: string, cwd: string, s: Settings): Skill | undefined {
	const n = name.replace(/^\//, "").toLowerCase();
	return listSkills(cwd, s).find((k) => k.name.toLowerCase() === n);
}

// ───────────────────────── custom slash commands ─────────────────────────

export interface SlashCommand {
	name: string;
	description: string;
	body: string;
	file: string;
	source: "user" | "project" | "claude";
}

export function listCommands(cwd: string, s: Settings): SlashCommand[] {
	const dirs: { dir: string; source: SlashCommand["source"] }[] = [
		{ dir: join(projectDir(cwd), "commands"), source: "project" },
		{ dir: paths.commands, source: "user" },
	];
	if (s.context.readClaudeCompat) dirs.push({ dir: join(cwd, ".claude", "commands"), source: "claude" }, { dir: join(homedir(), ".claude", "commands"), source: "claude" });
	const out: SlashCommand[] = [];
	const seen = new Set<string>();
	for (const { dir, source } of dirs) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".md")) continue;
			const name = basename(f, ".md");
			if (seen.has(name)) continue;
			seen.add(name);
			const file = join(dir, f);
			const { attrs, body } = parseFrontmatter(readFileSync(file, "utf8"));
			out.push({ name, description: attrs.description || body.trim().split("\n")[0].slice(0, 100), body, file, source });
		}
	}
	return out;
}

export function expandCommand(cmd: SlashCommand, args: string): string {
	const parts = args.split(/\s+/).filter(Boolean);
	return cmd.body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (_m, i) => parts[Number(i) - 1] ?? "");
}
