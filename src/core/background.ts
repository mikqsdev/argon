// Background shell processes started by the agent (dev servers, watchers…), tracked per session.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { shell } from "./tools/util.js";

export interface BackgroundInfo {
	id: string;
	command: string;
	description?: string;
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	status: "running" | "exited" | "killed";
	/** Last lines of output (for previews). */
	tail: string;
}

interface Entry extends BackgroundInfo {
	child?: ChildProcess;
	output: string;
	readOffset: number;
}

const MAX = 400_000;

export class BackgroundManager {
	private entries = new Map<string, Entry>();
	constructor(private cwd: string, private onChange: () => void) {}

	start(command: string, description?: string): BackgroundInfo {
		const sh = shell();
		const child = spawn(sh.file, sh.args(command), {
			cwd: this.cwd,
			env: { ...process.env, ARGON: "1", FORCE_COLOR: "0" },
			windowsHide: true,
		});
		const e: Entry = { id: randomUUID().slice(0, 6), command, description, pid: child.pid, startedAt: Date.now(), status: "running", tail: "", child, output: "", readOffset: 0 };
		const onData = (d: Buffer) => {
			e.output += d.toString();
			if (e.output.length > MAX) {
				const cut = e.output.length - MAX;
				e.output = e.output.slice(cut);
				e.readOffset = Math.max(0, e.readOffset - cut);
			}
			e.tail = e.output.split(/\r?\n/).slice(-6).join("\n");
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("close", (code) => {
			if (e.status === "running") e.status = "exited";
			e.exitCode = code;
			e.endedAt = Date.now();
			e.child = undefined;
			this.onChange();
		});
		child.on("error", (err) => {
			e.output += `\n${err.message}`;
		});
		this.entries.set(e.id, e);
		this.onChange();
		return this.info(e);
	}

	private info(e: Entry): BackgroundInfo {
		const { child: _c, output: _o, readOffset: _r, ...rest } = e;
		return { ...rest };
	}

	list(): BackgroundInfo[] {
		return [...this.entries.values()].map((e) => this.info(e));
	}

	running(): number {
		return [...this.entries.values()].filter((e) => e.status === "running").length;
	}

	/** New output since the last read (for the agent), or the full output. */
	read(id: string, all = false): { info: BackgroundInfo; output: string } {
		const e = this.entries.get(id);
		if (!e) throw new Error(`No background process "${id}"`);
		const out = all ? e.output : e.output.slice(e.readOffset);
		e.readOffset = e.output.length;
		return { info: this.info(e), output: out };
	}

	kill(id: string): boolean {
		const e = this.entries.get(id);
		if (!e || !e.child) return false;
		e.status = "killed";
		try {
			if (process.platform === "win32" && e.child.pid) spawn("taskkill", ["/pid", String(e.child.pid), "/t", "/f"], { windowsHide: true });
			else e.child.kill("SIGTERM");
		} catch {
			/* already gone */
		}
		this.onChange();
		return true;
	}

	killAll(): void {
		for (const e of this.entries.values()) if (e.child) this.kill(e.id);
	}
}
