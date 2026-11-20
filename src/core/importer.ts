// Bring sessions started in Argon CLI into the GUI, with their git context.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { listSessions, loadSession, saveSession, addEnvironment, environmentForCwd, type SessionMeta } from "./sessions.js";
import { gitInfo } from "./prompt.js";
import { commitsSince, prsSince, githubStatus, gitState } from "./github.js";

/** CLI sessions not yet imported into the GUI. */
export function pendingCliSessions(): SessionMeta[] {
	return listSessions({ includeArchived: false }).filter((m) => m.origin === "cli" && !m.imported);
}

export interface ImportResult {
	imported: number;
	environmentsCreated: string[];
	sessions: { id: string; title: string; cwd: string; envName: string | null; commits: number; prs: number }[];
}

/**
 * Import CLI sessions: everything is kept (messages, last model, mode, effort, todos, summary)
 * and the session is linked to the environment of its folder (created if missing). The git
 * context is captured too: repository, branch, changes, commits and pull requests since the
 * session started.
 */
export async function importCliSessions(ids?: string[]): Promise<ImportResult> {
	const pending = pendingCliSessions().filter((m) => !ids || ids.includes(m.id));
	const gh = await githubStatus().catch(() => ({ connected: false }));
	const res: ImportResult = { imported: 0, environmentsCreated: [], sessions: [] };
	for (const meta of pending) {
		const data = loadSession(meta.id);
		if (!data) continue;
		let envName: string | null = null;
		if (existsSync(meta.cwd)) {
			let env = environmentForCwd(meta.cwd);
			if (!env) {
				env = addEnvironment(basename(meta.cwd) || meta.cwd, meta.cwd);
				res.environmentsCreated.push(env.name);
			}
			data.meta.envId = env.id;
			envName = env.name;
			const g = gitInfo(meta.cwd);
			if (g.root) {
				const st = await gitState(meta.cwd).catch(() => undefined);
				data.meta.git = {
					repo: st?.remote || undefined,
					branch: g.branch ?? undefined,
					changes: g.changes ?? undefined,
					commits: await commitsSince(meta.cwd, meta.createdAt),
					prs: gh.connected ? await prsSince(meta.cwd, meta.createdAt) : [],
					capturedAt: Date.now(),
				};
			}
		}
		data.meta.imported = true;
		saveSession(data);
		res.imported++;
		res.sessions.push({
			id: meta.id,
			title: meta.title,
			cwd: meta.cwd,
			envName,
			commits: data.meta.git?.commits?.length ?? 0,
			prs: data.meta.git?.prs?.length ?? 0,
		});
	}
	return res;
}
