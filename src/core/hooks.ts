import { spawn } from "node:child_process";
import type { HookConfig, Settings } from "./config.js";
import { shell } from "./tools/util.js";

export interface HookResult {
	blocked: boolean;
	output: string;
}

/**
 * Run user hooks for an event. The payload is passed as JSON on stdin and in ARGON_HOOK_PAYLOAD.
 * For preToolUse, exit code 2 blocks the tool call (stdout/stderr becomes the reason).
 */
export async function runHooks(s: Settings, event: HookConfig["event"], payload: Record<string, unknown>, cwd: string): Promise<HookResult> {
	const hooks = s.hooks.filter((h) => h.event === event && (!h.matcher || !payload.tool || new RegExp(h.matcher).test(String(payload.tool))));
	let blocked = false;
	const outputs: string[] = [];
	for (const h of hooks) {
		const sh = shell();
		const json = JSON.stringify({ event, ...payload });
		const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
			const child = spawn(sh.file, sh.args(h.command), { cwd, env: { ...process.env, ARGON_HOOK_EVENT: event, ARGON_HOOK_PAYLOAD: json }, windowsHide: true });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (out += d));
			const t = setTimeout(() => child.kill(), h.timeoutMs ?? 30_000);
			child.on("close", (code) => {
				clearTimeout(t);
				resolve({ code, out });
			});
			child.on("error", (e) => resolve({ code: -1, out: e.message }));
			child.stdin.end(json);
		});
		if (res.out.trim()) outputs.push(res.out.trim());
		if (event === "preToolUse" && res.code === 2) blocked = true;
	}
	return { blocked, output: outputs.join("\n") };
}
