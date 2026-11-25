import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { completeSimple, type Api, type ImageContent, type Message, type Model } from "@mariozechner/pi-ai";
import { loadSettings, saveSettings, type Effort, type PermissionMode, type Settings } from "./config.js";
import { resolveApiKey } from "./auth.js";
import { modelKey, resolveModel } from "./providers.js";
import { newSessionData, saveSession, loadSession, type SessionData, type TodoItem } from "./sessions.js";
import { findPrUrl } from "./github.js";
import { buildSystemPrompt } from "./prompt.js";
import { applyEffort, resolveEffort, adaptiveThinkingPatch } from "./effort.js";
import { findAgent, listAgents } from "./agents.js";
import { decide, describeCall, suggestRule, outsideRule, READ_ONLY_TOOLS } from "./permissions.js";
import { dirname } from "node:path";
import { runHooks } from "./hooks.js";
import { limitStatus, recordLlmUsage, recordPrompt, type LimitStatus } from "./usage.js";
import { mcpTools } from "./mcp.js";
import { controlAgentTools } from "./control.js";
import { findSkill, listCommands, expandCommand } from "./skills.js";
import type { ToolContext } from "./tools/util.js";
import { readTool, writeTool, editTool, lsTool, globTool, grepTool } from "./tools/files.js";
import { bashTool, bashOutputTool, killBashTool } from "./tools/bash.js";
import { BackgroundManager, type BackgroundInfo } from "./background.js";
import { webFetchTool, webSearchTool } from "./tools/web.js";
import { todoTool, memoryTool, skillTool, taskTool, askUserTool } from "./tools/agentic.js";

export type ApprovalChoice = "allow" | "always" | "deny";

export type ArgonEvent =
	| AgentEvent
	| { type: "approval_request"; id: string; tool: string; args: any; call: string; suggestion: string; outside?: string[]; envName?: string }
	| { type: "approval_resolved"; id: string; choice: ApprovalChoice }
	| { type: "question"; id: string; question: string; options: string[] }
	| { type: "question_resolved"; id: string; answer: string }
	| { type: "todos"; todos: TodoItem[] }
	| { type: "status"; status: "idle" | "running" | "compacting" }
	| { type: "limits"; limits: LimitStatus }
	| { type: "notice"; level: "info" | "warn" | "error"; text: string }
	| { type: "background"; processes: BackgroundInfo[] }
	| { type: "meta"; meta: SessionData["meta"] }
	| { type: "queue"; queue: QueuedView[]; sent?: QueuedView }
	| { type: "btw"; btw: SideAnswer }
	| { type: "btw_dismiss"; id: string }
	| {
			type: "subagent";
			toolCallId: string;
			agent: string;
			phase: "start" | "step" | "step_end" | "end";
			tool?: string;
			text?: string;
			isError?: boolean;
			steps?: number;
			tokens?: number;
			model?: string;
			color?: string;
	  };

/** A message the user queued while the agent works: it is sent when the run ends. */
export interface QueuedMessage {
	id: string;
	text: string;
	images: ImageContent[];
	at: number;
}
/** What clients see of a queued message (images are only counted). */
export interface QueuedView {
	id: string;
	text: string;
	images: number;
	at: number;
}
/** A /btw side question, answered by a read-only sub-agent without touching the main conversation. */
export interface SideAnswer {
	id: string;
	question: string;
	status: "running" | "done" | "error";
	text: string;
	steps: number;
	tool?: string;
	error?: string;
	model?: string;
	at: number;
}

const BTW_PROMPT = `

# Side question (/btw)
The user asked a quick side question while the main agent keeps working. The conversation so far is inside <conversation>; it may stop mid-step.
- Answer the question directly and concisely, in the user's language. Use Markdown.
- You may use read-only tools to check facts. You cannot change anything, and you don't continue or plan the main task (ignore the plan-mode note above).
- Your answer is shown only to the user. It is not added to the main conversation and the main agent never sees it.`;

export interface SessionOptions {
	cwd: string;
	envId?: string | null;
	model?: string;
	effort?: Effort;
	mode?: PermissionMode;
	resumeId?: string;
	/** Whether a human can answer approval prompts/questions. Headless runs auto-deny "ask". */
	interactive?: boolean;
	/** Which interface started the session. */
	origin?: "cli" | "gui";
}

export class ArgonSession {
	data: SessionData;
	agent: Agent;
	model: Model<Api>;
	status: "idle" | "running" | "compacting" = "idle";
	private listeners = new Set<(e: ArgonEvent) => void>();
	private approvals = new Map<string, (c: ApprovalChoice) => void>();
	private questions = new Map<string, (a: string) => void>();
	private sessionAllow: string[] = [];
	private checkpoints: { turn: number; files: Map<string, string | null> }[] = [];
	private turn = 0;
	private limitStopped = false;
	pendingApprovals: Extract<ArgonEvent, { type: "approval_request" }>[] = [];
	pendingQuestions: Extract<ArgonEvent, { type: "question" }>[] = [];
	interactive: boolean;
	/** Background shell processes started by the agent in this session. */
	background: BackgroundManager;
	/** Messages queued with Ctrl+Enter: sent one at a time when a run ends (paused after a stop or an error). */
	queue: QueuedMessage[] = [];
	/** Recent /btw side answers (kept in memory only). */
	btws: SideAnswer[] = [];
	private btwStop = new Map<string, () => void>();
	/** The user stopped the last run: don't drain the queue on its own. */
	private stopped = false;
	/** prompt() is starting a run (hooks, auto-compaction) but the status isn't "running" yet. */
	private launching = false;

	get id(): string {
		return this.data.meta.id;
	}
	get settings(): Settings {
		return loadSettings();
	}

	private constructor(data: SessionData, model: Model<Api>, interactive: boolean) {
		this.data = data;
		this.model = model;
		this.interactive = interactive;
		this.background = new BackgroundManager(data.meta.cwd, () => this.emit({ type: "background", processes: this.background.list() }));
		this.agent = new Agent({
			initialState: {
				model,
				thinkingLevel: this.effectiveEffort(data.meta.effort),
				messages: data.messages,
				systemPrompt: "",
				tools: [],
			},
			convertToLlm: (msgs) => msgs.filter((m: any) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[],
			getApiKey: (provider) => this.apiKey(provider),
			beforeToolCall: (c) => this.gate(c.toolCall.name, c.args),
			afterToolCall: async (c) => {
				if (this.settings.hooks.some((h) => h.event === "postToolUse")) {
					const r = await runHooks(this.settings, "postToolUse", { tool: c.toolCall.name, args: c.args, isError: c.isError }, this.cwd);
					if (r.output) return { content: [...c.result.content, { type: "text", text: `\n[hook] ${r.output}` }] };
				}
				return undefined;
			},
			sessionId: data.meta.id,
			toolExecution: "parallel",
		});
		this.agent.subscribe((e) => this.onAgentEvent(e));
	}

	static async create(opts: SessionOptions): Promise<ArgonSession> {
		const s = loadSettings();
		let data: SessionData | undefined;
		if (opts.resumeId) {
			data = loadSession(opts.resumeId);
			if (!data) throw new Error(`Session ${opts.resumeId} not found`);
		}
		const env = s.environments.find((e) => e.id === (data?.meta.envId ?? opts.envId));
		const modelRef = opts.model ?? data?.meta.model ?? env?.model ?? s.model.default;
		const model = resolveModel(modelRef);
		if (!model) throw new Error(`Model "${modelRef}" not found. Connect a provider (argon login) or pick another model.`);
		data ??= newSessionData({
			envId: opts.envId ?? env?.id ?? null,
			cwd: opts.cwd,
			model: modelKey(model),
			effort: opts.effort ?? s.model.effort,
			mode: opts.mode ?? env?.permissionMode ?? s.permissions.mode,
			origin: opts.origin ?? "gui",
		});
		if (opts.effort) data.meta.effort = opts.effort;
		if (opts.mode) data.meta.mode = opts.mode;
		data.meta.model = modelKey(model);
		const session = new ArgonSession(data, model, opts.interactive ?? true);
		session.refresh();
		if (!opts.resumeId && s.hooks.some((h) => h.event === "sessionStart")) {
			await runHooks(s, "sessionStart", { sessionId: data.meta.id, cwd: data.meta.cwd }, data.meta.cwd);
		}
		return session;
	}

	private L(it: string, en: string): string {
		return this.settings.general.language === "it" ? it : en;
	}

	private async apiKey(provider: string): Promise<string | undefined> {
		const custom = this.settings.providers.custom.find((p) => p.id === provider);
		if (custom?.noAuth) return (await resolveApiKey(provider).catch(() => undefined)) ?? "local";
		try {
			return await resolveApiKey(provider);
		} catch (e) {
			this.emit({ type: "notice", level: "error", text: `Credentials for ${provider}: ${(e as Error).message}` });
			return undefined;
		}
	}

	get cwd(): string {
		return this.data.meta.cwd;
	}

	subscribe(fn: (e: ArgonEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(e: ArgonEvent): void {
		for (const l of this.listeners) {
			try {
				l(e);
			} catch {
				/* listener errors must not break the agent */
			}
		}
	}

	private setStatus(s: "idle" | "running" | "compacting") {
		this.status = s;
		this.emit({ type: "status", status: s });
	}

	private effectiveEffort(e: Effort): any {
		return this.model ? applyEffort(this.model, e).level : "off";
	}

	/** Effort actually used with the current model (clamped to its provider profile). */
	get effort(): string {
		return resolveEffort(this.model, this.data.meta.effort);
	}

	// ───────────────────────── tools & prompt ─────────────────────────

	private toolContext(): ToolContext {
		return {
			cwd: this.cwd,
			settings: () => loadSettings(),
			sessionId: this.id,
			checkpoint: (p) => this.checkpoint(p),
			setTodos: (todos) => {
				this.data.todos = todos;
				this.emit({ type: "todos", todos });
			},
			askUser: (q, o) => this.ask(q, o),
			runSubagent: (prompt, o) => this.runSubagent(prompt, o),
			agents: () => listAgents(this.cwd, this.settings).map((a) => ({ name: a.name, description: a.description })),
			background: this.background,
		};
	}

	buildTools(readOnly = false, forSubagent = false): AgentTool<any>[] {
		const ctx = this.toolContext();
		const s = this.settings;
		let tools: AgentTool<any>[] = [
			readTool(ctx),
			writeTool(ctx),
			editTool(ctx),
			bashTool(ctx),
			bashOutputTool(ctx),
			killBashTool(ctx),
			lsTool(ctx),
			globTool(ctx),
			grepTool(ctx),
			webFetchTool(ctx),
			webSearchTool(ctx),
			todoTool(ctx),
			memoryTool(ctx),
			skillTool(ctx),
			...(forSubagent ? [] : [taskTool(ctx), askUserTool(ctx)]),
			...mcpTools(),
			// The built-in "Argon" connector: tools to operate Argon itself (only with AI agent control on).
			...(forSubagent ? [] : controlAgentTools()),
		];
		tools = tools.filter((t) => !s.tools.disabled.includes(t.name));
		if (readOnly) tools = tools.filter((t) => READ_ONLY_TOOLS.has(t.name) || t.name === "memory");
		return tools;
	}

	/** Rebuild tools and the system prompt (settings, MCP servers or mode may have changed). */
	refresh(): void {
		const tools = this.buildTools(this.data.meta.mode === "plan");
		this.agent.state.tools = tools;
		const applied = applyEffort(this.model, this.data.meta.effort);
		this.agent.state.model = applied.model;
		this.agent.state.thinkingLevel = applied.level;
		this.agent.onPayload = adaptiveThinkingPatch(applied.model, applied.effort);
		this.agent.state.systemPrompt = buildSystemPrompt({
			cwd: this.cwd,
			settings: this.settings,
			mode: this.data.meta.mode,
			modelName: `${this.model.name} (${modelKey(this.model)})`,
			summary: this.data.summary,
			toolNames: tools.map((t) => t.name),
		});
	}

	// ───────────────────────── permissions ─────────────────────────

	private async gate(tool: string, args: any): Promise<{ block?: boolean; reason?: string } | undefined> {
		const s = this.settings;
		if (s.hooks.some((h) => h.event === "preToolUse")) {
			const r = await runHooks(s, "preToolUse", { tool, args, sessionId: this.id }, this.cwd);
			if (r.blocked) return { block: true, reason: `Blocked by hook: ${r.output || "no reason given"}` };
		}
		const env = this.data.meta.envId ? s.environments.find((e) => e.id === this.data.meta.envId) : undefined;
		const d = decide(this.data.meta.mode, s, tool, args, this.sessionAllow, { root: env?.cwd, cwd: this.cwd });
		if (d.decision === "allow") return undefined;
		if (d.decision === "deny") return { block: true, reason: d.reason };
		if (!this.interactive || this.listeners.size === 0) {
			return {
				block: true,
				reason: d.outside
					? `Writing outside the environment folder (${d.outside.join(", ")}) needs user approval, and no user is available.`
					: "Needs user approval, but no user is available (non-interactive run). Use --mode auto or add an allow rule.",
			};
		}
		const id = randomUUID().slice(0, 8);
		const req = {
			type: "approval_request" as const,
			id,
			tool,
			args,
			call: describeCall(tool, args),
			suggestion: d.outside ? `outside: ${d.outside.map((p) => dirname(p)).join(", ")}` : suggestRule(tool, args),
			outside: d.outside,
			envName: env?.name,
		};
		this.pendingApprovals.push(req);
		this.emit(req);
		const choice = await new Promise<ApprovalChoice>((resolve) => {
			this.approvals.set(id, resolve);
			this.agent.signal?.addEventListener("abort", () => resolve("deny"), { once: true });
		});
		this.approvals.delete(id);
		this.pendingApprovals = this.pendingApprovals.filter((p) => p.id !== id);
		this.emit({ type: "approval_resolved", id, choice });
		if (choice === "always") {
			if (req.outside) this.sessionAllow.push(...req.outside.map(outsideRule));
			else this.sessionAllow.push(req.suggestion);
		}
		if (choice === "deny") return { block: true, reason: "The user declined this action." };
		return undefined;
	}

	respondApproval(id: string, choice: ApprovalChoice): void {
		this.approvals.get(id)?.(choice);
	}

	private async ask(question: string, options: string[]): Promise<string> {
		if (!this.interactive || this.listeners.size === 0) throw new Error("No user available to answer. Make a reasonable choice and state it.");
		const id = randomUUID().slice(0, 8);
		const ev = { type: "question" as const, id, question, options };
		this.pendingQuestions.push(ev);
		this.emit(ev);
		const answer = await new Promise<string>((resolve) => {
			this.questions.set(id, resolve);
			this.agent.signal?.addEventListener("abort", () => resolve("(no answer — the run was stopped)"), { once: true });
		});
		this.questions.delete(id);
		this.pendingQuestions = this.pendingQuestions.filter((q) => q.id !== id);
		this.emit({ type: "question_resolved", id, answer });
		return answer;
	}

	answerQuestion(id: string, answer: string): void {
		this.questions.get(id)?.(answer);
	}

	// ───────────────────────── running ─────────────────────────

	/** Expand custom /commands and /skill invocations into a prompt. Returns null if not a command. */
	expandSlash(input: string): string | null {
		const m = input.match(/^\/([\w:-]+)\s*([\s\S]*)$/);
		if (!m) return null;
		const cmd = listCommands(this.cwd, this.settings).find((c) => c.name === m[1]);
		if (cmd) return expandCommand(cmd, m[2]);
		const skill = findSkill(m[1], this.cwd, this.settings);
		if (skill) return `Use the "${skill.name}" skill (load it with the skill tool) for this request.${m[2] ? `\n\n${m[2]}` : ""}`;
		return null;
	}

	async prompt(input: string, images: ImageContent[] = []): Promise<void> {
		if (this.status !== "idle" || this.launching) {
			// Steering: deliver the message after the current turn.
			this.agent.steer({ role: "user", content: images.length ? [{ type: "text", text: input }, ...images] : input, timestamp: Date.now() });
			this.emit({ type: "notice", level: "info", text: this.L("Messaggio inviato: lo leggerà dopo il passo in corso.", "Message sent: it will be read after the current step.") });
			return;
		}
		const limits = limitStatus();
		this.emit({ type: "limits", limits });
		if (limits.blockedReason) {
			this.emit({ type: "notice", level: "error", text: limits.blockedReason });
			return;
		}
		this.launching = true;
		this.stopped = false;
		let ok = false;
		try {
			ok = await this.run(input, images, limits);
		} finally {
			this.launching = false;
		}
		// The run ended on its own: send the next queued message. A stop or an error pauses the queue.
		const last: any = [...this.agent.state.messages].reverse().find((m: any) => m.role === "assistant");
		// (Checked again when the timer fires: a later run may have been stopped by then.)
		if (ok && !this.stopped && !this.limitStopped && last?.stopReason !== "error") setTimeout(() => !this.stopped && this.drain(), 0);
	}

	private async run(input: string, images: ImageContent[], limits: LimitStatus): Promise<boolean> {
		if (limits.warning) {
			const w = limits.fiveHour.enabled && limits.fiveHour.percent >= limits.warnAt ? "5h" : "weekly";
			this.emit({ type: "notice", level: "warn", text: this.L(`Attenzione: limite ${w === "5h" ? "delle 5 ore" : "settimanale"} al ${Math.round(w === "5h" ? limits.fiveHour.percent : limits.weekly.percent)}%.`, `Usage warning: ${w} limit at ${Math.round(w === "5h" ? limits.fiveHour.percent : limits.weekly.percent)}%.`) });
		}
		const s = this.settings;
		if (s.hooks.some((h) => h.event === "userPrompt")) {
			const r = await runHooks(s, "userPrompt", { prompt: input, sessionId: this.id }, this.cwd);
			if (r.output) input = `${input}\n\n<hook-context>\n${r.output}\n</hook-context>`;
		}
		const ctx = this.contextUsage();
		if (s.context.autoCompactAt > 0 && ctx.percent >= s.context.autoCompactAt && this.agent.state.messages.length > 4) {
			await this.compact();
		}
		this.turn++;
		this.limitStopped = false;
		this.refresh();
		recordPrompt(this.id, this.model.provider, this.model.id);
		this.setStatus("running");
		try {
			await this.agent.prompt(input, images);
			return true;
		} catch (e) {
			this.emit({ type: "notice", level: "error", text: (e as Error).message });
			return false;
		} finally {
			this.setStatus("idle");
			this.persist();
			if (s.hooks.some((h) => h.event === "stop")) runHooks(s, "stop", { sessionId: this.id }, this.cwd).catch(() => {});
			if (this.data.meta.title === "New session") void this.autoTitle(input);
		}
	}

	abort(): void {
		if (this.status !== "idle" || this.launching) this.stopped = true;
		this.agent.abort();
		for (const r of this.approvals.values()) r("deny");
	}

	// ───────────────────────── queue (Ctrl+Enter) ─────────────────────────

	private queueView(m: QueuedMessage): QueuedView {
		return { id: m.id, text: m.text, images: m.images.length, at: m.at };
	}

	get queued(): QueuedView[] {
		return this.queue.map((m) => this.queueView(m));
	}

	private emitQueue(sent?: QueuedMessage): void {
		this.emit({ type: "queue", queue: this.queued, sent: sent && this.queueView(sent) });
	}

	/** Queue a message for when the agent has finished. With nothing running it starts (or resumes) the queue. */
	enqueue(text: string, images: ImageContent[] = []): QueuedView {
		const m: QueuedMessage = { id: randomUUID().slice(0, 8), text, images, at: Date.now() };
		this.queue.push(m);
		this.emitQueue();
		this.drain();
		return this.queueView(m);
	}

	/** Remove a queued message (returns it with its images, e.g. to put it back in the composer). */
	unqueue(id: string): QueuedMessage | undefined {
		const m = this.queue.find((x) => x.id === id);
		if (!m) return undefined;
		this.queue = this.queue.filter((x) => x.id !== id);
		this.emitQueue();
		return m;
	}

	/** Send one queued message right away: steering if a run is going, a new run otherwise. */
	sendQueued(id: string): void {
		const m = this.queue.find((x) => x.id === id);
		if (!m) return;
		this.queue = this.queue.filter((x) => x.id !== id);
		this.emitQueue(m);
		void this.prompt(m.text, m.images);
	}

	private drain(): void {
		if (this.status !== "idle" || this.launching || !this.queue.length) return;
		const m = this.queue.shift()!;
		this.emitQueue(m);
		void this.prompt(m.text, m.images);
	}

	// ───────────────────────── /btw side questions ─────────────────────────

	/** The conversation as plain text (for compaction and side questions), newest part kept. */
	private transcript(max: number, withStreaming = false): string {
		const msgs = [...(this.agent.state.messages as any[])];
		const live: any = withStreaming ? this.agent.state.streamingMessage : undefined;
		if (live?.role === "assistant" && live.content?.length) msgs.push(live);
		return msgs
			.map((m) => {
				if (m.role === "user") return `USER: ${typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "[image]").join(" ")}`;
				if (m.role === "assistant")
					return `ASSISTANT: ${(m.content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[tool ${c.name} ${JSON.stringify(c.arguments ?? {}).slice(0, 300)}]` : "")).join(" ")}`;
				if (m.role === "toolResult") return `TOOL RESULT (${m.toolName}): ${m.content.map((c: any) => c.text ?? "").join(" ").slice(0, 800)}`;
				return "";
			})
			.join("\n")
			.slice(-max);
	}

	/** Answer a side question with a read-only sub-agent while the main agent keeps working. */
	btw(question: string): SideAnswer {
		const b: SideAnswer = { id: randomUUID().slice(0, 8), question, status: "running", text: "", steps: 0, at: Date.now(), model: modelKey(this.model) };
		this.btws = [...this.btws.slice(-4), b];
		this.emit({ type: "btw", btw: { ...b } });
		void this.runBtw(b);
		return b;
	}

	dismissBtw(id: string): void {
		this.btwStop.get(id)?.();
		this.btws = this.btws.filter((b) => b.id !== id);
		this.emit({ type: "btw_dismiss", id });
	}

	private async runBtw(b: SideAnswer): Promise<void> {
		const st = this.settings;
		const model = this.model;
		const applied = applyEffort(model, "low");
		// Read-only, and nothing that touches the main session (its todo list, memory, sub-agents, questions).
		const tools = this.buildTools(true, true).filter((t) => t.name !== "todo" && t.name !== "memory");
		const sub = new Agent({
			initialState: {
				model: applied.model,
				thinkingLevel: applied.level,
				tools,
				systemPrompt: buildSystemPrompt({ cwd: this.cwd, settings: st, mode: "plan", modelName: model.name, toolNames: tools.map((t) => t.name) }).concat(BTW_PROMPT),
			},
			getApiKey: (p) => this.apiKey(p),
			beforeToolCall: (c) => this.gate(c.toolCall.name, c.args),
			onPayload: adaptiveThinkingPatch(applied.model, applied.effort),
			sessionId: `${this.id}-btw`,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const push = (now = false) => {
			if (now) {
				clearTimeout(timer);
				timer = undefined;
				if (this.btws.includes(b)) this.emit({ type: "btw", btw: { ...b } });
				return;
			}
			timer ??= setTimeout(() => push(true), 60);
		};
		let current = "";
		sub.subscribe((e: any) => {
			if (e.type === "message_start" && e.message?.role === "assistant") current = "";
			if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
				current += e.assistantMessageEvent.delta;
				b.text = current;
				push();
			}
			if (e.type === "tool_execution_start") {
				b.steps++;
				b.tool = describeCall(e.toolName, e.args).slice(0, 140);
				push();
				if (b.steps >= st.agents.maxSteps) sub.abort();
			}
			if (e.type === "message_end" && e.message?.role === "assistant") {
				const m: any = e.message;
				if (m.usage) recordLlmUsage(this.id, m.provider, m.model, m.usage, "btw");
				if (m.stopReason === "error" && m.errorMessage) b.error = m.errorMessage;
			}
		});
		this.btwStop.set(b.id, () => sub.abort());
		const ask = `<conversation>\n${this.data.summary ? `Earlier summary:\n${this.data.summary}\n\n` : ""}${this.transcript(60_000, true) || "(empty)"}\n</conversation>\n\nSide question from the user: ${b.question}`;
		try {
			await sub.prompt(ask);
			const last: any = [...sub.state.messages].reverse().find((m: any) => m.role === "assistant");
			const text = last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
			if (text) b.text = text;
			b.status = b.error && !text ? "error" : "done";
		} catch (e) {
			b.error = (e as Error).message;
			b.status = "error";
		} finally {
			this.btwStop.delete(b.id);
			b.tool = undefined;
			push(true);
		}
	}

	/** Shell commands in flight, to spot pull requests the agent opens with `gh pr create`. */
	private shellCalls = new Map<string, string>();

	private notePullRequest(command: string, result: any): void {
		const text = (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
		const pr = findPrUrl(text);
		if (!pr) return;
		const prs = (this.data.meta.prs ??= []);
		if (prs.some((p) => p.url === pr.url)) return;
		const title = command.match(/--title\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/);
		prs.push({ number: pr.number, url: pr.url, title: (title?.[1] ?? title?.[2] ?? title?.[3] ?? "").replace(/\\"/g, '"'), branch: "", createdAt: Date.now() });
		this.persist();
	}

	private onAgentEvent(e: AgentEvent): void {
		if (e.type === "tool_execution_start" && e.toolName === "bash") this.shellCalls.set(e.toolCallId, String(e.args?.command ?? ""));
		if (e.type === "tool_execution_end" && e.toolName === "bash") {
			const command = this.shellCalls.get(e.toolCallId) ?? "";
			this.shellCalls.delete(e.toolCallId);
			if (!e.isError && /\bgh\s+pr\s+create\b/.test(command)) this.notePullRequest(command, e.result);
		}
		if (e.type === "message_end" && (e.message as any).role === "assistant") {
			const m: any = e.message;
			if (m.usage) recordLlmUsage(this.id, m.provider, m.model, m.usage);
			this.emit({ type: "limits", limits: limitStatus() });
			if (m.stopReason === "error" && m.errorMessage) this.emit({ type: "notice", level: "error", text: m.errorMessage });
		}
		if (e.type === "turn_end") {
			this.persist();
			const l = limitStatus();
			if (l.blockedReason && !this.limitStopped) {
				this.limitStopped = true;
				this.emit({ type: "notice", level: "error", text: l.blockedReason });
				this.agent.abort();
			}
		}
		this.emit(e);
	}

	persist(): void {
		this.data.messages = this.agent.state.messages.filter((m: any) => !(m.role === "assistant" && m.stopReason === "aborted" && !m.content?.length));
		saveSession(this.data);
		this.emit({ type: "meta", meta: this.data.meta });
	}

	// ───────────────────────── settings per session ─────────────────────────

	setModel(ref: string): Model<Api> {
		const m = resolveModel(ref);
		if (!m) throw new Error(`Model "${ref}" not found`);
		this.model = m;
		this.data.meta.model = modelKey(m);
		this.refresh();
		this.persist();
		rememberDefaults({ model: modelKey(m) });
		return m;
	}

	setEffort(e: Effort): void {
		this.data.meta.effort = e;
		this.refresh();
		this.persist();
		rememberDefaults({ effort: e });
	}

	setMode(m: PermissionMode): void {
		this.data.meta.mode = m;
		this.refresh();
		this.persist();
		rememberDefaults({ mode: m });
	}

	rename(title: string): void {
		this.data.meta.title = title;
		this.persist();
	}

	contextUsage(): { used: number; window: number; percent: number } {
		const msgs = this.agent.state.messages as any[];
		let used = 0;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const u = msgs[i].role === "assistant" ? msgs[i].usage : null;
			if (u && u.input + u.output > 0) {
				used = u.input + u.cacheRead + u.cacheWrite + u.output;
				break;
			}
		}
		const window = this.model.contextWindow || 128_000;
		return { used, window, percent: Math.min(100, (used / window) * 100) };
	}

	// ───────────────────────── compaction ─────────────────────────

	async compact(instructions = ""): Promise<void> {
		const msgs = this.agent.state.messages as any[];
		if (!msgs.length) return;
		this.setStatus("compacting");
		try {
			const transcript = this.transcript(400_000);
			const res = await completeSimple(
				this.model,
				{
					systemPrompt:
						"You compact agent conversations. Write a dense summary that lets the agent continue seamlessly: the user's goals and requests, decisions made, files touched (with paths), commands run and their outcomes, current state, open problems and next steps. Keep exact names, paths and numbers.",
					messages: [{ role: "user", content: `${this.data.summary ? `Previous summary:\n${this.data.summary}\n\n` : ""}Conversation:\n${transcript}\n\n${instructions}`, timestamp: Date.now() }],
				},
				{ apiKey: await resolveApiKey(this.model.provider), maxTokens: 4000 },
			);
			if (res.usage) recordLlmUsage(this.id, this.model.provider, this.model.id, res.usage, "compaction");
			const summary = res.content.map((c: any) => (c.type === "text" ? c.text : "")).join("").trim();
			if (!summary) throw new Error(res.errorMessage || "empty summary");
			this.data.summary = summary;
			this.agent.state.messages = [];
			this.refresh();
			this.persist();
			this.emit({ type: "notice", level: "info", text: this.L("Conversazione compattata.", "Conversation compacted.") });
		} catch (e) {
			this.emit({ type: "notice", level: "error", text: this.L(`Compattazione fallita: ${(e as Error).message}`, `Compaction failed: ${(e as Error).message}`) });
		} finally {
			this.setStatus("idle");
		}
	}

	clear(): void {
		this.agent.reset();
		this.data.summary = undefined;
		this.data.todos = [];
		this.refresh();
		this.persist();
	}

	// ───────────────────────── checkpoints / undo ─────────────────────────

	private checkpoint(path: string): void {
		if (!this.settings.tools.checkpoints) return;
		let cp = this.checkpoints[this.checkpoints.length - 1];
		if (!cp || cp.turn !== this.turn) {
			cp = { turn: this.turn, files: new Map() };
			this.checkpoints.push(cp);
		}
		if (!cp.files.has(path)) cp.files.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
	}

	/** Revert files changed in the last prompt and drop that exchange from the conversation. */
	undo(): { files: string[] } {
		const cp = this.checkpoints.pop();
		const files: string[] = [];
		if (cp) {
			for (const [p, content] of cp.files) {
				if (content === null) {
					if (existsSync(p)) unlinkSync(p);
				} else writeFileSync(p, content, "utf8");
				files.push(p);
			}
		}
		const msgs = this.agent.state.messages as any[];
		let lastUser = -1;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "user") {
				lastUser = i;
				break;
			}
		}
		if (lastUser >= 0) this.agent.state.messages = msgs.slice(0, lastUser);
		this.persist();
		return { files };
	}

	// ───────────────────────── sub-agents & titles ─────────────────────────

	private async runSubagent(prompt: string, opts: { agent?: string; readOnly?: boolean; signal?: AbortSignal; toolCallId: string }): Promise<string> {
		const st = this.settings;
		if (!st.agents.enabled) throw new Error("Sub-agents are disabled in settings");
		const def = findAgent(opts.agent ?? "general", this.cwd, st) ?? findAgent("general", this.cwd, st);
		if (!def) throw new Error(`Unknown agent "${opts.agent}". Available: ${listAgents(this.cwd, st).map((a) => a.name).join(", ")}`);
		const small = st.model.small ? resolveModel(st.model.small) : undefined;
		const model = def.model === "inherit" ? this.model : def.model === "small" ? (small ?? this.model) : (resolveModel(def.model) ?? this.model);
		const applied = applyEffort(model, def.effort ?? (def.model === "inherit" ? this.data.meta.effort : "low"));
		const readOnly = opts.readOnly || def.tools === "read-only";
		let tools = this.buildTools(readOnly, true);
		if (Array.isArray(def.tools)) tools = tools.filter((t) => (def.tools as string[]).includes(t.name) || (def.tools as string[]).some((p) => p.endsWith("*") && t.name.startsWith(p.slice(0, -1))));
		const sub = new Agent({
			initialState: {
				model: applied.model,
				thinkingLevel: applied.level,
				tools,
				systemPrompt: buildSystemPrompt({
					cwd: this.cwd,
					settings: st,
					mode: readOnly ? "plan" : this.data.meta.mode,
					modelName: model.name,
					toolNames: tools.map((t) => t.name),
				}).concat(`

# Sub-agent: ${def.name}
${def.prompt}

You are a sub-agent working for the main agent. Work autonomously; you cannot ask the user questions. End with a concise, complete report — it is the only thing the main agent sees.`),
			},
			getApiKey: (p) => resolveApiKey(p),
			beforeToolCall: (c) => this.gate(c.toolCall.name, c.args),
			onPayload: adaptiveThinkingPatch(applied.model, applied.effort),
			sessionId: `${this.id}-${def.name}`,
		});
		const id = opts.toolCallId;
		let steps = 0;
		let tokens = 0;
		this.emit({ type: "subagent", toolCallId: id, agent: def.name, phase: "start", model: modelKey(model), color: def.color });
		sub.subscribe((e) => {
			if (e.type === "tool_execution_start") {
				steps++;
				this.emit({ type: "subagent", toolCallId: id, agent: def.name, phase: "step", tool: e.toolName, text: describeCall(e.toolName, e.args).slice(e.toolName.length + 1, -1).slice(0, 140), steps });
				if (steps >= st.agents.maxSteps) sub.abort();
			}
			if (e.type === "tool_execution_end") this.emit({ type: "subagent", toolCallId: id, agent: def.name, phase: "step_end", tool: e.toolName, isError: e.isError, steps });
			if (e.type === "message_end" && (e.message as any).role === "assistant") {
				const m: any = e.message;
				if (m.usage) {
					recordLlmUsage(this.id, m.provider, m.model, m.usage, def.name);
					tokens += m.usage.totalTokens ?? 0;
				}
			}
		});
		const onAbort = () => sub.abort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await sub.prompt(prompt);
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
			this.emit({ type: "subagent", toolCallId: id, agent: def.name, phase: "end", steps, tokens });
		}
		const last: any = [...sub.state.messages].reverse().find((m: any) => m.role === "assistant");
		const report = last?.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
		return steps >= st.agents.maxSteps ? `${report}

[stopped after ${steps} steps]` : report;
	}

	private async autoTitle(input: string): Promise<void> {
		const fallback = input.replace(/\s+/g, " ").trim().slice(0, 60) || "New session";
		if (!this.settings.general.autoTitle) return this.rename(fallback);
		try {
			const small = this.settings.model.small ? resolveModel(this.settings.model.small) : undefined;
			const model = small ?? this.model;
			const res = await completeSimple(
				model,
				{
					systemPrompt: "Write a 2-6 word title for this request, in the request's language. Reply with the title only, no quotes or punctuation at the end.",
					messages: [{ role: "user", content: input.slice(0, 2000), timestamp: Date.now() }],
				},
				{ apiKey: await resolveApiKey(model.provider), maxTokens: 30 },
			);
			if (res.usage) recordLlmUsage(this.id, model.provider, model.id, res.usage, "title");
			const t = res.content.map((c: any) => (c.type === "text" ? c.text : "")).join("").trim().replace(/^["'#\s]+|["'.\s]+$/g, "");
			this.rename(t && t.length < 80 ? t : fallback);
		} catch {
			this.rename(fallback);
		}
	}
}

/**
 * The last model, effort and mode chosen (in the GUI or in the CLI) become the shared defaults,
 * so both interfaces always start from the same choice.
 */
export function rememberDefaults(p: { model?: string; effort?: Effort; mode?: PermissionMode }): void {
	const s = loadSettings();
	let changed = false;
	if (p.model && s.model.default !== p.model) {
		s.model.default = p.model;
		changed = true;
	}
	if (p.effort && s.model.effort !== p.effort) {
		s.model.effort = p.effort;
		changed = true;
	}
	if (p.mode && s.permissions.mode !== p.mode) {
		s.permissions.mode = p.mode;
		changed = true;
	}
	if (changed) saveSettings(s);
}
