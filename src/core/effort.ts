// Reasoning ("effort") profiles per model.
// Source of truth: what the provider says for that model (supported efforts, default, mandatory);
// fallback: pi-ai's catalog metadata.
import { getSupportedThinkingLevels, type Api, type Model } from "@mariozechner/pi-ai";

/** All effort values Argon knows, from none to maximum. */
export const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortValue = (typeof ALL_EFFORTS)[number];

type PiLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const PI_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Reasoning metadata attached to models fetched live from providers. */
export interface ReasoningMeta {
	efforts?: string[];
	defaultEffort?: string;
	reasoningMandatory?: boolean;
}

export interface EffortProfile {
	/** Selectable levels, ordered from lowest to highest. */
	levels: EffortValue[];
	default: EffortValue;
	mandatory: boolean;
	source: "provider" | "catalog";
}

const order = (e: string) => ALL_EFFORTS.indexOf(e as EffortValue);

export function effortProfile(model: Model<Api>): EffortProfile {
	const meta = model as Model<Api> & ReasoningMeta;
	if (!model.reasoning) return { levels: ["off"], default: "off", mandatory: false, source: "catalog" };
	if (meta.efforts?.length) {
		const known = ALL_EFFORTS.filter((e) => e !== "off" && meta.efforts!.includes(e));
		if (known.length) {
			const levels: EffortValue[] = meta.reasoningMandatory ? known : ["off", ...known];
			const def = (known.includes(meta.defaultEffort as EffortValue) ? meta.defaultEffort : known.includes("medium") ? "medium" : known[Math.floor(known.length / 2)]) as EffortValue;
			return { levels, default: def, mandatory: !!meta.reasoningMandatory, source: "provider" };
		}
	}
	const levels = getSupportedThinkingLevels(model) as EffortValue[];
	return { levels, default: levels.includes("medium") ? "medium" : levels[levels.length - 1], mandatory: !levels.includes("off"), source: "catalog" };
}

/** Clamp a requested effort to what the model supports (nearest level). */
export function resolveEffort(model: Model<Api>, requested: string): EffortValue {
	const p = effortProfile(model);
	if (p.levels.includes(requested as EffortValue)) return requested as EffortValue;
	if (requested === "off" || order(requested) < 0) return p.default;
	let best = p.default;
	let dist = Infinity;
	for (const l of p.levels) {
		if (l === "off") continue;
		const d = Math.abs(order(l) - order(requested));
		if (d < dist) {
			dist = d;
			best = l;
		}
	}
	return best;
}

/**
 * Turn an Argon effort into what pi-ai needs: a pi thinking level plus a model whose
 * thinkingLevelMap sends the provider's exact value (e.g. "max", which pi has no level for).
 */
export function applyEffort(model: Model<Api>, requested: string): { model: Model<Api>; level: PiLevel; effort: EffortValue } {
	const effort = resolveEffort(model, requested);
	if (effort === "off") return { model, level: "off", effort };
	const level: PiLevel = PI_LEVELS.has(effort) ? (effort as PiLevel) : "xhigh";
	const fromProvider = effortProfile(model).source === "provider";
	if (!fromProvider && effort !== "max") return { model, level, effort };
	return { model: { ...model, thinkingLevelMap: { ...(model.thinkingLevelMap ?? {}), [level]: effort } }, level, effort };
}

/** Newer Claude families use adaptive thinking + effort instead of token budgets. */
export function claudeUsesAdaptiveThinking(id: string): boolean {
	const m = id.match(/claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/i);
	if (!m) return /claude-(fable|mythos)/i.test(id);
	const major = Number(m[1]);
	const minor = Number(m[2] ?? 0);
	return major >= 5 || (major === 4 && minor >= 6 && minor < 100);
}

/**
 * Payload hook for Anthropic models that pi-ai doesn't know are adaptive yet:
 * swaps budget thinking for adaptive thinking with the chosen effort.
 */
export function adaptiveThinkingPatch(model: Model<Api>, effort: EffortValue) {
	return (payload: any) => {
		if (model.api !== "anthropic-messages" || !claudeUsesAdaptiveThinking(model.id)) return undefined;
		if (!payload?.thinking || payload.thinking.type !== "enabled") return undefined;
		const { display } = payload.thinking;
		payload.thinking = { type: "adaptive", ...(display ? { display } : {}) };
		payload.output_config = { ...(payload.output_config ?? {}), effort: effort === "minimal" ? "low" : effort };
		return payload;
	};
}

/** Find a list of effort names anywhere in a provider's model object (schemas differ per provider). */
export function findEfforts(obj: unknown, depth = 0): string[] | undefined {
	if (!obj || typeof obj !== "object" || depth > 4) return undefined;
	if (Array.isArray(obj)) {
		if (obj.length && obj.every((x) => typeof x === "string") && obj.filter((x) => ALL_EFFORTS.includes(x as EffortValue)).length >= 2) return obj as string[];
		return undefined;
	}
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		if (/effort|reasoning|thinking/i.test(k) || depth > 0) {
			const r = findEfforts(v, depth + 1);
			if (r) return r;
		}
	}
	return undefined;
}
