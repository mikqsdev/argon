import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** Root folder for all Argon data. Override with ARGON_HOME. */
export const ARGON_HOME = process.env.ARGON_HOME || join(homedir(), ".argon");

export const paths = {
	home: ARGON_HOME,
	settings: join(ARGON_HOME, "settings.json"),
	auth: join(ARGON_HOME, "auth.json"),
	usage: join(ARGON_HOME, "usage.jsonl"),
	sessions: join(ARGON_HOME, "sessions"),
	skills: join(ARGON_HOME, "skills"),
	commands: join(ARGON_HOME, "commands"),
	memory: join(ARGON_HOME, "memory"),
	checkpoints: join(ARGON_HOME, "checkpoints"),
	history: join(ARGON_HOME, "history.txt"),
	globalInstructions: join(ARGON_HOME, "ARGON.md"),
};

export function ensureDirs(): void {
	for (const dir of [paths.home, paths.sessions, paths.skills, paths.commands, paths.memory, paths.checkpoints]) {
		mkdirSync(dir, { recursive: true });
	}
}

/** Project-local folder (inside the working directory). */
export function projectDir(cwd: string): string {
	return join(cwd, ".argon");
}
