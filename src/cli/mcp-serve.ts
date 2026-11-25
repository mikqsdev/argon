// `argon mcp serve`: Argon as an MCP server over stdio, for MCP clients (Claude Code, Claude Desktop,
// Cursor, Codex…). Each JSON-RPC line is forwarded to the `/mcp` endpoint of the running Argon app, so
// changes show up live there; with no app running it starts its own core in this process.
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.js";

interface Target {
	base: string;
	token: string;
	close?: () => void;
}

/** The core the desktop app advertises in ~/.argon/core.json, if it answers. */
async function runningCore(): Promise<Target | undefined> {
	try {
		const file = join(paths.home, "core.json");
		if (!existsSync(file)) return undefined;
		const info = JSON.parse(readFileSync(file, "utf8"));
		const base = `http://127.0.0.1:${info.port}`;
		const r = await fetch(base + "/api/ping", { signal: AbortSignal.timeout(1500) });
		if (r.ok && (await r.text()).startsWith("argon")) return { base, token: info.token };
	} catch {
		/* not running */
	}
	return undefined;
}

async function ownCore(): Promise<Target> {
	const { startServer } = await import("../server/server.js");
	const { url, close } = await startServer({ port: 0, open: false });
	const u = new URL(url);
	return { base: u.origin, token: u.searchParams.get("t") ?? "", close };
}

/** A JSON-RPC body from a JSON or SSE response. */
function parseReply(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		const data = text
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim())
			.join("");
		try {
			return JSON.parse(data);
		} catch {
			return undefined;
		}
	}
}

export async function mcpServe(): Promise<void> {
	// stdout carries MCP messages only: anything else goes to stderr.
	console.log = console.info = console.warn = console.error;
	let target = (await runningCore()) ?? (await ownCore());
	const out = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
	const post = (line: string) =>
		fetch(target.base + "/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Argon-Token": target.token },
			body: line,
		});

	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on("line", async (line) => {
		if (!line.trim()) return;
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		}
		const isRequest = msg && msg.id !== undefined && msg.id !== null;
		let res: Response;
		try {
			res = await post(line);
		} catch {
			// The app was closed meanwhile: go on with a core of our own.
			try {
				target = await ownCore();
				res = await post(line);
			} catch (e) {
				if (isRequest) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `Argon is not reachable: ${(e as Error).message}` } });
				return;
			}
		}
		const text = await res.text();
		if (!isRequest) return; // notifications get no answer
		const reply = parseReply(text);
		if (reply?.jsonrpc) {
			if (reply.id === null || reply.id === undefined) reply.id = msg.id;
			return out(reply);
		}
		out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: text.slice(0, 500) || `HTTP ${res.status}` } });
	});
	rl.on("close", () => {
		target.close?.();
		process.exit(0);
	});
}
