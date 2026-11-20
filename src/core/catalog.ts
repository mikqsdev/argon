// Live model catalogs: ask each provider which models exist right now,
// then merge with pi-ai's built-in metadata (pricing, API, context) where known.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, type Api, type Model } from "@mariozechner/pi-ai";
import { paths, ensureDirs } from "./paths.js";
import { resolveApiKey } from "./auth.js";
import { findEfforts } from "./effort.js";

export interface LiveModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** USD per 1M tokens */
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	reasoning?: boolean;
	image?: boolean;
	/** Unix ms */
	created?: number;
	/** Reasoning profile reported by the provider for this model. */
	efforts?: string[];
	defaultEffort?: string;
	reasoningMandatory?: boolean;
}

interface CacheEntry {
	/** Cache format version; older entries are refetched. */
	v?: number;
	fetchedAt: number;
	models: LiveModel[];
	error?: string;
}

const TTL = 6 * 3_600_000;
/** Bump when LiveModel gains fields, so stale caches are refreshed. */
const CACHE_VERSION = 2;
const file = () => join(paths.home, "models-cache.json");
let cache: Record<string, CacheEntry> | undefined;

function load(): Record<string, CacheEntry> {
	if (cache) return cache;
	ensureDirs();
	try {
		cache = existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
	} catch {
		cache = {};
	}
	return cache!;
}

function save(): void {
	writeFileSync(file(), JSON.stringify(load()));
}

export function cachedLive(provider: string): CacheEntry | undefined {
	return load()[provider];
}

/** Providers whose catalog can't be listed via API (we keep pi-ai's list). */
const STATIC = new Set(["openai-codex", "github-copilot", "amazon-bedrock", "google-vertex", "azure-openai-responses", "cloudflare-ai-gateway", "cloudflare-workers-ai"]);

const NOT_CHAT = /embed|tts|whisper|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search-preview|computer-use|sora|rerank|guard|-ocr|text-to/i;

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
	const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`), { status: res.status });
	return res.json();
}

const perM = (v: unknown) => (v == null || v === "" ? undefined : Number(v) * 1_000_000);
const ts = (v: unknown) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) || undefined : undefined);

async function fetchLive(provider: string, baseUrl: string | undefined): Promise<LiveModel[]> {
	if (provider === "openrouter") {
		const j = await getJson("https://openrouter.ai/api/v1/models", {});
		return (j.data ?? []).map((m: any) => ({
			id: m.id,
			name: m.name,
			contextWindow: m.context_length ?? m.top_provider?.context_length,
			maxTokens: m.top_provider?.max_completion_tokens ?? undefined,
			cost: m.pricing
				? { input: perM(m.pricing.prompt) ?? 0, output: perM(m.pricing.completion) ?? 0, cacheRead: perM(m.pricing.input_cache_read), cacheWrite: perM(m.pricing.input_cache_write) }
				: undefined,
			reasoning: (m.supported_parameters ?? []).includes("reasoning"),
			image: (m.architecture?.input_modalities ?? []).includes("image"),
			created: ts(m.created),
			efforts: m.reasoning?.supported_efforts ?? findEfforts(m.reasoning),
			defaultEffort: m.reasoning?.default_effort,
			reasoningMandatory: m.reasoning?.mandatory,
		}));
	}
	const key = await resolveApiKey(provider);
	if (provider === "anthropic") {
		if (!key) throw new Error("no credentials");
		const oauth = key.includes("sk-ant-oat");
		const j = await getJson("https://api.anthropic.com/v1/models?limit=1000", {
			"anthropic-version": "2023-06-01",
			...(oauth ? { Authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20" } : { "x-api-key": key }),
		});
		return (j.data ?? []).map((m: any) => ({
			id: m.id,
			name: m.display_name,
			contextWindow: m.max_input_tokens ?? undefined,
			maxTokens: m.max_tokens ?? undefined,
			created: ts(m.created_at),
			efforts: findEfforts(m),
			defaultEffort: m.default_effort ?? m.capabilities?.effort?.default,
		}));
	}
	if (provider === "google") {
		if (!key) throw new Error("no credentials");
		const j = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": key });
		return (j.models ?? [])
			.filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent") && !NOT_CHAT.test(m.name))
			.map((m: any) => ({
				id: String(m.name).replace(/^models\//, ""),
				name: m.displayName,
				contextWindow: m.inputTokenLimit,
				maxTokens: m.outputTokenLimit,
				reasoning: m.thinking === true || undefined,
			}));
	}
	// OpenAI-compatible: OpenAI, xAI, Groq, Mistral, DeepSeek, Cerebras, Fireworks, local servers…
	if (!baseUrl) throw new Error("no endpoint");
	const headers: Record<string, string> = key && key !== "local" ? { Authorization: `Bearer ${key}` } : {};
	const base = baseUrl.replace(/\/$/, "");
	let j: any;
	try {
		j = await getJson(`${base}/models`, headers);
	} catch (e: any) {
		if (e.status !== 404 || /\/v\d+$/.test(base)) throw e;
		j = await getJson(`${base}/v1/models`, headers);
	}
	const list: any[] = j.data ?? j.models ?? [];
	return list
		.filter((m) => !NOT_CHAT.test(m.id ?? m.name ?? "") && m.capabilities?.completion_chat !== false && m.active !== false)
		.map((m) => ({
			id: m.id ?? m.name,
			name: m.name && m.name !== m.id ? m.name : undefined,
			contextWindow: m.context_window ?? m.context_length ?? m.max_context_length ?? m.max_model_len ?? undefined,
			maxTokens: m.max_completion_tokens ?? m.max_output_tokens ?? undefined,
			created: ts(m.created),
			efforts: findEfforts(m),
		}));
}

/** Refresh one provider's live list (cached for 6h unless force). Never throws. */
export async function refreshProviderModels(provider: string, baseUrl: string | undefined, force = false): Promise<CacheEntry | undefined> {
	if (STATIC.has(provider)) return undefined;
	const c = load();
	const hit = c[provider];
	if (!force && hit && hit.v === CACHE_VERSION && Date.now() - hit.fetchedAt < TTL && !hit.error) return hit;
	try {
		const models = (await fetchLive(provider, baseUrl)).filter((m) => m.id);
		c[provider] = { v: CACHE_VERSION, fetchedAt: Date.now(), models };
	} catch (e) {
		c[provider] = { fetchedAt: Date.now(), models: hit?.models ?? [], error: (e as Error).message };
	}
	save();
	return c[provider];
}

function commonPrefix(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}

/** Closest known model (same family) to inherit api, pricing and capabilities from. */
function template(id: string, known: Model<Api>[]): Model<Api> | undefined {
	let best: Model<Api> | undefined;
	let score = -1;
	for (const m of known) {
		const s = commonPrefix(id.toLowerCase(), m.id.toLowerCase());
		// Prefer newer siblings on ties (catalog lists are ascending).
		if (s >= score) {
			score = s;
			best = m;
		}
	}
	return best;
}

/**
 * Merge a provider's live list with pi-ai's built-in catalog.
 * When the provider answered, its list is authoritative (deprecated models disappear, new ones appear).
 */
export function mergeLive(provider: string, known: Model<Api>[], live: LiveModel[] | undefined): Model<Api>[] {
	if (!live?.length) return [...known].sort(byNewest);
	const byId = new Map(known.map((m) => [m.id, m]));
	const out: Model<Api>[] = live.map((l) => {
		const k = byId.get(l.id);
		const base = k ?? template(l.id, known) ?? known[0];
		const m: Model<Api> & { created?: number; live?: boolean; estimated?: boolean } = {
			...(base as Model<Api>),
			id: l.id,
			name: k?.name ?? l.name ?? prettify(l.id),
			provider,
			contextWindow: l.contextWindow ?? base?.contextWindow ?? 128_000,
			maxTokens: Math.min(l.maxTokens ?? base?.maxTokens ?? 8192, l.contextWindow ?? Infinity),
			reasoning: l.reasoning ?? base?.reasoning ?? false,
			input: l.image === undefined ? (base?.input ?? ["text"]) : l.image ? ["text", "image"] : ["text"],
			cost: l.cost
				? { input: l.cost.input, output: l.cost.output, cacheRead: l.cost.cacheRead ?? 0, cacheWrite: l.cost.cacheWrite ?? 0 }
				: (k?.cost ?? base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		};
		m.created = l.created;
		m.live = true;
		if (l.efforts?.length) {
			const r = m as any;
			r.efforts = l.efforts;
			r.defaultEffort = l.defaultEffort;
			r.reasoningMandatory = l.reasoningMandatory;
			m.reasoning = true;
		}
		m.estimated = !k && !l.cost;
		return m;
	});
	return out.sort(byNewest);
}

function byNewest(a: any, b: any): number {
	if (a.created && b.created) return b.created - a.created;
	if (a.created || b.created) return a.created ? -1 : 1;
	return b.id.localeCompare(a.id, undefined, { numeric: true });
}

function prettify(id: string): string {
	return id
		.split("/")
		.pop()!
		.replace(/[-_]/g, " ")
		.replace(/\b(\w)/g, (c) => c.toUpperCase())
		.replace(/\bGpt\b/g, "GPT");
}

/** Base URL to list models from, taken from the catalog. */
export function catalogBaseUrl(provider: string): string | undefined {
	try {
		return (getModels(provider as any) as Model<Api>[])[0]?.baseUrl;
	} catch {
		return undefined;
	}
}
