import { getModels, getProviders, findEnvKeys, type Api, type Model } from "@mariozechner/pi-ai";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { loadSettings, type CustomProvider } from "./config.js";
import { cachedLive, mergeLive, refreshProviderModels, catalogBaseUrl } from "./catalog.js";
import { credentialSource, getOAuthCredentials, oauthProviders } from "./auth.js";

/** Friendly names and how each provider can be connected. */
const META: Record<string, { name: string; group?: string; hint?: string }> = {
	anthropic: { name: "Claude (Anthropic)", group: "Claude", hint: "API key, or sign in with Claude Pro/Max" },
	openai: { name: "OpenAI (API)", group: "OpenAI", hint: "API key from platform.openai.com" },
	"openai-codex": { name: "OpenAI (ChatGPT Plus/Pro)", group: "OpenAI", hint: "Sign in with your ChatGPT account" },
	openrouter: { name: "OpenRouter", hint: "One key, hundreds of models" },
	google: { name: "Google Gemini", hint: "API key from AI Studio" },
	"google-vertex": { name: "Google Vertex AI" },
	"github-copilot": { name: "GitHub Copilot", hint: "Sign in with GitHub" },
	xai: { name: "xAI Grok" },
	groq: { name: "Groq" },
	cerebras: { name: "Cerebras" },
	mistral: { name: "Mistral" },
	deepseek: { name: "DeepSeek" },
	"amazon-bedrock": { name: "Amazon Bedrock", hint: "Uses your AWS credentials" },
	"azure-openai-responses": { name: "Azure OpenAI" },
	"vercel-ai-gateway": { name: "Vercel AI Gateway" },
	"cloudflare-ai-gateway": { name: "Cloudflare AI Gateway" },
	"cloudflare-workers-ai": { name: "Cloudflare Workers AI" },
	fireworks: { name: "Fireworks" },
	huggingface: { name: "Hugging Face" },
	moonshotai: { name: "Moonshot (Kimi)" },
	"kimi-coding": { name: "Kimi Coding" },
	zai: { name: "Z.ai (GLM)" },
	minimax: { name: "MiniMax" },
	opencode: { name: "OpenCode Zen" },
	"opencode-go": { name: "OpenCode Go" },
	xiaomi: { name: "Xiaomi MiMo" },
};

/** Providers listed first in the UI. */
const FEATURED = ["anthropic", "openai", "openai-codex", "openrouter", "google", "github-copilot", "xai", "groq", "mistral", "deepseek", "ollama", "lmstudio"];

export interface ProviderInfo {
	id: string;
	name: string;
	hint?: string;
	group?: string;
	oauth: boolean;
	apiKey: boolean;
	custom: boolean;
	envKeys: string[];
	connected: "api" | "oauth" | "env" | "local" | null;
	modelCount: number;
	baseUrl?: string;
}

export function listProviders(): ProviderInfo[] {
	const s = loadSettings();
	const oauthIds = new Set(oauthProviders().map((p) => p.id));
	const out: ProviderInfo[] = [];
	for (const id of getProviders() as string[]) {
		const meta = META[id] ?? { name: id };
		out.push({
			id,
			name: meta.name,
			hint: meta.hint,
			group: meta.group,
			oauth: oauthIds.has(id),
			apiKey: id !== "openai-codex" && id !== "github-copilot",
			custom: false,
			envKeys: findEnvKeys(id) ?? [],
			connected: credentialSource(id),
			modelCount: (cachedLive(id)?.models.length || getModels(id as any).length) + s.providers.customModels.filter((m) => m.provider === id).length,
		});
	}
	for (const cp of s.providers.custom) {
		out.push({
			id: cp.id,
			name: cp.name,
			hint: cp.baseUrl,
			oauth: false,
			apiKey: !cp.noAuth,
			custom: true,
			envKeys: [],
			connected: cp.noAuth ? (cp.models.length ? "local" : null) : credentialSource(cp.id),
			modelCount: cp.models.length,
			baseUrl: cp.baseUrl,
		});
	}
	const rank = (id: string) => (FEATURED.includes(id) ? FEATURED.indexOf(id) : 100);
	return out.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

function customProviderModels(cp: CustomProvider): Model<Api>[] {
	const live = cachedLive(cp.id)?.models.map((m) => m.id) ?? [];
	return [...new Set([...cp.models, ...live])].map((id) => ({
		id,
		name: id,
		api: (cp.api ?? "openai-completions") as Api,
		provider: cp.id,
		baseUrl: cp.baseUrl,
		reasoning: cp.reasoning ?? false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: cp.contextWindow ?? 128_000,
		maxTokens: cp.maxTokens ?? 8192,
	}));
}

/** All models of a provider, including user-defined models and OAuth adjustments. */
export function modelsFor(provider: string): Model<Api>[] {
	const s = loadSettings();
	const cp = s.providers.custom.find((p) => p.id === provider);
	if (cp) return customProviderModels(cp);
	let models = mergeLive(provider, getModels(provider as any) as Model<Api>[], cachedLive(provider)?.models);
	for (const cm of s.providers.customModels.filter((m) => m.provider === provider)) {
		if (models.some((m) => m.id === cm.id)) continue;
		const tpl = models.find((m) => m.id === cm.template) ?? models[models.length - 1];
		if (!tpl) continue;
		models.push({
			...tpl,
			id: cm.id,
			name: cm.name ?? cm.id,
			contextWindow: cm.contextWindow ?? tpl.contextWindow,
			maxTokens: cm.maxTokens ?? tpl.maxTokens,
			reasoning: cm.reasoning ?? tpl.reasoning,
			cost: { ...tpl.cost, ...(cm.cost ?? {}) },
		});
	}
	const creds = getOAuthCredentials(provider);
	const oauth = creds && getOAuthProvider(provider);
	if (oauth && oauth.modifyModels) models = oauth.modifyModels(models, creds);
	if (provider === "openrouter") {
		const r = s.providers.openRouterRouting;
		if (r.sort || r.dataCollection || r.zdr) {
			models = models.map((m) => ({
				...m,
				compat: { ...(m as any).compat, openRouterRouting: { sort: r.sort, data_collection: r.dataCollection, zdr: r.zdr } },
			})) as Model<Api>[];
		}
	}
	return models;
}

/** Models from connected providers only (what the pickers show). */
export function availableModels(): Model<Api>[] {
	const s = loadSettings();
	const enabled = new Set(s.providers.enabled);
	return listProviders()
		.filter((p) => p.connected && (enabled.size === 0 || enabled.has(p.id)))
		.flatMap((p) => modelsFor(p.id));
}

export function modelKey(m: Pick<Model<Api>, "provider" | "id">): string {
	return `${m.provider}/${m.id}`;
}

/** Resolve "provider/model" (or a bare/fuzzy model id) into a Model. */
export function resolveModel(ref: string): Model<Api> | undefined {
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const provider = ref.slice(0, slash);
		const id = ref.slice(slash + 1);
		const list = modelsFor(provider);
		const hit = list.find((m) => m.id === id);
		if (hit) return hit;
	}
	const q = ref.toLowerCase();
	const pool = availableModels();
	return pool.find((m) => m.id.toLowerCase() === q) ?? pool.find((m) => modelKey(m).toLowerCase().includes(q));
}

/** Fetch model ids from a local OpenAI-compatible server (Ollama, LM Studio). */
export async function discoverLocalModels(baseUrl: string): Promise<string[]> {
	const res = await fetch(baseUrl.replace(/\/$/, "") + "/models", { signal: AbortSignal.timeout(4000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const json: any = await res.json();
	return (json.data ?? json.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
}

/** Ask a provider for its current model list (cached 6h; force = refresh now). */
export async function refreshModels(provider: string, force = false): Promise<{ models: Model<Api>[]; error?: string; fetchedAt?: number; live: boolean }> {
	const cp = loadSettings().providers.custom.find((p) => p.id === provider);
	const entry = await refreshProviderModels(provider, cp?.baseUrl ?? catalogBaseUrl(provider), force);
	return { models: modelsFor(provider), error: entry?.error, fetchedAt: entry?.fetchedAt, live: !!entry && !entry.error };
}

/** Refresh every connected provider in the background (server start). */
export async function refreshConnectedModels(): Promise<void> {
	await Promise.all(listProviders().filter((p) => p.connected).map((p) => refreshModels(p.id).catch(() => undefined)));
}
