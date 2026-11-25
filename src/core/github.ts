// GitHub connection, git state and pull requests.
// Connection: a personal access token saved by Argon, or an existing GitHub CLI (gh) login.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import { promisify } from "node:util";
import { setApiKey, removeCredential, resolveApiKey, credentialSource } from "./auth.js";
import type { PrStatus } from "./sessions.js";

const run = promisify(execFile);

export interface GitHubStatus {
	connected: boolean;
	method: "token" | "gh" | null;
	login?: string;
	name?: string;
	avatar?: string;
	ghInstalled: boolean;
	error?: string;
}

let cached: { at: number; status: GitHubStatus } | undefined;

async function ghInstalled(): Promise<boolean> {
	try {
		await run("gh", ["--version"], { windowsHide: true, timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/** Environment for git/gh child processes: the saved token (if any) is passed as GH_TOKEN. */
export async function ghEnv(): Promise<NodeJS.ProcessEnv> {
	const token = credentialSource("github") === "api" ? await resolveApiKey("github") : undefined;
	return token ? { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } : { ...process.env };
}

async function apiUser(token: string): Promise<{ login: string; name?: string; avatar_url?: string }> {
	const res = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "argon-agent" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(res.status === 401 ? "Invalid or expired token" : `GitHub API ${res.status}`);
	return (await res.json()) as any;
}

export async function githubStatus(force = false): Promise<GitHubStatus> {
	if (!force && cached && Date.now() - cached.at < 60_000) return cached.status;
	const installed = await ghInstalled();
	let status: GitHubStatus = { connected: false, method: null, ghInstalled: installed };
	if (credentialSource("github") === "api") {
		try {
			const u = await apiUser((await resolveApiKey("github"))!);
			status = { connected: true, method: "token", login: u.login, name: u.name, avatar: u.avatar_url, ghInstalled: installed };
		} catch (e) {
			status = { connected: false, method: "token", ghInstalled: installed, error: (e as Error).message };
		}
	} else if (installed) {
		try {
			const { stdout } = await run("gh", ["api", "user"], { windowsHide: true, timeout: 10_000 });
			const u = JSON.parse(stdout);
			status = { connected: true, method: "gh", login: u.login, name: u.name, avatar: u.avatar_url, ghInstalled: true };
		} catch {
			/* gh present but not logged in */
		}
	}
	cached = { at: Date.now(), status };
	return status;
}

export async function connectGithubToken(token: string): Promise<GitHubStatus> {
	await apiUser(token.trim());
	setApiKey("github", token.trim(), "GitHub");
	return githubStatus(true);
}

export async function disconnectGithub(): Promise<GitHubStatus> {
	removeCredential("github");
	return githubStatus(true);
}

export async function requireGithub(): Promise<GitHubStatus> {
	const s = await githubStatus();
	if (!s.connected) throw new Error("GitHub is not connected. Connect it in Settings → GitHub (or `argon github token <PAT>`).");
	return s;
}


// ───────────────────────── git ─────────────────────────

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await run("git", args, { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 20 * 1024 * 1024, env });
	return stdout.trim();
}

export interface GitState {
	isRepo: boolean;
	root?: string;
	branch?: string;
	defaultBranch?: string;
	remote?: string;
	isGithub: boolean;
	ahead: number;
	files: { path: string; status: string }[];
	added: number;
	removed: number;
	hasCommits: boolean;
}

export async function gitState(cwd: string): Promise<GitState> {
	const empty: GitState = { isRepo: false, isGithub: false, ahead: 0, files: [], added: 0, removed: 0, hasCommits: false };
	if (!existsSync(cwd)) return empty;
	let root: string;
	try {
		root = await git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return empty;
	}
	const branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => "");
	const hasCommits = await git(cwd, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
	const remote = await git(cwd, ["remote", "get-url", "origin"]).catch(() => "");
	let defaultBranch = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then((r) => r.replace(/^origin\//, ""), () => "");
	if (!defaultBranch) defaultBranch = /^(main|master)$/.test(branch) ? branch : "main";
	const porcelain = await git(cwd, ["status", "--porcelain"]).catch(() => "");
	const files = porcelain
		.split("\n")
		.filter(Boolean)
		.map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));
	let added = 0;
	let removed = 0;
	if (hasCommits) {
		const stat = await git(cwd, ["diff", "HEAD", "--numstat"]).catch(() => "");
		for (const l of stat.split("\n")) {
			const [a, r] = l.split("\t");
			added += Number(a) || 0;
			removed += Number(r) || 0;
		}
	}
	let ahead = 0;
	if (hasCommits && remote && branch) ahead = Number(await git(cwd, ["rev-list", "--count", `origin/${branch}..HEAD`]).catch(() => "0")) || 0;
	return { isRepo: true, root, branch, defaultBranch, remote, isGithub: /github\.com[:/]/i.test(remote), ahead, files, added, removed, hasCommits };
}

/** Recent commits since a date (for session imports). */
export async function commitsSince(cwd: string, since: number, max = 20) {
	const out = await git(cwd, ["log", `--since=${new Date(since).toISOString()}`, `-n${max}`, "--pretty=format:%h%x09%s%x09%cI"]).catch(() => "");
	return out
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [hash, subject, date] = l.split("\t");
			return { hash, subject, date };
		});
}

/** Pull requests created since a date in the repository of cwd (needs GitHub). */
export async function prsSince(cwd: string, since: number) {
	try {
		const day = new Date(since).toISOString().slice(0, 10);
		const { stdout } = await run("gh", ["pr", "list", "--state", "all", "--limit", "20", "--search", `created:>=${day}`, "--json", "number,title,url,state"], {
			cwd,
			windowsHide: true,
			timeout: 20_000,
			env: await ghEnv(),
		});
		return JSON.parse(stdout) as { number: number; title: string; url: string; state: string }[];
	} catch {
		return [];
	}
}

/** Summarise a PR's checks: failing if any failed, pending while any runs, null when there are none. */
function checksRollup(list: any[] | undefined): "pass" | "fail" | "pending" | null {
	if (!list?.length) return null;
	let pending = false;
	for (const c of list) {
		const v = String(c.conclusion || c.state || "").toUpperCase();
		if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) return "fail";
		if ((c.status && c.status !== "COMPLETED") || v === "PENDING" || v === "EXPECTED" || !v) pending = true;
	}
	return pending ? "pending" : "pass";
}

/**
 * Current state of some pull requests (title, open/merged/closed, draft, +/−, checks), read with gh.
 * PRs that can't be read are left out. `ref` is the PR URL (works across repositories) or its number.
 */
export async function prDetails(cwd: string, refs: (string | number)[]): Promise<PrStatus[]> {
	if (!refs.length) return [];
	const env = await ghEnv();
	const one = async (ref: string | number): Promise<PrStatus | null> => {
		try {
			const { stdout } = await run("gh", ["pr", "view", String(ref), "--json", "number,title,url,state,isDraft,additions,deletions,statusCheckRollup"], {
				cwd: existsSync(cwd) ? cwd : undefined,
				windowsHide: true,
				timeout: 20_000,
				env,
			});
			const d = JSON.parse(stdout);
			return { number: d.number, title: d.title, url: d.url, state: d.state, draft: !!d.isDraft, additions: d.additions, deletions: d.deletions, checks: checksRollup(d.statusCheckRollup), checkedAt: Date.now() };
		} catch {
			return null;
		}
	};
	const out: PrStatus[] = [];
	for (let i = 0; i < refs.length; i += 6) out.push(...((await Promise.all(refs.slice(i, i + 6).map(one))).filter(Boolean) as PrStatus[]));
	return out;
}

/** A pull request URL printed by `gh pr create` (or anything else), with its number. */
export function findPrUrl(text: string): { url: string; number: number } | null {
	const m = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/);
	return m ? { url: m[0], number: Number(m[1]) } : null;
}

export interface PrOptions {
	title: string;
	body: string;
	base?: string;
	draft?: boolean;
	/** Commit message for uncommitted changes (they are committed first). */
	commitMessage?: string;
	/** Branch to create when currently on the base branch. */
	branch?: string;
}

const slug = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "changes";

/** Commit pending changes, push a branch and open a pull request with gh. */
export async function createPullRequest(cwd: string, o: PrOptions): Promise<{ url: string; number: number; branch: string }> {
	await requireGithub();
	const st = await gitState(cwd);
	if (!st.isRepo) throw new Error("This folder is not a git repository.");
	if (!st.remote) throw new Error("The repository has no 'origin' remote.");
	if (!st.isGithub) throw new Error("The 'origin' remote is not on GitHub.");
	if (!st.files.length && !st.ahead && st.branch !== st.defaultBranch) {
		/* branch already pushed with commits: still allow PR */
	} else if (!st.files.length && !st.ahead) throw new Error("There are no changes to put in a pull request.");
	const env = await ghEnv();
	const base = o.base || st.defaultBranch || "main";
	let branch = st.branch || "";
	if (!branch || branch === base) {
		branch = o.branch || `argon/${slug(o.title)}-${Date.now().toString(36).slice(-4)}`;
		await git(cwd, ["switch", "-c", branch]);
	}
	if (st.files.length) {
		await git(cwd, ["add", "-A"]);
		await git(cwd, ["commit", "-m", o.commitMessage || o.title], env);
	}
	await git(cwd, ["push", "-u", "origin", branch], env);
	const args = ["pr", "create", "--title", o.title, "--body", o.body || " ", "--base", base, "--head", branch];
	if (o.draft) args.push("--draft");
	const { stdout } = await run("gh", args, { cwd, windowsHide: true, timeout: 60_000, env });
	const url = stdout.trim().split("\n").pop()!.trim();
	const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
	return { url, number, branch };
}

