import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { loadSettings, type McpServerConfig } from "./config.js";

export interface McpServerStatus {
	name: string;
	status: "disabled" | "connecting" | "connected" | "error";
	error?: string;
	tools: { name: string; description: string }[];
	transport: string;
}

interface Conn {
	name: string;
	config: McpServerConfig;
	client?: Client;
	status: McpServerStatus["status"];
	error?: string;
	tools: { name: string; description: string; inputSchema: any }[];
	connecting?: Promise<void>;
}

const conns = new Map<string, Conn>();

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
export const mcpToolName = (server: string, tool: string) => `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);

function transportType(c: McpServerConfig): "stdio" | "http" | "sse" {
	return c.type ?? (c.url ? (c.url.endsWith("/sse") ? "sse" : "http") : "stdio");
}

async function connect(conn: Conn): Promise<void> {
	conn.status = "connecting";
	conn.error = undefined;
	const c = conn.config;
	const type = transportType(c);
	try {
		const client = new Client({ name: "argon", version: "0.1.0" });
		let transport;
		if (type === "stdio") {
			if (!c.command) throw new Error("missing command");
			transport = new StdioClientTransport({
				command: c.command,
				args: c.args ?? [],
				env: { ...getDefaultEnvironment(), ...(c.env ?? {}) },
				cwd: c.cwd,
				stderr: "ignore",
			});
		} else if (type === "sse") {
			transport = new SSEClientTransport(new URL(c.url!), { requestInit: { headers: c.headers } });
		} else {
			transport = new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers: c.headers } });
		}
		await Promise.race([
			client.connect(transport),
			new Promise((_r, rej) => setTimeout(() => rej(new Error("connection timed out (30s)")), 30_000)),
		]);
		const list = await client.listTools();
		conn.tools = list.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
		conn.client = client;
		conn.status = "connected";
	} catch (e) {
		conn.status = "error";
		conn.error = (e as Error).message;
	}
}

/** Connect to all enabled servers in settings (idempotent). Disconnects removed ones. */
export async function syncMcp(): Promise<void> {
	const servers = loadSettings().mcp.servers;
	for (const [name, conn] of conns) {
		const cfg = servers[name];
		if (!cfg || cfg.enabled === false || JSON.stringify(cfg) !== JSON.stringify(conn.config)) {
			await conn.client?.close().catch(() => {});
			conns.delete(name);
		}
	}
	const jobs: Promise<void>[] = [];
	for (const [name, cfg] of Object.entries(servers)) {
		if (cfg.enabled === false || conns.has(name)) continue;
		const conn: Conn = { name, config: cfg, status: "connecting", tools: [] };
		conns.set(name, conn);
		conn.connecting = connect(conn);
		jobs.push(conn.connecting);
	}
	await Promise.all(jobs);
}

export async function reconnectMcp(name: string): Promise<void> {
	const c = conns.get(name);
	if (c) {
		await c.client?.close().catch(() => {});
		conns.delete(name);
	}
	await syncMcp();
}

export function mcpStatus(): McpServerStatus[] {
	const servers = loadSettings().mcp.servers;
	return Object.entries(servers).map(([name, cfg]) => {
		const c = conns.get(name);
		return {
			name,
			transport: transportType(cfg),
			status: cfg.enabled === false ? "disabled" : (c?.status ?? "connecting"),
			error: c?.error,
			tools: (c?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
		};
	});
}

/** Wrap every MCP tool as an Argon tool. */
export function mcpTools(): AgentTool<any>[] {
	const out: AgentTool<any>[] = [];
	for (const conn of conns.values()) {
		if (conn.status !== "connected" || !conn.client) continue;
		for (const t of conn.tools) {
			const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} };
			out.push({
				name: mcpToolName(conn.name, t.name),
				label: `${conn.name} · ${t.name}`,
				description: `[MCP ${conn.name}] ${t.description}`.slice(0, 1024),
				parameters: schema as any,
				async execute(_id, args, signal) {
					const res: any = await conn.client!.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { signal, timeout: 300_000 });
					const content: (TextContent | ImageContent)[] = [];
					for (const c of res.content ?? []) {
						if (c.type === "text") content.push({ type: "text", text: c.text });
						else if (c.type === "image") content.push({ type: "image", data: c.data, mimeType: c.mimeType });
						else if (c.type === "resource") content.push({ type: "text", text: c.resource?.text ?? JSON.stringify(c.resource) });
						else content.push({ type: "text", text: JSON.stringify(c) });
					}
					if (res.structuredContent && !content.length) content.push({ type: "text", text: JSON.stringify(res.structuredContent, null, 2) });
					if (res.isError) throw new Error(content.map((c) => (c.type === "text" ? c.text : "")).join("\n") || "MCP tool error");
					return { content: content.length ? content : [{ type: "text", text: "(no content)" }], details: { server: conn.name, tool: t.name } };
				},
			});
		}
	}
	return out;
}

export async function closeMcp(): Promise<void> {
	await Promise.all([...conns.values()].map((c) => c.client?.close().catch(() => {})));
	conns.clear();
}
