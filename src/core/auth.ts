import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import { getOAuthProvider, getOAuthProviders, type OAuthCredentials, type OAuthLoginCallbacks } from "@mariozechner/pi-ai/oauth";
import { paths, ensureDirs } from "./paths.js";

export type Credential =
	| { type: "api"; key: string; label?: string; addedAt: number }
	| ({ type: "oauth"; label?: string; addedAt: number } & OAuthCredentials);

type AuthFile = Record<string, Credential>;

function read(): AuthFile {
	ensureDirs();
	if (!existsSync(paths.auth)) return {};
	try {
		return JSON.parse(readFileSync(paths.auth, "utf8"));
	} catch {
		return {};
	}
}

function write(data: AuthFile): void {
	ensureDirs();
	writeFileSync(paths.auth, JSON.stringify(data, null, 2));
	try {
		chmodSync(paths.auth, 0o600);
	} catch {
		/* windows */
	}
}

export function listCredentials(): Record<string, { type: "api" | "oauth"; label?: string; addedAt: number; hint: string }> {
	const out: Record<string, any> = {};
	for (const [provider, c] of Object.entries(read())) {
		out[provider] = {
			type: c.type,
			label: c.label,
			addedAt: c.addedAt,
			hint: c.type === "api" ? mask(c.key) : "OAuth account",
		};
	}
	return out;
}

function mask(key: string): string {
	if (key.length <= 10) return "••••";
	return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function setApiKey(provider: string, key: string, label?: string): void {
	const data = read();
	data[provider] = { type: "api", key: key.trim(), label, addedAt: Date.now() };
	write(data);
}

export function removeCredential(provider: string): void {
	const data = read();
	delete data[provider];
	write(data);
}

export function hasCredential(provider: string): boolean {
	return !!read()[provider] || !!getEnvApiKey(provider);
}

export function credentialSource(provider: string): "api" | "oauth" | "env" | null {
	const c = read()[provider];
	if (c) return c.type;
	return getEnvApiKey(provider) ? "env" : null;
}

export function getOAuthCredentials(provider: string): OAuthCredentials | undefined {
	const c = read()[provider];
	return c?.type === "oauth" ? c : undefined;
}

/** OAuth-capable providers known to pi-ai (anthropic, openai-codex, github-copilot, …). */
export function oauthProviders(): { id: string; name: string }[] {
	return getOAuthProviders().map((p) => ({ id: p.id, name: p.name }));
}

export async function loginOAuth(provider: string, callbacks: OAuthLoginCallbacks): Promise<void> {
	const impl = getOAuthProvider(provider);
	if (!impl) throw new Error(`Provider "${provider}" does not support OAuth login`);
	const creds = await impl.login(callbacks);
	const data = read();
	data[provider] = { ...creds, type: "oauth", addedAt: Date.now() } as Credential;
	write(data);
}

const refreshLocks = new Map<string, Promise<string | undefined>>();

/** Resolve the key used for API calls: stored API key → OAuth token (refreshed) → environment. */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const c = read()[provider];
	if (c?.type === "api") return c.key;
	if (c?.type === "oauth") {
		const pending = refreshLocks.get(provider);
		if (pending) return pending;
		const job = (async () => {
			const impl = getOAuthProvider(provider);
			if (!impl) return undefined;
			let creds: OAuthCredentials = c;
			if (Date.now() >= creds.expires - 60_000) {
				creds = await impl.refreshToken(creds);
				const data = read();
				data[provider] = { ...creds, type: "oauth", label: c.label, addedAt: c.addedAt } as Credential;
				write(data);
			}
			return impl.getApiKey(creds);
		})().finally(() => refreshLocks.delete(provider));
		refreshLocks.set(provider, job);
		return job;
	}
	return getEnvApiKey(provider);
}
