import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { text, type ToolContext } from "./util.js";
import { addMemory, listMemory, removeMemory } from "../memory.js";
import { findSkill, listSkills } from "../skills.js";

export function todoTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "todo",
		label: "Tasks",
		description:
			"Maintain a visible task list for multi-step work. Send the FULL list each time. Exactly one item should be in_progress while working. Use it for tasks with 3+ steps.",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String(),
					status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
				}),
			),
		}),
		async execute(_id: string, p: any) {
			ctx.setTodos(p.todos);
			const done = p.todos.filter((t: any) => t.status === "completed").length;
			return text(`Task list updated (${done}/${p.todos.length} done).`, { todos: p.todos });
		},
	};
}

export function memoryTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "memory",
		label: "Memory",
		description:
			"Persistent memory across sessions. action=save stores a fact (user preferences, project conventions, decisions), action=list shows memories, action=delete removes one by id. scope 'global' (all projects) or 'project' (this folder). Never store secrets.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("delete")]),
			content: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
		}),
		async execute(_id: string, p: any) {
			const scope = p.scope ?? "project";
			if (p.action === "save") {
				if (!p.content) throw new Error("content is required");
				const m = addMemory(scope, ctx.cwd, p.content);
				return text(`Saved memory ${m.id} (${scope}).`, { memory: m });
			}
			if (p.action === "delete") {
				if (!p.id) throw new Error("id is required");
				return text(removeMemory(p.id, ctx.cwd) ? `Deleted ${p.id}.` : `No memory ${p.id}.`);
			}
			const all = listMemory(ctx.cwd);
			return text(all.map((m) => `[${m.id}] (${m.scope}) ${m.content}`).join("\n") || "No memories.");
		},
	};
}

export function skillTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "skill",
		label: "Skill",
		description: "Load a skill (packaged instructions for a specific kind of task) by name. Call it before doing a task that a listed skill covers, then follow its instructions.",
		parameters: Type.Object({ name: Type.String(), args: Type.Optional(Type.String()) }),
		async execute(_id: string, p: any) {
			const skill = findSkill(p.name, ctx.cwd, ctx.settings());
			if (!skill) {
				const names = listSkills(ctx.cwd, ctx.settings()).map((s) => s.name).join(", ");
				throw new Error(`Skill "${p.name}" not found. Available: ${names || "none"}`);
			}
			return text(
				`# Skill: ${skill.name}\nBase directory: ${skill.dir}\n(Relative paths in the skill refer to this folder.)\n${p.args ? `Arguments: ${p.args}\n` : ""}\n${skill.body}`,
				{ skill: skill.name },
			);
		},
	};
}

export function taskTool(ctx: ToolContext): AgentTool<any> {
	const agents = ctx.agents?.() ?? [];
	const list = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
	return {
		name: "task",
		label: "Sub-agent",
		description:
			"Delegate a self-contained task to a sub-agent that works in a fresh context and returns a concise report (only the report comes back). Give it a complete, standalone brief. Launch several in the same turn to run them in parallel.\n\nAvailable agents:\n" +
			(list || "- general: general-purpose agent"),
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent name from the list (default: general)" })),
			description: Type.String({ description: "3-6 word summary shown to the user" }),
			prompt: Type.String({ description: "Full standalone instructions for the sub-agent" }),
		}),
		async execute(id: string, p: any, signal) {
			if (!ctx.runSubagent) throw new Error("Sub-agents are not available here");
			const answer = await ctx.runSubagent(p.prompt, { agent: p.agent, signal, toolCallId: id });
			return text(answer || "(sub-agent returned nothing)", { description: p.description, agent: p.agent ?? "general" });
		},
	};
}

export function askUserTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "ask_user",
		label: "Question",
		description: "Ask the user a question when you are genuinely blocked on a decision only they can make. Offer 2-4 short options; the user may also answer freely.",
		parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id: string, p: any) {
			if (!ctx.askUser) throw new Error("No interactive user available; make a sensible choice and state it.");
			const answer = await ctx.askUser(p.question, p.options ?? []);
			return text(`User answered: ${answer}`, { answer });
		},
	};
}
