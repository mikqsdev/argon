import { spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { shell, text, truncate, type ToolContext } from "./util.js";

export function bashTool(ctx: ToolContext): AgentTool<any> {
	const sh = shell();
	return {
		name: "bash",
		label: "Shell",
		description: `Run a shell command in the working directory using ${sh.name}. Returns stdout+stderr and the exit code. Use for git, builds, tests, package managers. Avoid interactive commands. Set background=true for servers/watchers (output not awaited).`,
		parameters: Type.Object({
			command: Type.String(),
			description: Type.Optional(Type.String({ description: "Short description of what the command does (shown to the user)" })),
			timeout_ms: Type.Optional(Type.Number()),
			background: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		async execute(_id: string, p: any, signal, onUpdate) {
			const s = ctx.settings();
			const timeout = Math.min(p.timeout_ms ?? s.tools.bashTimeoutMs, 600_000);
			if (p.background) {
				if (!ctx.background) throw new Error("Background processes are not available here");
				const bg = ctx.background.start(p.command, p.description);
				return text(`Started in background as "${bg.id}" (pid ${bg.pid}). Read its output with bash_output("${bg.id}"), stop it with kill_bash("${bg.id}").`, { background: true, id: bg.id, pid: bg.pid });
			}
			const child = spawn(sh.file, sh.args(p.command), {
				cwd: ctx.cwd,
				env: { ...process.env, ARGON: "1", FORCE_COLOR: "0", PAGER: "cat", GIT_PAGER: "cat" },
				windowsHide: true,
			});
			let out = "";
			let lastEmit = 0;
			const onData = (d: Buffer) => {
				out += d.toString();
				const now = Date.now();
				if (onUpdate && now - lastEmit > 250) {
					lastEmit = now;
					onUpdate({ content: [{ type: "text", text: truncate(out, 4000) }], details: { partial: true } });
				}
			};
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			const kill = () => {
				try {
					if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
					else child.kill("SIGTERM");
				} catch {
					/* already dead */
				}
			};
			signal?.addEventListener("abort", kill, { once: true });
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, timeout);
			const code: number | null = await new Promise((res) => {
				child.on("close", (c) => res(c));
				child.on("error", (e) => {
					out += `\n${e.message}`;
					res(-1);
				});
			});
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			const body = truncate(out.trimEnd(), s.tools.maxOutputChars);
			const suffix = timedOut ? `\n[timed out after ${timeout} ms]` : signal?.aborted ? "\n[aborted]" : "";
			const result = `${body || "(no output)"}${suffix}\n[exit code ${code}]`;
			if (code !== 0 && !signal?.aborted) {
				// Non-zero exit is useful information, not a tool failure.
				return text(result, { exitCode: code, command: p.command });
			}
			return text(result, { exitCode: code, command: p.command });
		},
	};
}

export function bashOutputTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "bash_output",
		label: "Background output",
		description: "Read the new output (since the last read) of a background process started with bash(background=true), plus its status.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id: string, p: any) {
			if (!ctx.background) throw new Error("No background processes here");
			const r = ctx.background.read(p.id);
			const st = r.info.status === "running" ? "running" : `${r.info.status} (exit code ${r.info.exitCode ?? "?"})`;
			return text(`[${r.info.id}] ${st}
${truncate(r.output, ctx.settings().tools.maxOutputChars) || "(no new output)"}`, { id: r.info.id, status: r.info.status });
		},
	};
}

export function killBashTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "kill_bash",
		label: "Stop process",
		description: "Stop a background process started with bash(background=true).",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id: string, p: any) {
			if (!ctx.background) throw new Error("No background processes here");
			return text(ctx.background.kill(p.id) ? `Stopped ${p.id}.` : `${p.id} is not running.`, { id: p.id });
		},
	};
}
